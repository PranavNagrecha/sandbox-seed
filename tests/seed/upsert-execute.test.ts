import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExecute } from "../../src/seed/execute.ts";
import type { DescribeClient } from "../../src/describe/client.ts";
import type { SObjectDescribe } from "../../src/describe/types.ts";
import type { DependencyGraph } from "../../src/graph/build.ts";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import type { LoadPlan } from "../../src/graph/order.ts";

/**
 * End-to-end integration of the UPSERT path in execute.ts.
 *
 * The live ship-block this test locks in: re-running a seed against a
 * non-empty target sandbox used to fail every Contact with
 * DUPLICATE_VALUE on `Email` (or whichever external-id the user had
 * set). This test proves that:
 *
 *   1. When `upsertDecisions[object].kind === "picked"`, records with
 *      a populated external-id value route through
 *      PATCH /composite/sobjects/<obj>/<extIdField>.
 *   2. Records in the SAME batch with a blank ext-id value fall back
 *      to POST /composite/sobjects (INSERT).
 *   3. Both paths feed the id-map with identical semantics — a
 *      matched-and-updated row ({success: true, created: false}) is
 *      stored under its source id exactly like a newly-inserted row.
 *   4. When no decision is picked, every record goes through INSERT
 *      (pre-upsert behavior — strictly not worse than today).
 */

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

function mkContactDescribe(): SObjectDescribe {
  return {
    name: "Contact",
    label: "Contact",
    custom: false,
    queryable: true,
    createable: true,
    fields: [
      {
        name: "Id",
        label: "Id",
        type: "id",
        nillable: false,
        custom: false,
        createable: false,
        updateable: false,
        calculated: false,
        defaultedOnCreate: false,
        externalId: false,
        unique: false,
        idLookup: true,
        autoNumber: false,
      },
      {
        name: "LastName",
        label: "Last Name",
        type: "string",
        nillable: false,
        custom: false,
        createable: true,
        updateable: true,
        calculated: false,
        defaultedOnCreate: false,
        externalId: false,
        unique: false,
        idLookup: false,
        autoNumber: false,
      },
      {
        name: "SSN__c",
        label: "SSN",
        type: "string",
        nillable: true,
        custom: true,
        createable: true,
        updateable: true,
        calculated: false,
        defaultedOnCreate: false,
        externalId: true,
        unique: true,
        idLookup: true,
        autoNumber: false,
      },
    ],
    childRelationships: [],
    recordTypeInfos: [],
  };
}

function fakeDescribeClient(
  by: Record<string, SObjectDescribe>,
): DescribeClient {
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
          totalFieldCount: 3,
          rowCount: null,
        },
      ],
    ]),
    edges: [],
  };
}

function mkLoadPlan(): LoadPlan {
  return {
    steps: [{ kind: "single", object: "Contact" }],
    excluded: [],
  };
}

/**
 * Route fake HTTP. We accept both /query (for source reads) and two
 * composite endpoints on the target. Each captured call is appended
 * to `calls` so tests can assert on method + URL + body.
 */
