import { UserError } from "../errors.ts";
import { type SeedArgsT, type SeedResponse, seed } from "../mcp/tools/seed.ts";
import type { MaskFieldSpec, UserMaskFields } from "../seed/mask/resolve.ts";
import type { MaskStrategy } from "../seed/mask/types.ts";

/**
 * The CLI seed orchestrator.
 *
 * Drives the SAME multi-step engine the MCP `seed` tool uses —
 * start → analyze → select → dry_run → run — in a single process, so
 * every safety gate (sandbox-only target, mandatory dry run, plan-hash
 * verification, confirm-before-run, validation-rule recovery guard)
 * applies identically to CLI seeds. There is deliberately no second
 * code path to the inserts.
 *
 * Confirmation is injected (`deps.confirm`) so the flow is testable and
 * so the oclif shell can prompt on a TTY / refuse without `--yes` in CI.
 */

export type SeedFlowOptions = {
  sourceOrg: string;
  targetOrg: string;
  object: string;
  where: string;
  limit?: number;
  sampleSize?: number;
  /** Optional parents to include at the select step (must match analyze output). */
  includeParents: string[];
  /** Optional children to include at the select step. */
  includeChildren: string[];
  includeManagedPackages: boolean;
  includeSystemChildren: boolean;
  childLookups?: Record<string, string[]>;
  disableValidationRules: boolean;
  isolateIdMap: boolean;
  upsertKeyOverrides?: Record<string, string>;
  mask: boolean;
  maskFields?: UserMaskFields;
  /** Stop after the dry run; print how to resume. */
  dryRunOnly: boolean;
};

export type ConfirmRequest = {
  totalRecords: number;
  targetOrg: string;
  reportPath: string;
  sessionId: string;
};

export type SeedFlowDeps = {
  /** The engine. Injected for tests; defaults to the real one. */
  seedFn?: (args: SeedArgsT) => Promise<SeedResponse>;
  /** Step-by-step progress lines. */
  log: (message: string) => void;
  /**
   * Asked exactly once, between dry_run and run. Return false to abort
   * (the session stays resumable). Never asked when `dryRunOnly` is set.
   */
  confirm: (req: ConfirmRequest) => Promise<boolean>;
};

export type SeedFlowResult = {
  sessionId: string;
  outcome: "ran" | "dry-run-only" | "declined";
  start: Record<string, unknown>;
  analyze: Record<string, unknown>;
  select: Record<string, unknown>;
  dryRun: Record<string, unknown>;
  run?: Record<string, unknown>;
};

