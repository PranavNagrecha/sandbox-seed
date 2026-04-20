import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepopulateStandardRootMappings } from "../../src/seed/execute.ts";
import { IdMap } from "../../src/seed/id-map.ts";
import type { DescribeClient } from "../../src/describe/client.ts";
import type { SObjectDescribe } from "../../src/describe/types.ts";

/**
 * RecordType DeveloperName mapping — the real fix for the first live-run
 * failure.
 *
 * Live symptom on Acme: every Account + Contact insert failed with
 * INVALID_CROSS_REFERENCE_KEY on RecordTypeId. Root cause: source RT
 * IDs don't exist on the target org. The fix is to match by
 * DeveloperName across describes and pre-populate the id-map so
 * rewriteRecordForTarget swaps source RT IDs for target RT IDs during
 * insert.
 */

function describeWithRTs(
  object: string,
  rts: Array<{ developerName: string; recordTypeId: string }>,
): SObjectDescribe {
  return {
    name: object,
    label: object,
    custom: false,
    queryable: true,
    createable: true,
    fields: [],
    childRelationships: [],
    recordTypeInfos: rts.map((r) => ({
      developerName: r.developerName,
      name: r.developerName,
      recordTypeId: r.recordTypeId,
      active: true,
      master: false,
    })),
  };
}

function fakeClient(by: Record<string, SObjectDescribe>): DescribeClient {
  return {
    describeObject: async (name: string) => {
      const d = by[name];
      if (d === undefined) throw new Error(`no describe for ${name}`);
      return d;
    },
  } as unknown as DescribeClient;
}

describe("prepopulateStandardRootMappings: RecordType by DeveloperName", () => {
  let tmp: string;
  let mapPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "rt-map-"));
    mapPath = join(tmp, "id-map.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("maps source RT IDs to target RT IDs by matching DeveloperName", async () => {
    const source = fakeClient({
      Account: describeWithRTs("Account", [
        { developerName: "Business_Account", recordTypeId: "012SRC000000001AAA" },
        { developerName: "Person_Account", recordTypeId: "012SRC000000002AAA" },
      ]),
    });
    const target = fakeClient({
      Account: describeWithRTs("Account", [
        { developerName: "Business_Account", recordTypeId: "012TGT000000001AAA" },
        { developerName: "Person_Account", recordTypeId: "012TGT000000002AAA" },
      ]),
    });

    const idMap = new IdMap(mapPath);
    await idMap.load();

    const res = await prepopulateStandardRootMappings({
      objects: ["Account"],
      sourceDescribe: source,
      targetDescribe: target,
      idMap,
    });

    expect(res.mappedCount).toBe(2);
    expect(idMap.get("RecordType", "012SRC000000001AAA")).toBe("012TGT000000001AAA");
    expect(idMap.get("RecordType", "012SRC000000002AAA")).toBe("012TGT000000002AAA");
  });

  it("leaves unmatched source RTs in the unmapped list", async () => {
    const source = fakeClient({
      Account: describeWithRTs("Account", [
        { developerName: "Business_Account", recordTypeId: "012SRC000000001AAA" },
        { developerName: "Partner_Account", recordTypeId: "012SRC000000003AAA" }, // target lacks this
      ]),
    });
    const target = fakeClient({
      Account: describeWithRTs("Account", [
        { developerName: "Business_Account", recordTypeId: "012TGT000000001AAA" },
      ]),
    });

    const idMap = new IdMap(mapPath);
    const res = await prepopulateStandardRootMappings({
      objects: ["Account"],
      sourceDescribe: source,
      targetDescribe: target,
      idMap,
    });

    expect(res.mappedCount).toBe(1);
    expect(res.unmappedByObject).toEqual({ Account: ["Partner_Account"] });
    expect(idMap.get("RecordType", "012SRC000000001AAA")).toBe("012TGT000000001AAA");
    expect(idMap.get("RecordType", "012SRC000000003AAA")).toBeUndefined();
  });

  it("skips objects with no recordTypeInfos on either side", async () => {
    const source = fakeClient({
      CaseComment: describeWithRTs("CaseComment", []),
    });
    const target = fakeClient({
      CaseComment: describeWithRTs("CaseComment", []),
    });

    const idMap = new IdMap(mapPath);
    const res = await prepopulateStandardRootMappings({
      objects: ["CaseComment"],
      sourceDescribe: source,
      targetDescribe: target,
      idMap,
    });

    expect(res.mappedCount).toBe(0);
  });

  it("processes multiple objects in one pass", async () => {
    const source = fakeClient({
      Account: describeWithRTs("Account", [
        { developerName: "Biz", recordTypeId: "012SRC000000001AAA" },
      ]),
      Case: describeWithRTs("Case", [
        { developerName: "Support", recordTypeId: "012SRC000000010AAA" },
      ]),
    });
    const target = fakeClient({
      Account: describeWithRTs("Account", [
        { developerName: "Biz", recordTypeId: "012TGT000000001AAA" },
      ]),
      Case: describeWithRTs("Case", [
        { developerName: "Support", recordTypeId: "012TGT000000010AAA" },
      ]),
    });

    const idMap = new IdMap(mapPath);
    const res = await prepopulateStandardRootMappings({
      objects: ["Account", "Case"],
      sourceDescribe: source,
      targetDescribe: target,
      idMap,
    });

    expect(res.mappedCount).toBe(2);
    expect(idMap.get("RecordType", "012SRC000000001AAA")).toBe("012TGT000000001AAA");
    expect(idMap.get("RecordType", "012SRC000000010AAA")).toBe("012TGT000000010AAA");
  });

  it("tolerates a describe failure on one object and continues with the rest", async () => {
    const source: DescribeClient = {
      describeObject: async (name: string) => {
        if (name === "BrokenObject__c") throw new Error("describe failed");
        return describeWithRTs("Account", [
          { developerName: "Biz", recordTypeId: "012SRC000000001AAA" },
        ]);
      },
    } as unknown as DescribeClient;
    const target = fakeClient({
      Account: describeWithRTs("Account", [
        { developerName: "Biz", recordTypeId: "012TGT000000001AAA" },
      ]),
    });

    const idMap = new IdMap(mapPath);
    const res = await prepopulateStandardRootMappings({
      objects: ["BrokenObject__c", "Account"],
      sourceDescribe: source,
      targetDescribe: target,
      idMap,
    });

    expect(res.mappedCount).toBe(1);
    expect(idMap.get("RecordType", "012SRC000000001AAA")).toBe("012TGT000000001AAA");
  });
});
