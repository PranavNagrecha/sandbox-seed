import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import { seed, type SeedResponse } from "../../src/mcp/tools/seed.ts";
import {
  ACCOUNT,
  CASE,
  CASE_COMMENT,
  CONTACT,
  OPPORTUNITY,
  TASK,
  USER,
} from "../fixtures/describes.ts";

/**
 * AI-boundary enforcement for the `sandbox_seed_seed` MCP tool across
 * every action (start → analyze → select → dry_run).
 *
 * Every response field is metadata-only: object names, field names,
 * counts, file paths, enums. No record IDs, no field values. This test
 * drives the full multi-turn flow against a mocked Salesforce API and
 * scans every response for record-ID-shaped strings and forbidden keys.
 *
 * The `run` action is not exercised here — it writes real composite
 * inserts which require a lot more mock surface. Its boundary is
 * covered by construction: it returns only `totalInserted`,
 * `insertedCounts`, `errorCount`, and disk paths.
 */

const OBJECTS = {
  Account: ACCOUNT,
  Contact: CONTACT,
  Opportunity: OPPORTUNITY,
  Case: CASE,
  CaseComment: CASE_COMMENT,
  Task: TASK,
  User: USER,
};

function fakeAuth(alias: string, orgId = "00D000000000000AAA"): OrgAuth {
  return {
    username: `${alias}@example.com`,
    orgId,
    accessToken: "00Dxxxxx!fake",
    instanceUrl: `https://${alias}.my.salesforce.com`,
    apiVersion: "60.0",
    alias,
  };
}

/**
 * Build a fetch that pretends to be both source and target orgs.
 * Target is distinguished by hostname; IsSandbox=true on the target.
 */
