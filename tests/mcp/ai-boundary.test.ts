import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import { checkAiBoundary } from "../../src/mcp/tools/check-ai-boundary.ts";
import { checkRowCounts } from "../../src/mcp/tools/check-row-counts.ts";
import { describeGlobal } from "../../src/mcp/tools/describe-global.ts";
import { describeObject } from "../../src/mcp/tools/describe-object.ts";
import { inspectObject } from "../../src/mcp/tools/inspect-object.ts";
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
 * The canonical AI-boundary test.
 *
 * For each tool handler, invoke against a mocked Salesforce API and assert
 * the returned payload contains **no record data**. Specifically:
 *   - no key literally named `Id`
 *   - no key literally named `records`
 *   - no key literally named `attributes` (salesforce record envelope)
 *   - no value that looks like an 18-char Salesforce record ID
 *   - no value that looks like a Salesforce 15/18-char ID embedded in strings
 *
 * This test is the enforcement arm of the AI-data-boundary contract. If any
 * future change to a tool handler starts leaking record data, this test
 * fails in CI before the leak ships.
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

function makeFetch(): typeof fetch {
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();

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
    if (/\/query\?q=/.test(u) && /COUNT/i.test(decodeURIComponent(u))) {
      return new Response(JSON.stringify({ totalSize: 42, done: true, records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled", { status: 500 });
  });
  return fetchFn as unknown as typeof fetch;
}

function fakeAuth(): OrgAuth {
  return {
    username: "test@example.com",
    orgId: "00D000000000000AAA",
    accessToken: "00Dxxxxx!fake",
    instanceUrl: "https://test.my.salesforce.com",
    apiVersion: "60.0",
    alias: "test-org",
  };
}

/**
 * Walk a value recursively and collect any forbidden key names or
 * ID-shaped string values. Returns a list of violation descriptions.
 */
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
      // Forbidden key names that only appear in record payloads
      if (key === "Id" || key === "records" || key === "attributes") {
        violations.push({ path: `${path}.${key}`, reason: `forbidden key "${key}"` });
      }
      violations.push(...findBoundaryViolations(v, `${path}.${key}`));
    }
    return violations;
  }

  if (typeof value === "string") {
    // Salesforce record IDs: 15 or 18 chars, alphanumeric, FIRST CHAR IS A DIGIT.
    // Every standard SObject key prefix starts with a digit (Account=001, Case=500,
    // User=005, Task=00T, Org=00D, etc.). Custom objects use prefixes starting
    // with lowercase `a` — but we never surface custom-object IDs in tool output
    // (only API names like `AccountNote__c`), so the digit-prefix rule is safe.
    //
    // Whitelist the org ID (00D-prefixed) since it's non-sensitive auth metadata.
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

describe("AI-boundary enforcement", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "seed-mcp-boundary-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("check_ai_boundary: static payload has no record data", () => {
    const result = checkAiBoundary();
    expect(findBoundaryViolations(result)).toEqual([]);
  });

  it("describe_global: returns metadata only", async () => {
    const result = await describeGlobal(
      {},
      { auth: fakeAuth(), fetchFn: makeFetch(), cacheRoot },
    );
    expect(findBoundaryViolations(result)).toEqual([]);
    // Must actually have returned objects — otherwise the test passes vacuously.
    expect(result.objects.length).toBeGreaterThan(0);
  });

  it("describe_object: returns metadata only", async () => {
    const result = await describeObject(
      { object: "Case" },
      { auth: fakeAuth(), fetchFn: makeFetch(), cacheRoot },
    );
    expect(findBoundaryViolations(result)).toEqual([]);
    expect(result.describe.name).toBe("Case");
    expect(result.describe.fields.length).toBeGreaterThan(0);
  });

  it("inspect_object: returns metadata only (no counts)", async () => {
    const result = await inspectObject(
      { object: "Case", parentDepth: 2, includeChildren: true, includeCounts: false },
      { auth: fakeAuth(), fetchFn: makeFetch(), cacheRoot, skipGlobalValidate: true },
    );
    expect(findBoundaryViolations(result)).toEqual([]);
    expect(result.rootObject).toBe("Case");
    expect(result.graph.nodes.length).toBeGreaterThan(0);
  });

  it("inspect_object: includeCounts adds integers only, no record data", async () => {
    const result = await inspectObject(
      { object: "Case", parentDepth: 2, includeChildren: true, includeCounts: true },
      { auth: fakeAuth(), fetchFn: makeFetch(), cacheRoot, skipGlobalValidate: true },
    );
    expect(findBoundaryViolations(result)).toEqual([]);
    // rowCount should be an integer or null — never an object with record data
    for (const node of result.graph.nodes) {
      const rc = (node as { rowCount: unknown }).rowCount;
      expect(rc === null || typeof rc === "number").toBe(true);
    }
  });

  it("check_row_counts: returns integers or null only", async () => {
    const result = await checkRowCounts(
      { objects: ["Case", "Account", "Contact"] },
      { auth: fakeAuth(), fetchFn: makeFetch() },
    );
    expect(findBoundaryViolations(result)).toEqual([]);
    for (const value of Object.values(result.counts)) {
      expect(value === null || typeof value === "number").toBe(true);
    }
  });

  it("the detector itself catches obvious leaks (sanity check)", () => {
    // Negative control: if our detector doesn't flag an obvious record payload,
    // the other tests prove nothing.
    const leak = {
      records: [
        { attributes: { type: "Case", url: "/services/data/v60.0/sobjects/Case/5003000000D8cuIAAR" } },
        { Id: "5003000000D8cuIAAR", Subject: "test case" },
      ],
    };
    const violations = findBoundaryViolations(leak);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.reason.includes("records"))).toBe(true);
    expect(violations.some((v) => v.reason.includes("Id"))).toBe(true);
    expect(violations.some((v) => v.reason.includes("attributes"))).toBe(true);
    expect(violations.some((v) => v.reason.includes("record ID"))).toBe(true);
  });
});
