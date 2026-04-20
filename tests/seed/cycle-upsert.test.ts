import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import type { DescribeClient } from "../../src/describe/client.ts";
import type { SObjectDescribe } from "../../src/describe/types.ts";
import type { DependencyGraph } from "../../src/graph/build.ts";
import type { LoadPlan } from "../../src/graph/order.ts";
import { runExecute } from "../../src/seed/execute.ts";

/**
 * Regression lock-in: cycle objects must honor `upsertDecisions`.
 *
 * Live incident: a re-run against a non-empty target sandbox failed 66/100
 * Application rows with DUPLICATE_VALUE on Service_Item_ID__c. The
 * dry-run report promised UPSERT; `seedSingle` honored that, but
 * `seedCycle` silently did INSERT for every row — Applications were in
 * a cycle SCC with Contact/Account via a self-reference, so they were
 * routed through the cycle path and never saw the upsert-key decision.
 *
 * Additional invariant: on the UPSERT path, the break-edge field must
 * be OMITTED from the body (not set to null). Nulling it would overwrite
 * the live FK on any row that matched an existing target. Phase 2 still
 * backfills the FK from the id-map afterward.
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

function mkAccountDescribe(): SObjectDescribe {
  return {
    name: "Account",
    label: "Account",
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
        name: "Name",
        label: "Name",
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
        name: "ExternalId__c",
        label: "External Id",
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
      // The break edge: a self-reference / parent FK that's nillable so
      // the cycle is walkable. Shape mirrors Account.PrimaryContactId in
      // the live Acme schema that produced the incident.
      {
        name: "PrimaryContactId",
        label: "Primary Contact",
        type: "reference",
        nillable: true,
        custom: false,
        createable: true,
        updateable: true,
        calculated: false,
        defaultedOnCreate: false,
        externalId: false,
        unique: false,
        idLookup: false,
        autoNumber: false,
        referenceTo: ["Contact"],
        relationshipName: "PrimaryContact",
      },
    ],
    childRelationships: [],
    recordTypeInfos: [],
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
        name: "AccountId",
        label: "Account",
        type: "reference",
        nillable: true,
        custom: false,
        createable: true,
        updateable: true,
        calculated: false,
        defaultedOnCreate: false,
        externalId: false,
        unique: false,
        idLookup: false,
        autoNumber: false,
        referenceTo: ["Account"],
        relationshipName: "Account",
      },
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
  // Account ↔ Contact cycle. Account is root; Contact is a direct-child
  // via AccountId; Account points back at Contact via PrimaryContactId
  // (the breakable edge — nillable).
  return {
    nodes: new Map([
      [
        "Account",
        {
          label: "Account",
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
      [
        "Contact",
        {
          label: "Contact",
          custom: false,
          isStandardRoot: false,
          described: true,
          role: "child" as const,
          distanceFromRoot: 1,
          requiredFields: [],
          sensitiveFields: [],
          droppedFieldCounts: { formula: 0, audit: 0, nonCreateable: 0 },
          totalFieldCount: 3,
          rowCount: null,
        },
      ],
    ]),
    edges: [
      {
        source: "Contact",
        target: "Account",
        fieldName: "AccountId",
        nillable: true,
        custom: false,
        polymorphic: false,
        masterDetail: false,
        kind: "parent",
      },
      {
        source: "Account",
        target: "Contact",
        fieldName: "PrimaryContactId",
        nillable: true,
        custom: false,
        polymorphic: false,
        masterDetail: false,
        kind: "child",
      },
    ],
  };
}

function mkCycleLoadPlan(): LoadPlan {
  return {
    steps: [
      {
        kind: "cycle",
        objects: ["Account", "Contact"],
        breakEdge: {
          source: "Account",
          target: "Contact",
          fieldName: "PrimaryContactId",
        },
        internalEdges: [
          {
            source: "Contact",
            target: "Account",
            fieldName: "AccountId",
            nillable: true,
          },
          {
            source: "Account",
            target: "Contact",
            fieldName: "PrimaryContactId",
            nillable: true,
          },
        ],
      },
    ],
    excluded: [],
    cycles: [],
  };
}

/**
 * Route fake HTTP. Source /query gets synthetic records for both
 * Account and Contact; target gets composite endpoints keyed on
 * method + URL.
 */
