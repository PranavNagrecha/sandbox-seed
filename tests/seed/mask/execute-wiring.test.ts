import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrgAuth } from "../../../src/auth/sf-auth.ts";
import type { DescribeClient } from "../../../src/describe/client.ts";
import type { Field, SObjectDescribe } from "../../../src/describe/types.ts";
import type { DependencyGraph } from "../../../src/graph/build.ts";
import type { LoadPlan } from "../../../src/graph/order.ts";
import { runExecute } from "../../../src/seed/execute.ts";
import type { MaskSelection } from "../../../src/seed/mask/types.ts";

/**
 * Integration of the masking hook in execute.ts (plan tasks T6 + T7), driven
 * against a captured fake Salesforce — no live org, no real data. Asserts on
 * the exact composite bodies that would hit the target:
 *
 *   - flag OFF  → scalar values copied verbatim (byte-identical to today)
 *   - flag ON   → selected scalar masked; the ORIGINAL value leaks NOWHERE (#4)
 *   - reference fields are NEVER masked, even if selected (#8)
 *   - two runs with the same salt produce identical masked values (#7)
 */

const ORIGINAL_ALICE = "alice@real-domain.example";
const ORIGINAL_BOB = "bob@real-domain.example";

function mkAuth(tag: string): OrgAuth {
  return {
    username: `${tag}@example.com`,
    alias: tag,
    instanceUrl: `https://${tag}.my.salesforce.com`,
    accessToken: `${tag}-token`,
    orgId: `00D${tag.padEnd(12, "0").slice(0, 12)}`,
    apiVersion: "60.0",
    isSandbox: true,
  };
}

function f(name: string, type: string, extra: Partial<Field> = {}): Field {
  return { name, type, nillable: true, custom: false, ...extra } as Field;
}
function ref(name: string, referenceTo: string[]): Field {
  return {
    name,
    type: "reference",
    referenceTo,
    relationshipName: null,
    nillable: true,
    custom: false,
  } as Field;
}

function mkContactDescribe(): SObjectDescribe {
  return {
    name: "Contact",
    label: "Contact",
    custom: false,
    queryable: true,
    createable: true,
    fields: [
      f("Id", "id", { createable: false, nillable: false }),
      f("LastName", "string", { nillable: false, length: 80 }),
      f("Email", "email", { length: 80 }),
      ref("AccountId", ["Account"]),
    ],
    childRelationships: [],
    recordTypeInfos: [],
  };
}

function fakeDescribeClient(by: Record<string, SObjectDescribe>): DescribeClient {
  return {
    describeObject: async (name: string) => {
      const d = by[name];
      if (d === undefined) throw new Error(`no describe for ${name}`);
      return d;
    },
  } as unknown as DescribeClient;
}

function mkGraph(): DependencyGraph {
  return {
    nodes: new Map([
      [
        "Contact",
        {
          label: "Contact",
          custom: false,
          isStandardRoot: false,
          described: true,
          role: "root" as const,
          distanceFromRoot: 0,
          requiredFields: [],
          sensitiveFields: [],
          droppedFieldCounts: { formula: 0, audit: 0, nonCreateable: 0 },
          totalFieldCount: 4,
          rowCount: null,
        },
      ],
    ]),
    edges: [],
  };
}

function mkLoadPlan(): LoadPlan {
  return { steps: [{ kind: "single", object: "Contact" }], excluded: [] };
}

const sourceRecords = [
  {
    Id: "003SRC000000001AAA",
    LastName: "Alice",
    Email: ORIGINAL_ALICE,
    AccountId: "001SRC000000001AAA",
  },
  {
    Id: "003SRC000000002AAA",
    LastName: "Bob",
    Email: ORIGINAL_BOB,
    AccountId: "001SRC000000002AAA",
  },
];

function makeFakeFetch(
  calls: Array<{ method: string; url: string; body?: unknown }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });

    if (url.includes("/query?q=")) {
      const isIdOnly = !url.includes("%2C") && !url.includes(",");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          done: true,
          records: isIdOnly ? sourceRecords.map((r) => ({ Id: r.Id })) : sourceRecords,
        }),
      } as unknown as Response;
    }

    if (method === "POST" && url.endsWith("/composite/sobjects")) {
      const records = (body as { records: unknown[] }).records;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () =>
          records.map((_, i) => ({ id: `003TGT${String(i).padStart(11, "0")}A`, success: true })),
      } as unknown as Response;
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

/** Pull the inserted record bodies out of the captured composite POST calls. */
function insertedRecords(
  calls: Array<{ method: string; url: string; body?: unknown }>,
): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.method === "POST" && c.url.endsWith("/composite/sobjects"))
    .flatMap((c) => (c.body as { records: Array<Record<string, unknown>> }).records);
}