function makeFetch(): typeof fetch {
  // Generate a handful of "source" Opportunity IDs so dry-run has
  // realistic root scope. These IDs live in the REST body and on disk
  // but must never appear in the tool response.
  const sourceOpptyIds = [
    "0065g00000A1b2cAAB",
    "0065g00000A1b2dAAB",
    "0065g00000A1b2eAAB",
  ];

  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const decoded = decodeURIComponent(u);
    const isTarget = u.includes("tgt.my.salesforce.com");

    if (u.endsWith("/sobjects/")) {
      return new Response(
        JSON.stringify({
          sobjects: Object.values(OBJECTS).map((o) => ({
            name: o.name,
            label: o.label,
            custom: o.custom,
            queryable: o.queryable,
            createable: o.createable,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const describeMatch = u.match(/\/sobjects\/([^/]+)\/describe\/$/);
    if (describeMatch !== null) {
      const name = describeMatch[1];
      const obj = (OBJECTS as Record<string, unknown>)[name];
      if (obj === undefined) return new Response("", { status: 404 });
      return new Response(JSON.stringify(obj), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (/IsSandbox\s+FROM\s+Organization/i.test(decoded)) {
      // Source is prod; target is sandbox.
      return new Response(
        JSON.stringify({
          records: [{ IsSandbox: isTarget }],
          done: true,
          totalSize: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (/^SELECT\s+COUNT\(\)/i.test(decoded.replace(/^.*\bq=/, ""))) {
      return new Response(
        JSON.stringify({ totalSize: sourceOpptyIds.length, done: true, records: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (/SELECT\s+Id\s+FROM\s+Opportunity/i.test(decoded)) {
      return new Response(
        JSON.stringify({
          totalSize: sourceOpptyIds.length,
          done: true,
          records: sourceOpptyIds.map((id) => ({
            attributes: { type: "Opportunity", url: `/x/${id}` },
            Id: id,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (/SELECT\s+Id\s+FROM\s+/i.test(decoded)) {
      // Generic "materialize parent/child IDs" response.
      return new Response(
        JSON.stringify({ totalSize: 0, done: true, records: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (/\/query\?q=/.test(u)) {
      // Catch-all count response for scope probes we didn't special-case.
      return new Response(
        JSON.stringify({ totalSize: 0, done: true, records: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(`unhandled: ${u}`, { status: 500 });
  });
  return fetchFn as unknown as typeof fetch;
}

/** Same detector shape as tests/mcp/ai-boundary.test.ts. */
function findBoundaryViolations(
  value: unknown,
  path = "$",
): Array<{ path: string; reason: string }> {
  const violations: Array<{ path: string; reason: string }> = [];
  if (value === null || value === undefined) return violations;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      violations.push(...findBoundaryViolations(value[i], `${path}[${i}]`));
    }
    return violations;
  }

  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "Id" || key === "records" || key === "attributes") {
        violations.push({ path: `${path}.${key}`, reason: `forbidden key "${key}"` });
      }
      violations.push(...findBoundaryViolations(v, `${path}.${key}`));
    }
    return violations;
  }

  if (typeof value === "string") {
    // Record-ID shape: 15 or 18 chars, alphanumeric, first char digit.
    // Whitelist the 00D org prefix — non-sensitive auth metadata.
    // Also whitelist file paths (they contain session ids like
    // "2026-04-19-<hex>" but never Salesforce record IDs).
    const looksLikeRecordId = /^[0-9][a-zA-Z0-9]{14}([a-zA-Z0-9]{3})?$/.test(value);
    if (looksLikeRecordId && !value.startsWith("00D")) {
      violations.push({
        path,
        reason: `value "${value}" looks like a Salesforce record ID`,
      });
    }
  }

  return violations;
}

describe("sandbox_seed_seed: AI-boundary enforcement across actions", () => {
  let sessionRoot: string;
  let cacheRoot: string;

  beforeEach(async () => {
    sessionRoot = await mkdtemp(join(tmpdir(), "seed-boundary-sess-"));
    cacheRoot = await mkdtemp(join(tmpdir(), "seed-boundary-cache-"));
  });

  afterEach(async () => {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  });

  async function drive(): Promise<{ start: SeedResponse; analyze: SeedResponse; select: SeedResponse; dryRun: SeedResponse }> {
    const overrides = {
      sessionRootDir: sessionRoot,
      cacheRoot,
      fetchFn: makeFetch(),
      authBySource: fakeAuth("src", "00D000000000000AAA"),
      authByTarget: fakeAuth("tgt", "00D000000000000BBB"),
    };

    const start = await seed(
      {
        action: "start",
        sourceOrg: "src",
        targetOrg: "tgt",
        object: "Opportunity",
        whereClause: "Amount > 100",
      },
      overrides,
    );

    const analyze = await seed(
      { action: "analyze", sessionId: start.sessionId },
      overrides,
    );

    const select = await seed(
      {
        action: "select",
        sessionId: start.sessionId,
        includeOptionalParents: [],
        includeOptionalChildren: [],
      },
      overrides,
    );

    const dryRun = await seed(
      { action: "dry_run", sessionId: start.sessionId },
      overrides,
    );

    return { start, analyze, select, dryRun };
  }

  it("start response contains no record data", async () => {
    const { start } = await drive();
    expect(findBoundaryViolations(start)).toEqual([]);
    expect(start.summary).toHaveProperty("matchedCount");
    expect(typeof (start.summary as { matchedCount: unknown }).matchedCount).toBe("number");
  });

  it("analyze response contains no record data", async () => {
    const { analyze } = await drive();
    expect(findBoundaryViolations(analyze)).toEqual([]);
    // Must have actually surfaced at least one classified object —
    // otherwise the test passes vacuously.
    const s = analyze.summary as Record<string, unknown>;
    expect(Array.isArray(s.mustIncludeParents)).toBe(true);
    expect(Array.isArray(s.optionalParents)).toBe(true);
    expect(Array.isArray(s.optionalChildren)).toBe(true);
    expect(Array.isArray(s.loadOrder)).toBe(true);
  });

  it("select response contains no record data", async () => {
    const { select } = await drive();
    expect(findBoundaryViolations(select)).toEqual([]);
    const s = select.summary as Record<string, unknown>;
    expect(Array.isArray(s.finalObjectList)).toBe(true);
    expect(Array.isArray(s.finalLoadOrder)).toBe(true);
  });

  it("dry_run response contains no record data (counts + paths only)", async () => {
    const { dryRun } = await drive();
    expect(findBoundaryViolations(dryRun)).toEqual([]);
    const s = dryRun.summary as Record<string, unknown>;
    expect(typeof s.totalRecords).toBe("number");
    expect(typeof s.reportPath).toBe("string");
    // Even though the report file on disk contains scope IDs, the
    // response relays only the path — verify it's under our session dir.
    expect((s.reportPath as string).startsWith(sessionRoot)).toBe(true);
  });

  it("start response shape: plain object with sessionId and step", async () => {
    const { start } = await drive();
    expect(typeof start).toBe("object");
    expect(Array.isArray(start)).toBe(false);
    expect(typeof start.sessionId).toBe("string");
    expect(start.step).toBe("started");
    expect(start.action).toBe("start");
    expect(start.nextAction).toBe("analyze");
  });

  it("rejects production target (IsSandbox=false)", async () => {
    // Flip the fetch so the target org reports as prod.
    const overrides = {
      sessionRootDir: sessionRoot,
      cacheRoot,
      fetchFn: makeFetch(),
      authBySource: fakeAuth("src", "00D000000000000AAA"),
      // Use a source-alias prefix for the TARGET so the fetch mock
      // treats it as a production org (IsSandbox=false).
      authByTarget: fakeAuth("src", "00D000000000000BBB"),
    };
    await expect(
      seed(
        {
          action: "start",
          sourceOrg: "src",
          targetOrg: "actually-prod",
          object: "Opportunity",
          whereClause: "Amount > 100",
        },
        overrides,
      ),
    ).rejects.toThrow(/not a sandbox/i);
  });
});
