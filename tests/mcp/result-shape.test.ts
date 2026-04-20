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
import { listOrgs } from "../../src/mcp/tools/list-orgs.ts";
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
 * The MCP SDK validates `tools/call` results: `structuredContent` MUST be a
 * JSON object, not a bare array, not a primitive. If a handler returns
 * `OrgSummary[]` directly, the SDK rejects the whole call with
 * `Invalid input: expected record, received array` and no host can render
 * the response.
 *
 * This test enforces that every tool handler returns an object at the top
 * level. Caught once in the wild; never again.
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

function assertPlainObject(value: unknown, toolName: string): void {
  expect(value, `${toolName} must return a value`).not.toBeNull();
  expect(value, `${toolName} must return a value`).not.toBeUndefined();
  expect(
    Array.isArray(value),
    `${toolName} returned an array at the top level — MCP structuredContent must be an object`,
  ).toBe(false);
  expect(
    typeof value,
    `${toolName} returned ${typeof value} at the top level — must be object`,
  ).toBe("object");
}

describe("tool-result shape (structuredContent must be a record)", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "seed-mcp-shape-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("check_ai_boundary: object shape", () => {
    assertPlainObject(checkAiBoundary(), "check_ai_boundary");
  });

  it("list_orgs: object shape (not a bare array)", async () => {
    // Mock sf CLI out — listOrgs normally shells out to `sf org list --json`.
    // We don't need it to succeed; we just need it to return an object shape.
    const result = await listOrgs();
    assertPlainObject(result, "list_orgs");
    expect(result).toHaveProperty("orgs");
    expect(result).toHaveProperty("count");
    expect(Array.isArray(result.orgs)).toBe(true);
  });

  it("describe_global: object shape", async () => {
    const result = await describeGlobal(
      {},
      { auth: fakeAuth(), fetchFn: makeFetch(), cacheRoot },
    );
    assertPlainObject(result, "describe_global");
  });

  it("describe_object: object shape", async () => {
    const result = await describeObject(
      { object: "Case" },
      { auth: fakeAuth(), fetchFn: makeFetch(), cacheRoot },
    );
    assertPlainObject(result, "describe_object");
  });

  it("inspect_object: object shape", async () => {
    const result = await inspectObject(
      { object: "Case", parentDepth: 2, includeChildren: true, includeCounts: false },
      { auth: fakeAuth(), fetchFn: makeFetch(), cacheRoot, skipGlobalValidate: true },
    );
    assertPlainObject(result, "inspect_object");
  });

  it("check_row_counts: object shape", async () => {
    const result = await checkRowCounts(
      { objects: ["Case", "Account"] },
      { auth: fakeAuth(), fetchFn: makeFetch() },
    );
    assertPlainObject(result, "check_row_counts");
  });
});