describe("runExecute — field masking wiring (T6/T7)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  async function runFresh(masking?: { salt: string; selection: MaskSelection }) {
    const sessionDir = await mkdtemp(join(tmpdir(), "mask-wire-"));
    dirs.push(sessionDir);
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const desc = fakeDescribeClient({ Contact: mkContactDescribe() });
    const r = await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkGraph(),
      rootObject: "Contact",
      whereClause: "Id != null",
      finalObjectList: ["Contact"],
      loadPlan: mkLoadPlan(),
      sessionDir,
      fetchFn: makeFakeFetch(calls),
      masking,
    });
    return { r, calls };
  }

  const emailOnly: MaskSelection = new Map([["Contact", new Map([["Email", "auto"]])]]);

  it("flag OFF: scalar values are copied verbatim", async () => {
    const { calls } = await runFresh(undefined);
    const alice = insertedRecords(calls).find((x) => x.LastName === "Alice");
    expect(alice?.Email).toBe(ORIGINAL_ALICE);
  });

  it("flag ON: selected email is masked and the original leaks NOWHERE (invariant #4)", async () => {
    const { calls } = await runFresh({ salt: "salt-1", selection: emailOnly });
    const recs = insertedRecords(calls);
    const alice = recs.find((x) => x.LastName === "Alice");
    expect(alice?.Email).not.toBe(ORIGINAL_ALICE);
    expect(alice?.Email).toMatch(/@/);
    // A non-selected field is untouched.
    expect(alice?.LastName).toBe("Alice");
    // No-leak: neither original address appears anywhere in the sent traffic.
    const blob = JSON.stringify(calls);
    expect(blob).not.toContain(ORIGINAL_ALICE);
    expect(blob).not.toContain(ORIGINAL_BOB);
  });

  it("flag ON: a reference field is NEVER masked even if selected (invariant #8)", async () => {
    const selection: MaskSelection = new Map([
      [
        "Contact",
        new Map([
          ["Email", "auto"],
          ["AccountId", "auto"],
        ]),
      ],
    ]);
    const { calls } = await runFresh({ salt: "s", selection });
    const alice = insertedRecords(calls).find((x) => x.LastName === "Alice");
    // AccountId is a lookup with no id-map entry and is nillable → FK logic
    // nulls it. The masker is never consulted, so it is never faked.
    expect(alice?.AccountId).toBeNull();
  });

  it("masked values cap to the TARGET field length when it is shorter (T14 finding 6)", async () => {
    // Schema drift between same-lineage sandboxes: target Email is 12 chars,
    // source is 80. With the source length the masked email would overflow
    // and Salesforce would truncate it on insert, breaking deterministic
    // re-derivation. intersectWithTargetFields clamps Field.length to
    // min(source, target) before the masker sees it.
    const sessionDir = await mkdtemp(join(tmpdir(), "mask-wire-"));
    dirs.push(sessionDir);
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const sourceDesc = fakeDescribeClient({ Contact: mkContactDescribe() });
    const shortEmailContact = mkContactDescribe();
    shortEmailContact.fields = shortEmailContact.fields.map((f) =>
      f.name === "Email" ? { ...f, length: 12 } : f,
    );
    const targetDesc = fakeDescribeClient({ Contact: shortEmailContact });

    await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: sourceDesc,
      targetDescribe: targetDesc,
      graph: mkGraph(),
      rootObject: "Contact",
      whereClause: "Id != null",
      finalObjectList: ["Contact"],
      loadPlan: mkLoadPlan(),
      sessionDir,
      fetchFn: makeFakeFetch(calls),
      masking: { salt: "stable", selection: emailOnly },
    });

    const alice = insertedRecords(calls).find((x) => x.LastName === "Alice");
    expect(typeof alice?.Email).toBe("string");
    // Capped to the TARGET length, never the longer source length.
    expect((alice?.Email as string).length).toBeLessThanOrEqual(12);
    // Still masked, never the original.
    expect(alice?.Email).not.toBe(ORIGINAL_ALICE);
  });

  it("idempotent: two runs with the same salt produce identical masked values (invariant #7)", async () => {
    const a = await runFresh({ salt: "stable", selection: emailOnly });
    const b = await runFresh({ salt: "stable", selection: emailOnly });
    const ea = insertedRecords(a.calls).find((x) => x.LastName === "Alice")?.Email;
    const eb = insertedRecords(b.calls).find((x) => x.LastName === "Alice")?.Email;
    expect(ea).toBeDefined();
    expect(ea).toBe(eb);
  });
});
