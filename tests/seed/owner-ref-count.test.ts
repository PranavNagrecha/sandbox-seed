import { describe, expect, it, vi } from "vitest";
import type { DescribeClient } from "../../src/describe/client.ts";
import { _countDefaultedOwnerRefs } from "../../src/seed/dry-run.ts";
import { CONTACT } from "../fixtures/describes.ts";

/**
 * Locks in the fix for the sampled-scope owner-ref over-count.
 *
 * The bug: `countDefaultedOwnerRefs` re-derived its COUNT() scope from the
 * recorded per-object SOQL's WHERE clause. For a sampled session the root's
 * recorded SOQL is the RAW user WHERE clause, so a `sampleSize: 5` session
 * against a ~800k-row match reported "~800,000 record(s) reference
 * User/Group/Queue" in the dry run. It also reused only the FIRST chunk of
 * chunked child scopes, undercounting any scope past 200 IDs.
 *
 * The fix: count over the exact materialized in-scope IDs, chunked.
 */

function ids(count: number, prefix = "003"): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${prefix}${String(i).padStart(15, "0")}`);
  }
  return out;
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

const describeStub = {
  describeObject: async () => CONTACT,
} as unknown as DescribeClient;

function makeCountFetch(totalSizePerCall: number) {
  const queries: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const q = decodeURIComponent(u.split("?q=")[1] ?? "");
    queries.push(q);
    return new Response(JSON.stringify({ totalSize: totalSizePerCall, done: true, records: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchFn, queries };
}

describe("countDefaultedOwnerRefs", () => {
  it("counts over the materialized scope IDs, not the WHERE clause", async () => {
    const scope = ids(5);
    const { fetchFn, queries } = makeCountFetch(3);

    const out = await _countDefaultedOwnerRefs({
      objects: ["Contact"],
      sourceAuth: fakeAuth(),
      sourceDescribe: describeStub,
      materializedIds: new Map([["Contact", scope]]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(out).toEqual({ Contact: 3 });
    expect(queries).toHaveLength(1);
    // The COUNT query is pinned to the exact sampled IDs...
    expect(queries[0]).toContain("SELECT COUNT() FROM Contact");
    expect(queries[0]).toContain(`Id IN ('${scope[0]}'`);
    // ...and filters on the owner reference field from the describe.
    expect(queries[0]).toContain("OwnerId != null");
  });

  it("chunks large scopes and sums the per-chunk counts", async () => {
    const scope = ids(450); // ROOT_ID_CHUNK=200 → 3 chunks
    const { fetchFn, queries } = makeCountFetch(10);

    const out = await _countDefaultedOwnerRefs({
      objects: ["Contact"],
      sourceAuth: fakeAuth(),
      sourceDescribe: describeStub,
      materializedIds: new Map([["Contact", scope]]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(queries).toHaveLength(3);
    expect(out).toEqual({ Contact: 30 });
    // Every in-scope ID appears in exactly one chunk.
    const combined = queries.join("\n");
    for (const id of scope) {
      expect(combined).toContain(`'${id}'`);
    }
  });

  it("skips objects with no materialized scope", async () => {
    const { fetchFn, queries } = makeCountFetch(99);

    const out = await _countDefaultedOwnerRefs({
      objects: ["Contact"],
      sourceAuth: fakeAuth(),
      sourceDescribe: describeStub,
      materializedIds: new Map(),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(out).toEqual({});
    expect(queries).toHaveLength(0);
  });

  it("stays best-effort when the count query fails", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));

    const out = await _countDefaultedOwnerRefs({
      objects: ["Contact"],
      sourceAuth: fakeAuth(),
      sourceDescribe: describeStub,
      materializedIds: new Map([["Contact", ids(5)]]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(out).toEqual({});
  });
});