export async function runSeedFlow(
  opts: SeedFlowOptions,
  deps: SeedFlowDeps,
): Promise<SeedFlowResult> {
  const seedFn = deps.seedFn ?? seed;

  const started = await seedFn({
    action: "start",
    sourceOrg: opts.sourceOrg,
    targetOrg: opts.targetOrg,
    object: opts.object,
    whereClause: opts.where,
    limit: opts.limit,
    sampleSize: opts.sampleSize,
    childLookups: opts.childLookups,
    disableValidationRulesOnRun: opts.disableValidationRules ? true : undefined,
    isolateIdMap: opts.isolateIdMap ? true : undefined,
    upsertKeyOverrides: opts.upsertKeyOverrides,
    mask: opts.mask ? true : undefined,
    maskFields: opts.maskFields,
  });
  const sessionId = started.sessionId;
  deps.log(
    `start     session ${sessionId} — ${fmtNum(started.summary.matchedCount)} matched, ` +
      `scope ${fmtNum(started.summary.scopeCount)}${started.summary.sampleApplied === true ? " (sampled)" : ""}`,
  );

  const analyzed = await seedFn({
    action: "analyze",
    sessionId,
    includeManagedPackages: opts.includeManagedPackages ? true : undefined,
    includeSystemChildren: opts.includeSystemChildren ? true : undefined,
  });
  const mustInclude = (analyzed.summary.mustIncludeParents as string[] | undefined) ?? [];
  const optionalParents = (analyzed.summary.optionalParents as string[] | undefined) ?? [];
  const optionalChildren = (analyzed.summary.optionalChildren as string[] | undefined) ?? [];
  deps.log(
    `analyze   must-include: ${listOrNone(mustInclude)} · ` +
      `optional parents: ${optionalParents.length} · optional children: ${optionalChildren.length} · ` +
      `cycles: ${fmtNum(analyzed.summary.cycleCount)}`,
  );

  const selected = await seedFn({
    action: "select",
    sessionId,
    includeOptionalParents: opts.includeParents,
    includeOptionalChildren: opts.includeChildren,
  });
  const loadOrder = (selected.summary.finalLoadOrder as string[] | undefined) ?? [];
  deps.log(`select    load order: ${loadOrder.join(" → ")}`);

  const dryRun = await seedFn({ action: "dry_run", sessionId });
  const totalRecords = numberOr0(dryRun.summary.totalRecords);
  const reportPath = String(dryRun.summary.reportPath ?? "");
  deps.log(
    `dry run   ${fmtNum(totalRecords)} record(s) · ` +
      `${fmtNum(dryRun.summary.upsertObjectCount)} UPSERT / ${fmtNum(dryRun.summary.insertObjectCount)} INSERT object(s) · ` +
      `${fmtNum(dryRun.summary.schemaWarningCount)} schema warning(s)`,
  );
  if (dryRun.summary.maskedFieldCount !== undefined) {
    deps.log(
      `masking   ${fmtNum(dryRun.summary.maskedFieldCount)} field(s) will mask — names in report`,
    );
  }
  if (numberOr0(dryRun.summary.defaultedOwnerRefCount) > 0) {
    deps.log(
      `owners    ${fmtNum(dryRun.summary.defaultedOwnerRefCount)} record(s) reference User/Group/Queue — will default to the running user`,
    );
  }
  deps.log(`report    ${reportPath}`);

  const base: Omit<SeedFlowResult, "outcome"> = {
    sessionId,
    start: started.summary,
    analyze: analyzed.summary,
    select: selected.summary,
    dryRun: dryRun.summary,
  };

  if (opts.dryRunOnly) {
    deps.log(
      `stopped   --dry-run-only. Review the report, then execute with: sandbox-seed seed resume ${sessionId}`,
    );
    return { ...base, outcome: "dry-run-only" };
  }

  const ok = await deps.confirm({
    totalRecords,
    targetOrg: opts.targetOrg,
    reportPath,
    sessionId,
  });
  if (!ok) {
    deps.log(
      `aborted   nothing inserted. The session stays resumable: sandbox-seed seed resume ${sessionId}`,
    );
    return { ...base, outcome: "declined" };
  }

  const ran = await seedFn({ action: "run", sessionId, confirm: true });
  logRunSummary(deps.log, ran);
  return { ...base, outcome: "ran", run: ran.summary };
}

/**
 * Resume a previously dry-run session: optionally refresh the dry run,
 * confirm, run. The engine's freshness + plan-hash gates decide whether
 * the existing dry run is still valid — we don't second-guess them here.
 */
export async function runResumeFlow(
  opts: { sessionId: string; refreshDryRun: boolean },
  deps: SeedFlowDeps,
): Promise<{
  sessionId: string;
  outcome: "ran" | "declined";
  dryRun?: Record<string, unknown>;
  run?: Record<string, unknown>;
}> {
  const seedFn = deps.seedFn ?? seed;

  let dryRunSummary: Record<string, unknown> | undefined;
  let totalRecords = -1;
  let reportPath = "";
  if (opts.refreshDryRun) {
    const dryRun = await seedFn({ action: "dry_run", sessionId: opts.sessionId });
    dryRunSummary = dryRun.summary;
    totalRecords = numberOr0(dryRun.summary.totalRecords);
    reportPath = String(dryRun.summary.reportPath ?? "");
    deps.log(`dry run   refreshed — ${fmtNum(totalRecords)} record(s) · report ${reportPath}`);
  }

  const ok = await deps.confirm({
    totalRecords,
    targetOrg: "(from session)",
    reportPath,
    sessionId: opts.sessionId,
  });
  if (!ok) {
    deps.log(`aborted   nothing inserted. Session ${opts.sessionId} stays resumable.`);
    return { sessionId: opts.sessionId, outcome: "declined", dryRun: dryRunSummary };
  }

  const ran = await seedFn({ action: "run", sessionId: opts.sessionId, confirm: true });
  logRunSummary(deps.log, ran);
  return { sessionId: opts.sessionId, outcome: "ran", dryRun: dryRunSummary, run: ran.summary };
}