function makeFakeFetch(opts: {
  sourceByObject: Record<string, Array<Record<string, unknown>>>;
  targetResponses: {
    insertByObject?: Record<
      string,
      Array<{ id?: string; success: boolean; created?: boolean; errors?: unknown[] }>
    >;
    upsertByObject?: Record<
      string,
      Array<{ id?: string; success: boolean; created?: boolean; errors?: unknown[] }>
    >;
  };
  calls: Array<{ method: string; url: string; body?: unknown }>;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
    opts.calls.push({ method, url, body });

    if (url.includes("/query?q=")) {
      // Guess which object from the URL (decoded). Falls back to Account
      // records on the root-scope probe.
      const decoded = decodeURIComponent(url);
      let records: Array<Record<string, unknown>> = [];
      for (const [obj, rows] of Object.entries(opts.sourceByObject)) {
        if (decoded.includes(`FROM ${obj}`)) {
          records = rows;
          break;
        }
      }
      // Id-only root probe: strip non-Id fields.
      const isIdOnly = !url.includes("%2C") && !url.includes(",");
      if (isIdOnly) {
        records = records.map((r) => ({ Id: r.Id }));
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ done: true, records }),
      } as unknown as Response;
    }

    // Composite UPSERT: /composite/sobjects/<Object>/<ExtIdField>
    const upsertMatch = url.match(/\/composite\/sobjects\/([^/]+)\/([^/?]+)/);
    if (method === "PATCH" && upsertMatch !== null) {
      const object = decodeURIComponent(upsertMatch[1]);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => opts.targetResponses.upsertByObject?.[object] ?? [],
      } as unknown as Response;
    }

    if (method === "POST" && url.endsWith("/composite/sobjects")) {
      const type = (body as { records?: Array<{ attributes?: { type?: string } }> })?.records?.[0]
        ?.attributes?.type;
      const object = typeof type === "string" ? type : "";
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => opts.targetResponses.insertByObject?.[object] ?? [],
      } as unknown as Response;
    }

    // PATCH /sobjects/<Object>/<Id> — phase 2 backfill. 204.
    if (method === "PATCH" && url.includes("/sobjects/")) {
      return {
        ok: true,
        status: 204,
        statusText: "No Content",
        text: async () => "",
      } as unknown as Response;
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe("runExecute — cycle-step UPSERT routing", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "cycle-upsert-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("routes cycle objects with picked upsert-decisions through composite UPSERT", async () => {
    const accountRecords = [
      {
        Id: "001SRC000000001AAA",
        Name: "Acme Corp",
        ExternalId__c: "ACME-1",
        PrimaryContactId: "003SRC000000001AAA",
      },
      {
        Id: "001SRC000000002AAA",
        Name: "Beta Inc",
        ExternalId__c: "BETA-1",
        PrimaryContactId: null,
      },
    ];
    const contactRecords = [
      {
        Id: "003SRC000000001AAA",
        LastName: "Primary",
        AccountId: "001SRC000000001AAA",
      },
    ];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = makeFakeFetch({
      sourceByObject: { Account: accountRecords, Contact: contactRecords },
      targetResponses: {
        upsertByObject: {
          Account: [
            { id: "001TGT000000001AAA", success: true, created: true },
            { id: "001TGT000000002AAA", success: true, created: false }, // matched
          ],
        },
        insertByObject: {
          Contact: [{ id: "003TGT000000001AAA", success: true }],
        },
      },
      calls,
    });

    const desc = fakeDescribeClient({
      Account: mkAccountDescribe(),
      Contact: mkContactDescribe(),
    });

    const result = await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkGraph(),
      rootObject: "Account",
      whereClause: "Id != null",
      finalObjectList: ["Account", "Contact"],
      loadPlan: mkCycleLoadPlan(),
      sessionDir: tmp,
      fetchFn,
      upsertDecisions: {
        Account: { kind: "picked", field: "ExternalId__c" },
      },
    });

    const accountUpsertCalls = calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/composite/sobjects/Account/ExternalId__c"),
    );
    expect(accountUpsertCalls.length).toBe(1);

    const upsertBody = accountUpsertCalls[0].body as {
      records: Array<Record<string, unknown>>;
    };
    expect(upsertBody.records).toHaveLength(2);

    // THE core invariant: the break-field (PrimaryContactId) must be
    // OMITTED from the UPSERT body so matched existing rows keep their
    // live FK. Sending null would overwrite it.
    for (const rec of upsertBody.records) {
      expect(Object.prototype.hasOwnProperty.call(rec, "PrimaryContactId")).toBe(false);
    }
    // ExternalId__c must be present for the upsert to match.
    expect(upsertBody.records[0].ExternalId__c).toBe("ACME-1");
    expect(upsertBody.records[1].ExternalId__c).toBe("BETA-1");

    // id-map stores target Ids for both created and matched rows with
    // identical semantics.
    const idMapJson = JSON.parse(await readFile(join(tmp, "id-map.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(idMapJson["Account:001SRC000000001AAA"]).toBe("001TGT000000001AAA");
    expect(idMapJson["Account:001SRC000000002AAA"]).toBe("001TGT000000002AAA");

    expect(result.insertedCounts.Account).toBe(2);
    expect(result.errorCount).toBe(0);
  });

  it("falls back to INSERT on cycle objects when no upsert decision is provided (pre-fix behavior)", async () => {
    const accountRecords = [
      {
        Id: "001SRC000000001AAA",
        Name: "Acme Corp",
        ExternalId__c: "ACME-1",
        PrimaryContactId: null,
      },
    ];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = makeFakeFetch({
      sourceByObject: { Account: accountRecords, Contact: [] },
      targetResponses: {
        insertByObject: {
          Account: [{ id: "001TGT000000001AAA", success: true }],
        },
      },
      calls,
    });

    const desc = fakeDescribeClient({
      Account: mkAccountDescribe(),
      Contact: mkContactDescribe(),
    });

    await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkGraph(),
      rootObject: "Account",
      whereClause: "Id != null",
      finalObjectList: ["Account", "Contact"],
      loadPlan: mkCycleLoadPlan(),
      sessionDir: tmp,
      fetchFn,
      // No upsertDecisions — cycle path must do plain INSERT, identical
      // to behavior before this fix.
    });

    const upsertCalls = calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/composite/sobjects/"),
    );
    const insertCalls = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/composite/sobjects"),
    );
    expect(upsertCalls.length).toBe(0);
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);

    // On the INSERT path, the break-field MUST be present and null so
    // Salesforce accepts the row before the sibling exists; phase 2
    // backfills.
    const accountInsert = insertCalls.find((c) => {
      const b = c.body as { records?: Array<{ attributes?: { type?: string } }> };
      return b.records?.[0]?.attributes?.type === "Account";
    });
    expect(accountInsert).toBeDefined();
    const accountBody = accountInsert?.body as { records: Array<Record<string, unknown>> };
    expect(accountBody.records[0].PrimaryContactId).toBeNull();
  });

  it("splits a cycle batch: populated ext-id → UPSERT, blank → INSERT", async () => {
    const accountRecords = [
      {
        Id: "001SRC000000001AAA",
        Name: "With Ext Id",
        ExternalId__c: "ACME-1",
        PrimaryContactId: null,
      },
      {
        Id: "001SRC000000002AAA",
        Name: "Blank Ext Id",
        ExternalId__c: null,
        PrimaryContactId: null,
      },
    ];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchFn = makeFakeFetch({
      sourceByObject: { Account: accountRecords, Contact: [] },
      targetResponses: {
        upsertByObject: {
          Account: [{ id: "001TGT000000001AAA", success: true, created: true }],
        },
        insertByObject: {
          Account: [{ id: "001TGT000000002AAA", success: true }],
        },
      },
      calls,
    });

    const desc = fakeDescribeClient({
      Account: mkAccountDescribe(),
      Contact: mkContactDescribe(),
    });

    await runExecute({
      sourceAuth: mkAuth("src"),
      targetAuth: mkAuth("tgt"),
      sourceDescribe: desc,
      targetDescribe: desc,
      graph: mkGraph(),
      rootObject: "Account",
      whereClause: "Id != null",
      finalObjectList: ["Account", "Contact"],
      loadPlan: mkCycleLoadPlan(),
      sessionDir: tmp,
      fetchFn,
      upsertDecisions: {
        Account: { kind: "picked", field: "ExternalId__c" },
      },
    });

    const upsertCalls = calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/composite/sobjects/Account/ExternalId__c"),
    );
    const accountInsertCalls = calls.filter((c) => {
      if (c.method !== "POST") return false;
      if (!c.url.endsWith("/composite/sobjects")) return false;
      const b = c.body as { records?: Array<{ attributes?: { type?: string } }> };
      return b.records?.[0]?.attributes?.type === "Account";
    });
    expect(upsertCalls.length).toBe(1);
    expect(accountInsertCalls.length).toBe(1);

    const upsertBody = upsertCalls[0].body as { records: Array<Record<string, unknown>> };
    const insertBody = accountInsertCalls[0].body as {
      records: Array<Record<string, unknown>>;
    };
    expect(upsertBody.records).toHaveLength(1);
    expect(upsertBody.records[0].Name).toBe("With Ext Id");
    // Upsert row: break-field omitted entirely.
    expect(Object.prototype.hasOwnProperty.call(upsertBody.records[0], "PrimaryContactId")).toBe(
      false,
    );

    expect(insertBody.records).toHaveLength(1);
    expect(insertBody.records[0].Name).toBe("Blank Ext Id");
    // Insert row: break-field present and null.
    expect(insertBody.records[0].PrimaryContactId).toBeNull();

    const idMapJson = JSON.parse(await readFile(join(tmp, "id-map.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(idMapJson["Account:001SRC000000001AAA"]).toBe("001TGT000000001AAA");
    expect(idMapJson["Account:001SRC000000002AAA"]).toBe("001TGT000000002AAA");
  });
});
