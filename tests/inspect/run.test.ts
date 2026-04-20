import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInspect } from "../../src/inspect/run.ts";
import {
  ACCOUNT,
  ACCOUNT_WITH_CYCLE,
  CASE,
  CASE_COMMENT,
  CONTACT,
  OPPORTUNITY,
  TASK,
  USER,
} from "../fixtures/describes.ts";

/**
 * Integration test for runInspect with a mocked fetch that serves a synthetic
 * Salesforce describe API. Proves:
 *   - end-to-end flow (auth → describe → walk → graph → plan)
 *   - cache is consulted (and written)
 *   - no SOQL queries are fired unless --include-counts
 *   - AI-boundary compliance: no record data ever touched
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

function makeFetch(overrides: Record<string, unknown> = {}) {
  const objects = { ...OBJECTS, ...overrides };
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push(u);
    if (u.endsWith("/sobjects/")) {
      return new Response(
        JSON.stringify({
          sobjects: Object.values(objects).map((o) => {
            const obj = o as { name: string; label: string; custom: boolean; queryable: boolean; createable: boolean };
            return {
              name: obj.name,
              label: obj.label,
              custom: obj.custom,
              queryable: obj.queryable,
              createable: obj.createable,
            };
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const describeMatch = u.match(/\/sobjects\/([^/]+)\/describe\/$/);
    if (describeMatch !== null) {
      const name = describeMatch[1];
      const obj = (objects as Record<string, unknown>)[name];
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
  return { fetchFn, calls };
}

function fakeAuth() {
  return {
    username: "test@example.com",
    orgId: "00D000000000000AAA",
    accessToken: "00Dxxxxx!fake",
    instanceUrl: "https://test.my.salesforce.com",
    apiVersion: "60.0",
    alias: "test-org",
  };
}

describe("runInspect", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "seed-inspect-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("builds a graph for the root + its transitive parents", async () => {
    const { fetchFn } = makeFetch();
    const result = await runInspect({
      auth: fakeAuth(),
      rootObject: "Case",
      parentWalkDepth: 5,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });

    expect(result.graph.nodes.has("Case")).toBe(true);
    expect(result.graph.nodes.has("Account")).toBe(true); // parent via AccountId
    expect(result.graph.nodes.has("Contact")).toBe(true); // parent via ContactId
    expect(result.graph.nodes.has("User")).toBe(true); // transitive parent via OwnerId on Account/Contact
    expect(result.graph.nodes.get("User")?.isStandardRoot).toBe(true);
    expect(result.rootObject).toBe("Case");
    expect(result.parentObjects).toContain("Account");
    expect(result.parentObjects).toContain("Contact");
  });

  it("walks 1-level children when --children is on", async () => {
    const { fetchFn } = makeFetch();
    const result = await runInspect({
      auth: fakeAuth(),
      rootObject: "Account",
      parentWalkDepth: 2,
      includeChildren: true,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    // Account.childRelationships lists Contact, Opportunity (plus filtered-out History/Feed).
    expect(result.childObjects).toContain("Contact");
    expect(result.childObjects).toContain("Opportunity");
    expect(result.childObjects).not.toContain("AccountHistory");
    expect(result.childObjects).not.toContain("AccountFeed");
  });

  it("excludes standard roots from the load plan", async () => {
    const { fetchFn } = makeFetch();
    const result = await runInspect({
      auth: fakeAuth(),
      rootObject: "Contact",
      parentWalkDepth: 2,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    expect(result.plan.excluded).toContain("User");
  });

  it("detects cycles end-to-end", async () => {
    const result = await runInspect({
      auth: fakeAuth(),
      rootObject: "Contact",
      parentWalkDepth: 3,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: makeFetch({ Account: ACCOUNT_WITH_CYCLE }).fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    const twoNodeCycle = result.cycles.find((c) => c.nodes.length === 2);
    expect(twoNodeCycle).toBeDefined();
  });

  it("fires zero SOQL when --include-counts is false", async () => {
    const { fetchFn, calls } = makeFetch();
    await runInspect({
      auth: fakeAuth(),
      rootObject: "Contact",
      parentWalkDepth: 2,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    for (const call of calls) {
      expect(call).not.toMatch(/\/query/);
      expect(call).not.toMatch(/SELECT/i);
    }
  });

  it("fires COUNT queries when --include-counts is true (metadata only)", async () => {
    const { fetchFn, calls } = makeFetch();
    const result = await runInspect({
      auth: fakeAuth(),
      rootObject: "Contact",
      parentWalkDepth: 2,
      includeChildren: false,
      includeCounts: true,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    const countCalls = calls.filter((c) => /SELECT/i.test(decodeURIComponent(c)));
    expect(countCalls.length).toBeGreaterThan(0);
    for (const c of countCalls) {
      expect(decodeURIComponent(c)).toMatch(/SELECT COUNT\(\)/i);
    }
    expect(result.graph.nodes.get("Contact")?.rowCount).toBe(42);
  });

  it("uses cache on the second run (fewer API calls)", async () => {
    const { fetchFn, calls } = makeFetch();

    await runInspect({
      auth: fakeAuth(),
      rootObject: "Contact",
      parentWalkDepth: 2,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    const firstRunCalls = calls.length;
    expect(firstRunCalls).toBeGreaterThan(0);

    await runInspect({
      auth: fakeAuth(),
      rootObject: "Contact",
      parentWalkDepth: 2,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    // Second run should not re-fetch any describes that succeeded the first time.
    // 404 responses (e.g. Profile/Lead) are retried because negative responses are
    // not cached — by design, so admins fixing permissions see the change.
    const succeeded = (c: string) => !c.includes("Profile") && !c.includes("Lead");
    const successfulSecond = calls.slice(firstRunCalls).filter(succeeded);
    expect(successfulSecond.length).toBe(0);
  });

  it("--no-cache forces re-fetch", async () => {
    const { fetchFn, calls } = makeFetch();
    await runInspect({
      auth: fakeAuth(),
      rootObject: "Account",
      parentWalkDepth: 1,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: false,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    const firstCount = calls.length;

    await runInspect({
      auth: fakeAuth(),
      rootObject: "Account",
      parentWalkDepth: 1,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: true,
      cacheRoot,
      fetchFn: fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });
    expect(calls.length).toBeGreaterThan(firstCount);
  });
});