function logRunSummary(log: (m: string) => void, ran: SeedResponse): void {
  log(
    `run       inserted ${fmtNum(ran.summary.totalInserted)} · errors ${fmtNum(ran.summary.errorCount)}`,
  );
  log(`log       ${String(ran.summary.logPath ?? "")}`);
  const vrFailed = ran.summary.validationRulesReactivationFailed;
  if (Array.isArray(vrFailed) && vrFailed.length > 0) {
    log(
      `WARNING   ${vrFailed.length} validation rule(s) failed to reactivate — run: ` +
        `sandbox-seed seed recover ${ran.sessionId}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// Flag-value parsers (pure; throw UserError with the offending input)
// ────────────────────────────────────────────────────────────────────

/** "Contact:ReportsToId,OtherId" (repeatable) → { Contact: [ReportsToId, OtherId] } */
export function parseChildLookups(
  values: string[] | undefined,
): Record<string, string[]> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const out: Record<string, string[]> = {};
  for (const raw of values) {
    const idx = raw.indexOf(":");
    const object = idx > 0 ? raw.slice(0, idx).trim() : "";
    const fields =
      idx > 0
        ? raw
            .slice(idx + 1)
            .split(",")
            .map((f) => f.trim())
            .filter((f) => f.length > 0)
        : [];
    if (object.length === 0 || fields.length === 0) {
      throw new UserError(
        `Invalid --child-lookup "${raw}".`,
        "Expected format: ChildObject:Field1[,Field2]. Example: --child-lookup Contact:ReportsToId",
      );
    }
    out[object] = [...(out[object] ?? []), ...fields];
  }
  return out;
}

/** "Account=External_Id__c" (repeatable) → { Account: "External_Id__c" } */
export function parseUpsertKeys(values: string[] | undefined): Record<string, string> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const raw of values) {
    const idx = raw.indexOf("=");
    const object = idx > 0 ? raw.slice(0, idx).trim() : "";
    const field = idx > 0 ? raw.slice(idx + 1).trim() : "";
    if (object.length === 0 || field.length === 0) {
      throw new UserError(
        `Invalid --upsert-key "${raw}".`,
        "Expected format: Object=ExternalIdField. Example: --upsert-key Account=External_Id__c",
      );
    }
    out[object] = field;
  }
  return out;
}

const MASK_STRATEGIES = new Set([
  "email",
  "phone",
  "person-name",
  "street-address",
  "generic-text",
  "auto",
  "copy",
]);

/**
 * "Contact.Email" | "Contact.SSN__c:generic-text" | "Contact.Notes__c:copy"
 * (repeatable) → UserMaskFields. Field NAMES only, mirroring the MCP arg.
 */
export function parseMaskFields(values: string[] | undefined): UserMaskFields | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const out: Record<string, MaskFieldSpec[]> = {};
  for (const raw of values) {
    const colon = raw.indexOf(":");
    const path = colon > 0 ? raw.slice(0, colon).trim() : raw.trim();
    const strategy = colon > 0 ? raw.slice(colon + 1).trim() : undefined;
    const dot = path.indexOf(".");
    const object = dot > 0 ? path.slice(0, dot).trim() : "";
    const field = dot > 0 ? path.slice(dot + 1).trim() : "";
    if (
      object.length === 0 ||
      field.length === 0 ||
      (strategy !== undefined && !MASK_STRATEGIES.has(strategy))
    ) {
      throw new UserError(
        `Invalid --mask-field "${raw}".`,
        `Expected Object.Field or Object.Field:strategy with strategy one of: ${[...MASK_STRATEGIES].join(", ")}. Example: --mask-field Contact.Email:email`,
      );
    }
    const entry: MaskFieldSpec =
      strategy === undefined ? field : { field, strategy: strategy as MaskStrategy | "copy" };
    out[object] = [...(out[object] ?? []), entry];
  }
  return out;
}

/** "Account,Contact" or repeated flags → flat trimmed list. */
export function parseObjectList(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function fmtNum(v: unknown): string {
  return typeof v === "number" ? String(v) : "?";
}

function numberOr0(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function listOrNone(arr: string[]): string {
  return arr.length === 0 ? "(none)" : arr.join(", ");
}
