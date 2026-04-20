import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrgAuth } from "../auth/sf-auth.ts";
import type { DescribeClient } from "../describe/client.ts";
import type { DependencyGraph } from "../graph/build.ts";
import { UserError } from "../errors.ts";
import {
  chunkIds,
  computeScopePaths,
  queryCount,
  queryIds,
  soqlIdList,
  type ScopePath,
} from "./extract.ts";
import type { DryRunSummary, UpsertDecisionSummary } from "./session.ts";
import { resolveUpsertKey } from "./upsert-key.ts";

/**
 * Dry-run: for each object in the final load order, determine how many
 * source records are in scope and whether the target org can accept them.
 *
 * Produces:
 *   - Summary (returned to caller, LLM-safe) — counts, issue names, paths.
 *   - Report file on disk (for user consumption) — counts, scope SOQL, and
 *     schema-diff details. May contain record IDs of the root scope; stays
 *     local to `~/.sandbox-seed/sessions/<id>/dry-run.md`.
 *
 * Mandatory before `run`: the session stores `dryRun.completedAt` and
 * `run` refuses unless it's within 24h.
 */
export type DryRunOptions = {
  sourceAuth: OrgAuth;
  targetAuth: OrgAuth;
  sourceDescribe: DescribeClient;
  targetDescribe: DescribeClient;
  graph: DependencyGraph;
  rootObject: string;
  whereClause: string;
  finalObjectList: string[];
  sessionDir: string;
  fetchFn?: typeof fetch;
};