function makeFakeFetch(opts: {
  sourceRecords: Array<Record<string, unknown>>;
  /** Per-method+url, the response to return. */
  targetResponses: {
    insert?: Array<{ id?: string; success: boolean; created?: boolean; errors?: unknown[] }>;
    upsert?: Array<{ id?: string; success: boolean; created?: boolean; errors?: unknown[] }>;
  };
  calls: Array<{ method: string; url: string; body?: unknown }>;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
    opts.calls.push({ method, url, body });

    // Source queries. Distinguish "SELECT Id FROM <root>" (root-scope
     // probe, returns just IDs) from the full-field extract (returns
     // the full records). The Id-only query has no comma in its field
     // list; the full extract always has at least one comma (Id, <other
     // field>...). This is robust across object names — we used to
     // hardcode "Contact" and it broke the first time a custom object
     // showed up in a test.
    if (url.includes("/query?q=")) {
      const isIdOnly = !url.includes("%2C") && !url.includes(",");
      if (isIdOnly) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            done: true,
            records: opts.sourceRecords.map((r) => ({ Id: r.Id })),
          }),
        } as unknown as Response;
      }
      // full-field select
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          done: true,
          records: opts.sourceRecords,
        }),
      } as unknown as Response;
    }

    // Target upsert
    if (method === "PATCH" && url.includes("/composite/sobjects/Contact/SSN__c")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => opts.targetResponses.upsert ?? [],
      } as unknown as Response;
    }

    // Target insert
    if (method === "POST" && url.endsWith("/composite/sobjects")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => opts.targetResponses.insert ?? [],
      } as unknown as Response;
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe("runExecute — UPSERT routing", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "upsert-exec-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("routes records with a populated ext-id through PATCH composite/sobjects/<obj>/<field>", async () => {
    const sourceRecords = [
      { Id: "003SRC000000001AAA", LastName: "Alice", SSN__c: "111-11-1111" },
      { Id: "003SRC000000002AAA", LastName: "Bob", SSN__c: "222-22-2222" },
    ];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = makeFakeFetch({
      sourceRecords,
      targetResponses: {
        upsert: [
          { id: "003TGT000000001AAA", success: true, created: true },
          { id: "003TGT000000002AAA", success: true, created: false }, // matched — still maps
        ],
      },
      calls,
    });

    const desc = fakeDescribeClient({ Contact: mkContactDescribe() });

    const result = await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkGraph(),
      rootObject: "Contact",
      whereClause: "Id != null",
      finalObjectList: ["Contact"],
      loadPlan: mkLoadPlan(),
      sessionDir: tmp,
      fetchFn,
      upsertDecisions: {
        Contact: { kind: "picked", field: "SSN__c" },
      },
    });

    // All 2 records went through UPSERT. No INSERT call should have been made.
    const upsertCalls = calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/composite/sobjects/Contact/SSN__c"),
    );
    const insertCalls = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/composite/sobjects"),
    );
    expect(upsertCalls.length).toBe(1);
    expect(insertCalls.length).toBe(0);

    // UPSERT body must contain the ext-id field for every record.
    const upsertBody = upsertCalls[0].body as { records: Array<Record<string, unknown>> };
    expect(upsertBody.records).toHaveLength(2);
    expect(upsertBody.records[0].SSN__c).toBe("111-11-1111");
    expect(upsertBody.records[1].SSN__c).toBe("222-22-2222");
    // Records must NOT contain Id on upsert — Salesforce rejects that.
    expect(upsertBody.records[0].Id).toBeUndefined();

    // Both matched and created rows should populate the id-map identically.
    expect(result.insertedCounts.Contact).toBe(2);
    expect(result.errorCount).toBe(0);

    const idMapJson = JSON.parse(
      await readFile(join(tmp, "id-map.json"), "utf8"),
    ) as Record<string, string>;
    expect(idMapJson["Contact:003SRC000000001AAA"]).toBe("003TGT000000001AAA");
    expect(idMapJson["Contact:003SRC000000002AAA"]).toBe("003TGT000000002AAA");
  });

  it("splits a mixed batch: populated ext-id → UPSERT, blank → INSERT", async () => {
    const sourceRecords = [
      { Id: "003SRC000000001AAA", LastName: "Alice", SSN__c: "111-11-1111" },
      { Id: "003SRC000000002AAA", LastName: "Bob", SSN__c: null }, // no ext-id
      { Id: "003SRC000000003AAA", LastName: "Carol", SSN__c: "" }, // empty ext-id
    ];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = makeFakeFetch({
      sourceRecords,
      targetResponses: {
        upsert: [{ id: "003TGT000000001AAA", success: true, created: true }],
        insert: [
          { id: "003TGT000000002AAA", success: true },
          { id: "003TGT000000003AAA", success: true },
        ],
      },
      calls,
    });

    const desc = fakeDescribeClient({ Contact: mkContactDescribe() });

    await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkGraph(),
      rootObject: "Contact",
      whereClause: "Id != null",
      finalObjectList: ["Contact"],
      loadPlan: mkLoadPlan(),
      sessionDir: tmp,
      fetchFn,
      upsertDecisions: {
        Contact: { kind: "picked", field: "SSN__c" },
      },
    });

    const upsertCalls = calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/composite/sobjects/Contact/SSN__c"),
    );
    const insertCalls = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/composite/sobjects"),
    );
    expect(upsertCalls.length).toBe(1);
    expect(insertCalls.length).toBe(1);

    const upsertBody = upsertCalls[0].body as { records: Array<Record<string, unknown>> };
    const insertBody = insertCalls[0].body as { records: Array<Record<string, unknown>> };
    expect(upsertBody.records).toHaveLength(1);
    expect(upsertBody.records[0].LastName).toBe("Alice");
    expect(insertBody.records).toHaveLength(2);
    // The blank-SSN records made it through INSERT with LastName intact.
    const insertedLastNames = insertBody.records.map((r) => r.LastName);
    expect(insertedLastNames).toEqual(expect.arrayContaining(["Bob", "Carol"]));

    const idMapJson = JSON.parse(
      await readFile(join(tmp, "id-map.json"), "utf8"),
    ) as Record<string, string>;
    expect(idMapJson["Contact:003SRC000000001AAA"]).toBe("003TGT000000001AAA");
    expect(idMapJson["Contact:003SRC000000002AAA"]).toBe("003TGT000000002AAA");
    expect(idMapJson["Contact:003SRC000000003AAA"]).toBe("003TGT000000003AAA");
  });

  it("uses INSERT for every record when no upsert decision is picked (pre-upsert behavior)", async () => {
    const sourceRecords = [
      { Id: "003SRC000000001AAA", LastName: "Alice", SSN__c: "111-11-1111" },
    ];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = makeFakeFetch({
      sourceRecords,
      targetResponses: {
        insert: [{ id: "003TGT000000001AAA", success: true }],
      },
      calls,
    });

    const desc = fakeDescribeClient({ Contact: mkContactDescribe() });

    await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkGraph(),
      rootObject: "Contact",
      whereClause: "Id != null",
      finalObjectList: ["Contact"],
      loadPlan: mkLoadPlan(),
      sessionDir: tmp,
      fetchFn,
      // Ambiguous decision — should fall through to INSERT. This exercises
      // the "strictly not worse than today" guarantee: the duplicate errors
      // on re-run are still possible, but we do nothing DIFFERENT from
      // pre-upsert-shipped behavior.
      upsertDecisions: {
        Contact: {
          kind: "ambiguous",
          reason: "multiple-candidates",
          detail: "test",
          candidates: ["SSN__c", "LegacyId__c"],
        },
      },
    });

    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("SSN__c"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/composite/sobjects"))).toBe(true);
  });

  it("uses INSERT when upsertDecisions is omitted entirely (backward compatibility)", async () => {
    const sourceRecords = [
      { Id: "003SRC000000001AAA", LastName: "Alice", SSN__c: "111-11-1111" },
    ];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = makeFakeFetch({
      sourceRecords,
      targetResponses: {
        insert: [{ id: "003TGT000000001AAA", success: true }],
      },
      calls,
    });

    const desc = fakeDescribeClient({ Contact: mkContactDescribe() });

    await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkGraph(),
      rootObject: "Contact",
      whereClause: "Id != null",
      finalObjectList: ["Contact"],
      loadPlan: mkLoadPlan(),
      sessionDir: tmp,
      fetchFn,
      // No upsertDecisions passed at all.
    });

    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("SSN__c"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/composite/sobjects"))).toBe(true);
  });
});

