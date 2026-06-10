import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESCRIBE_CONCURRENCY } from "../../src/describe/client.ts";
import { runInspect } from "../../src/inspect/run.ts";
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
 * Proves the walk's describes fan out in parallel (bounded by
 * DESCRIBE_CONCURRENCY) AND that the parallel walk produces the same
 * graph the sequential walk did: same parents, children, distances,
 * referenced-only handling, and exactly one describe per object.
 */

const OBJECTS: Record<string, unknown> = {
  Account: ACCOUNT,
  Contact: CONTACT,
  Opportunity: OPPORTUNITY,
  Case: CASE,
  CaseComment: CASE_COMMENT,
  Task: TASK,
  User: USER,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeDelayedFetch(opts: { delayMs: number; omit?: string[] }) {
  const describeCalls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const describeMatch = u.match(/\/sobjects\/([^/]+)\/describe\/$/);
    if (describeMatch !== null) {
      const name = describeMatch[1]!;
      describeCalls.push(name);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(opts.delayMs);
      inFlight--;
      if (opts.omit?.includes(name) || OBJECTS[name] === undefined) {
        return new Response("", { status: 404 });
      }
      return new Response(JSON.stringify(OBJECTS[name]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled", { status: 500 });
  });

  return {
    fetchFn,
    describeCalls,
    maxInFlight: () => maxInFlight,
  };
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

describe("parallel describe walk", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "seed-parallel-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("describes within a level concurrently, bounded by DESCRIBE_CONCURRENCY", async () => {
    const fake = makeDelayedFetch({ delayMs: 25 });
    await runInspect({
      auth: fakeAuth(),
      rootObject: "Case",
      parentWalkDepth: 3,
      includeChildren: true,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: true,
      cacheRoot,
      fetchFn: fake.fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });

    expect(fake.maxInFlight()).toBeGreaterThan(1);
    expect(fake.maxInFlight()).toBeLessThanOrEqual(DESCRIBE_CONCURRENCY);
  });

  it("produces the same walk results as the sequential semantics", async () => {
    const fake = makeDelayedFetch({ delayMs: 5 });
    const result = await runInspect({
      auth: fakeAuth(),
      rootObject: "Case",
      parentWalkDepth: 3,
      includeChildren: true,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: true,
      cacheRoot,
      fetchFn: fake.fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });

    // Parents of Case: Account + Contact (described), User (standard root,
    // referenced-only). Distances are min-depth: both at 1.
    expect(result.parentObjects).toEqual(expect.arrayContaining(["Account", "Contact", "User"]));
    expect(result.graph.nodes.get("Account")?.distanceFromRoot).toBe(1);
    expect(result.graph.nodes.get("Contact")?.distanceFromRoot).toBe(1);
    expect(result.graph.nodes.get("Account")?.described).toBe(true);
    expect(result.graph.nodes.get("User")?.described).toBe(false);

    // Children of Case per the fixture.
    expect(result.childObjects).toEqual(expect.arrayContaining(["CaseComment"]));

    // Each object described exactly once — parallelism must not double-fetch.
    const counts = new Map<string, number>();
    for (const name of fake.describeCalls) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, n] of counts) {
      expect(n, `describe for ${name} fetched ${n}x`).toBe(1);
    }
  });

  it("keeps permission-denied parents as referenced-only under parallelism", async () => {
    const fake = makeDelayedFetch({ delayMs: 5, omit: ["Contact"] });
    const result = await runInspect({
      auth: fakeAuth(),
      rootObject: "Case",
      parentWalkDepth: 3,
      includeChildren: false,
      includeCounts: false,
      cacheTtlSeconds: 3600,
      bypassCache: true,
      cacheRoot,
      fetchFn: fake.fetchFn as unknown as typeof fetch,
      skipGlobalValidate: true,
    });

    // Contact 404s (permission denied) — stays a referenced-only parent,
    // and the walk completes instead of failing.
    expect(result.parentObjects).toContain("Contact");
    expect(result.graph.nodes.get("Contact")?.described).toBe(false);
    expect(result.graph.nodes.get("Contact")?.distanceFromRoot).toBe(1);
    // Account was unaffected.
    expect(result.graph.nodes.get("Account")?.described).toBe(true);
  });
});