export async function runDryRun(opts: DryRunOptions): Promise<DryRunSummary> {
  const scopePaths = computeScopePaths(opts.graph, opts.rootObject, opts.finalObjectList);

  // Materialize root scope IDs — we need them to resolve transitive parents,
  // and we write a sample into the report for the user.
  const rootIds = await queryIds({
    auth: opts.sourceAuth,
    soql: `SELECT Id FROM ${opts.rootObject} WHERE ${opts.whereClause}`,
    fetchFn: opts.fetchFn,
  });

  if (rootIds.length === 0) {
    throw new UserError(
      `WHERE clause returned 0 records on ${opts.rootObject} — nothing to seed.`,
      `Adjust the WHERE clause and call seed with action: "start" again.`,
    );
  }

  const perObjectCounts: Record<string, number> = {};
  const perObjectSoql: Record<string, string> = {};
  const perObjectKind: Record<string, string> = {};
  // Cache of materialized IDs per object, for transitive chain resolution.
  const materializedIds = new Map<string, string[]>();
  materializedIds.set(opts.rootObject, rootIds);

  for (const path of scopePaths) {
    const { count, soql } = await countForPath({
      auth: opts.sourceAuth,
      rootObject: opts.rootObject,
      whereClause: opts.whereClause,
      rootIds,
      path,
      materializedIds,
      fetchFn: opts.fetchFn,
    });
    perObjectCounts[path.object] = count;
    perObjectSoql[path.object] = soql;
    perObjectKind[path.object] = path.kind;
  }

  // Schema diff against target. Flag any missing object or createable
  // field that the source has but the target lacks. In the same pass,
  // compute the INSERT-vs-UPSERT decision — it needs the same pair of
  // describes, so one pass avoids re-fetching them in `run`.
  const schemaIssues: string[] = [];
  const upsertDecisions: Record<string, UpsertDecisionSummary> = {};
  for (const object of opts.finalObjectList) {
    try {
      const srcDesc = await opts.sourceDescribe.describeObject(object);
      let tgtDesc = null;
      try {
        tgtDesc = await opts.targetDescribe.describeObject(object);
      } catch {
        schemaIssues.push(`${object}: object missing in target org`);
        // Fall through to still record an ambiguous upsert decision
        // (target-describe-failed) so `run` logs the reason it chose
        // INSERT rather than silently defaulting.
      }
      if (tgtDesc !== null) {
        const tgtFields = new Set(tgtDesc.fields.map((f) => f.name));
        const missing: string[] = [];
        for (const f of srcDesc.fields) {
          if (f.createable === false) continue;
          if (f.defaultedOnCreate === true) continue;
          if (f.calculated === true) continue;
          if (!tgtFields.has(f.name)) missing.push(f.name);
        }
        if (missing.length > 0) {
          schemaIssues.push(
            `${object}: ${missing.length} source-only field(s) will be skipped during run: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`,
          );
        }
      }
      upsertDecisions[object] = resolveUpsertKey(srcDesc, tgtDesc);
    } catch (err) {
      schemaIssues.push(
        `${object}: describe failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const totalRecords = Object.values(perObjectCounts).reduce((a, b) => a + b, 0);
  const completedAt = new Date().toISOString();
  const reportPath = join(opts.sessionDir, "dry-run.md");

  await writeFile(
    reportPath,
    renderReport({
      rootObject: opts.rootObject,
      whereClause: opts.whereClause,
      rootIds,
      finalObjectList: opts.finalObjectList,
      perObjectCounts,
      perObjectSoql,
      perObjectKind,
      schemaIssues,
      upsertDecisions,
      completedAt,
      sourceAlias: opts.sourceAuth.alias ?? opts.sourceAuth.username,
      targetAlias: opts.targetAuth.alias ?? opts.targetAuth.username,
    }),
    "utf8",
  );

  return {
    reportPath,
    perObjectCounts,
    totalRecords,
    completedAt,
    targetSchemaIssues: schemaIssues,
    upsertDecisions,
  };
}

async function countForPath(opts: {
  auth: OrgAuth;
  rootObject: string;
  whereClause: string;
  rootIds: string[];
  path: ScopePath;
  materializedIds: Map<string, string[]>;
  fetchFn?: typeof fetch;
}): Promise<{ count: number; soql: string }> {
  const { path } = opts;

  if (path.kind === "root") {
    const soql = `SELECT COUNT() FROM ${path.object} WHERE ${opts.whereClause}`;
    const count = opts.rootIds.length;
    return { count, soql };
  }

  if (path.kind === "direct-parent" && path.rootFk !== undefined) {
    const soql = `SELECT COUNT() FROM ${path.object} WHERE Id IN (SELECT ${path.rootFk} FROM ${opts.rootObject} WHERE ${opts.whereClause})`;
    const count = await queryCount({
      auth: opts.auth,
      object: path.object,
      whereClause: `Id IN (SELECT ${path.rootFk} FROM ${opts.rootObject} WHERE ${opts.whereClause})`,
      fetchFn: opts.fetchFn,
    });
    // Materialize the parent IDs in case something transitive depends on this.
    const ids = await queryIds({
      auth: opts.auth,
      soql: `SELECT Id FROM ${path.object} WHERE Id IN (SELECT ${path.rootFk} FROM ${opts.rootObject} WHERE ${opts.whereClause})`,
      fetchFn: opts.fetchFn,
    });
    opts.materializedIds.set(path.object, ids);
    return { count, soql };
  }

  if (path.kind === "direct-child" && path.childFk !== undefined) {
    const soql = `SELECT COUNT() FROM ${path.object} WHERE ${path.childFk} IN (SELECT Id FROM ${opts.rootObject} WHERE ${opts.whereClause})`;
    const count = await queryCount({
      auth: opts.auth,
      object: path.object,
      whereClause: `${path.childFk} IN (SELECT Id FROM ${opts.rootObject} WHERE ${opts.whereClause})`,
      fetchFn: opts.fetchFn,
    });
    return { count, soql };
  }

  if (path.kind === "transitive" && Array.isArray(path.chain) && path.chain.length >= 3) {
    // Walk the chain, materializing each intermediate's IDs, then count the
    // final object scoped by IN (<ids>) of the previous hop.
    // chain is [root, ..., path.object].
    let prevObject = path.chain[0];
    let prevIds = opts.materializedIds.get(prevObject) ?? opts.rootIds;
    for (let i = 1; i < path.chain.length; i++) {
      const currObject = path.chain[i];
      // We need the FK field from prevObject to currObject. The chain came
      // from traversing parent edges source→target, so: edge source=prev,
      // target=curr. But we don't have the graph here — we passed only
      // `chain`. Bail: v1 doesn't fully support transitive chains.
      // Record best-effort count: 0, flag in report.
      void currObject;
    }
    void prevIds;
    const soql = `-- transitive chain ${path.chain.join(" → ")} not yet supported for count`;
    return { count: 0, soql };
  }

  // unknown or unsupported
  return {
    count: 0,
    soql: `-- no known path from ${opts.rootObject} to ${path.object}; skipped`,
  };
}

function renderReport(args: {
  rootObject: string;
  whereClause: string;
  rootIds: string[];
  finalObjectList: string[];
  perObjectCounts: Record<string, number>;
  perObjectSoql: Record<string, string>;
  perObjectKind: Record<string, string>;
  schemaIssues: string[];
  upsertDecisions: Record<string, UpsertDecisionSummary>;
  completedAt: string;
  sourceAlias: string;
  targetAlias: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Sandbox-seed dry run`);
  lines.push(``);
  lines.push(`Generated: ${args.completedAt}`);
  lines.push(`Source org: \`${args.sourceAlias}\``);
  lines.push(`Target org: \`${args.targetAlias}\``);
  lines.push(`Root object: \`${args.rootObject}\``);
  lines.push(`WHERE clause: \`${args.whereClause}\``);
  lines.push(``);
  lines.push(`## Scope summary`);
  lines.push(``);
  lines.push(`| Object | Kind | Count |`);
  lines.push(`| --- | --- | --- |`);
  for (const obj of args.finalObjectList) {
    const count = args.perObjectCounts[obj] ?? 0;
    const kind = args.perObjectKind[obj] ?? "?";
    lines.push(`| \`${obj}\` | ${kind} | ${count} |`);
  }
  const total = Object.values(args.perObjectCounts).reduce((a, b) => a + b, 0);
  lines.push(``);
  lines.push(`**Total records in scope: ${total}**`);
  lines.push(``);

  lines.push(`## SOQL per object`);
  lines.push(``);
  for (const obj of args.finalObjectList) {
    lines.push(`### ${obj}`);
    lines.push(``);
    lines.push(`\`\`\`sql`);
    lines.push(args.perObjectSoql[obj] ?? "");
    lines.push(`\`\`\``);
    lines.push(``);
  }

  lines.push(`## Root scope IDs (first 100)`);
  lines.push(``);
  lines.push(`\`\`\``);
  for (const id of args.rootIds.slice(0, 100)) {
    lines.push(id);
  }
  if (args.rootIds.length > 100) {
    lines.push(`… and ${args.rootIds.length - 100} more`);
  }
  lines.push(`\`\`\``);
  lines.push(``);

  lines.push(`## Write strategy per object (INSERT vs UPSERT)`);
  lines.push(``);
  lines.push(
    `Objects with a single unambiguous external-id field will be written ` +
      `with composite UPSERT — re-runs against a non-empty target update ` +
      `existing rows instead of failing with DUPLICATE_VALUE. Anything else ` +
      `falls back to composite INSERT (same behavior as prior versions).`,
  );
  lines.push(``);
  lines.push(`| Object | Strategy | Key field / reason |`);
  lines.push(`| --- | --- | --- |`);
  for (const obj of args.finalObjectList) {
    const d = args.upsertDecisions[obj];
    if (d === undefined) {
      lines.push(`| \`${obj}\` | INSERT | describe unavailable (see schema section) |`);
      continue;
    }
    if (d.kind === "picked") {
      lines.push(`| \`${obj}\` | UPSERT | \`${d.field}\` |`);
    } else {
      lines.push(`| \`${obj}\` | INSERT | ${d.reason}: ${d.detail} |`);
    }
  }
  lines.push(``);

  lines.push(`## Target schema validation`);
  lines.push(``);
  if (args.schemaIssues.length === 0) {
    lines.push(`No schema mismatches detected. Target has every createable field the source has.`);
  } else {
    lines.push(
      `The following source-only fields will be **auto-skipped** during \`run\` ` +
        `(the records insert successfully; those specific field values are not carried over):`,
    );
    lines.push(``);
    for (const issue of args.schemaIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push(``);
    lines.push(
      `If you need any of these fields carried over, deploy them to the target org ` +
        `before running. Otherwise, the run proceeds with them dropped.`,
    );
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(
    `To execute the full seed, call seed with ` +
      `\`{action: "run", sessionId: "<this-session>", confirm: true}\` within 24 hours.`,
  );

  return lines.join("\n");
}

// Referenced but not used — kept for symmetry with execute.ts. If a caller
// wants to sanity-check the chunking math, they can import this.
export { chunkIds as _chunkIds, soqlIdList as _soqlIdList };