/**
 * Regression: custom-object `Name` fields have `defaultedOnCreate: true`
 * on the describe (Salesforce would apply a default if you omit Name).
 * An earlier cut of `pickCreateableFields` filtered on
 * `defaultedOnCreate === true` and stripped Name from the insert body,
 * causing every seeded custom-object row to land with Name=null. The
 * Lightning UI then falls back to displaying the raw 15-char Record ID
 * in list views ("aACVB000000AaTd" instead of "Acme College
 * Application"). Caught live against traa_Application_Template__c.
 *
 * This test locks the invariant: if the source record has a Name and
 * the target has a createable Name field, the Name value MUST appear in
 * the insert body — regardless of `defaultedOnCreate`.
 */
describe("runExecute — Name-field preservation on custom objects", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "name-field-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function mkCustomObjectDescribe(): SObjectDescribe {
    return {
      name: "traa_Application_Template__c",
      label: "Application Template",
      custom: true,
      queryable: true,
      createable: true,
      fields: [
        {
          name: "Id",
          label: "Id",
          type: "id",
          nillable: false,
          custom: false,
          createable: false,
          updateable: false,
          calculated: false,
          defaultedOnCreate: false,
          externalId: false,
          unique: false,
          idLookup: true,
          autoNumber: false,
        },
        {
          // The field that used to get silently stripped. Shape copied
          // from the live Acme describe that produced the bug.
          name: "Name",
          label: "Application Template Name",
          type: "string",
          nillable: true,
          custom: false,
          createable: true,
          updateable: true,
          calculated: false,
          defaultedOnCreate: true,
          externalId: false,
          unique: false,
          idLookup: true,
          autoNumber: false,
        },
      ],
      childRelationships: [],
      recordTypeInfos: [],
    };
  }

  function mkCustomGraph(): DependencyGraph {
    return {
      nodes: new Map([
        [
          "traa_Application_Template__c",
          {
            label: "Application Template",
            custom: true,
            isStandardRoot: false,
            described: true,
            role: "root" as const,
            distanceFromRoot: 0,
            requiredFields: [],
            sensitiveFields: [],
            droppedFieldCounts: { formula: 0, audit: 0, nonCreateable: 0 },
            totalFieldCount: 2,
            rowCount: null,
          },
        ],
      ]),
      edges: [],
    };
  }

  function mkCustomLoadPlan(): LoadPlan {
    return {
      steps: [{ kind: "single", object: "traa_Application_Template__c" }],
      excluded: [],
    };
  }

  it("includes Name in the insert body even when defaultedOnCreate=true", async () => {
    const sourceRecords = [
      {
        Id: "aACVB000000AaTdAAA",
        Name: "Demo Enrollment Application",
      },
      {
        Id: "aACVB000000AaTeAAA",
        Name: "Non-matriculated Demo Application",
      },
    ];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = makeFakeFetch({
      sourceRecords,
      targetResponses: {
        insert: [
          { id: "aACTGT00000001AAAAA", success: true },
          { id: "aACTGT00000002AAAAA", success: true },
        ],
      },
      calls,
    });

    const desc = fakeDescribeClient({
      traa_Application_Template__c: mkCustomObjectDescribe(),
    });

    await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkCustomGraph(),
      rootObject: "traa_Application_Template__c",
      whereClause: "Id != null",
      finalObjectList: ["traa_Application_Template__c"],
      loadPlan: mkCustomLoadPlan(),
      sessionDir: tmp,
      fetchFn,
    });

    const insertCalls = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/composite/sobjects"),
    );
    expect(insertCalls.length).toBe(1);

    const body = insertCalls[0].body as { records: Array<Record<string, unknown>> };
    expect(body.records).toHaveLength(2);

    // THE regression check: Name must survive pickCreateableFields and
    // land in the insert body with the source value intact.
    expect(body.records[0].Name).toBe("Demo Enrollment Application");
    expect(body.records[1].Name).toBe("Non-matriculated Demo Application");

    // And the Name key must literally be present (not undefined) — an
    // absent key would let Salesforce apply its empty default and
    // reproduce the Record-ID-in-list-view bug.
    expect(Object.prototype.hasOwnProperty.call(body.records[0], "Name")).toBe(true);
  });
});
