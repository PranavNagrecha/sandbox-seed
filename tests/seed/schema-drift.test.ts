import { describe, expect, it } from "vitest";
import type { DescribeClient } from "../../src/describe/client.ts";
import type { Field, SObjectDescribe } from "../../src/describe/types.ts";
import { intersectWithTargetFields } from "../../src/seed/execute.ts";

/**
 * Schema-drift auto-ignore: when the source has a createable field the
 * target org is missing, execute.ts drops it from the insert payload
 * instead of failing. This is the user's explicit requirement:
 *
 *   "When this happens we need to ignore these fields"
 *
 * (referring to Contact.CI_Primary_Location__c existing on source but
 * not target during live acceptance testing).
 */

function field(name: string, createable = true, length?: number): Field {
  return {
    name,
    type: "string",
    nillable: true,
    custom: false,
    createable,
    ...(length !== undefined ? { length } : {}),
  } as Field;
}

function describeWithFields(object: string, fields: Field[]): SObjectDescribe {
  return {
    name: object,
    label: object,
    custom: false,
    queryable: true,
    createable: true,
    fields,
    childRelationships: [],
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

describe("execute.intersectWithTargetFields: schema-drift auto-ignore", () => {
  it("drops source-only fields and reports them", async () => {
    const candidates = [
      field("Name"),
      field("Email"),
      field("CI_Primary_Location__c"), // source-only
    ];
    const targetDescribe = fakeClient({
      Contact: describeWithFields("Contact", [field("Name"), field("Email"), field("Id", false)]),
    });

    const { kept, dropped } = await intersectWithTargetFields({
      object: "Contact",
      candidates,
      targetDescribe,
    });

    expect(kept.map((f) => f.name).sort()).toEqual(["Email", "Name"]);
    expect(dropped).toEqual(["CI_Primary_Location__c"]);
  });

  it("keeps everything when source and target schemas agree", async () => {
    const candidates = [field("Name"), field("Industry")];
    const targetDescribe = fakeClient({
      Account: describeWithFields("Account", [
        field("Name"),
        field("Industry"),
        field("Id", false),
      ]),
    });

    const { kept, dropped } = await intersectWithTargetFields({
      object: "Account",
      candidates,
      targetDescribe,
    });

    expect(kept.map((f) => f.name).sort()).toEqual(["Industry", "Name"]);
    expect(dropped).toEqual([]);
  });

  it("falls back to keeping all candidates when target describe fails", async () => {
    // If the target doesn't know about the object at all, we don't pretend
    // we can filter — let the composite insert raise the real error.
    const candidates = [field("Name"), field("Custom__c")];
    const targetDescribe = {
      describeObject: async () => {
        throw new Error("NOT_FOUND");
      },
    } as unknown as DescribeClient;

    const { kept, dropped } = await intersectWithTargetFields({
      object: "WeirdObject__c",
      candidates,
      targetDescribe,
    });

    expect(kept.map((f) => f.name).sort()).toEqual(["Custom__c", "Name"]);
    expect(dropped).toEqual([]);
  });

  it("drops all when target has the object but no overlapping fields", async () => {
    const candidates = [field("OnlySrc__c")];
    const targetDescribe = fakeClient({
      Weird__c: describeWithFields("Weird__c", [field("OnlyTgt__c"), field("Id", false)]),
    });

    const { kept, dropped } = await intersectWithTargetFields({
      object: "Weird__c",
      candidates,
      targetDescribe,
    });

    expect(kept).toEqual([]);
    expect(dropped).toEqual(["OnlySrc__c"]);
  });

  it("clamps a kept field's length to the shorter target length (T14 finding 6)", async () => {
    // Mask presets cap generated values by Field.length. With the SOURCE
    // length, a masked value can overflow a drifted-shorter target field
    // and get truncated on insert — breaking deterministic re-derivation.
    const candidates = [field("Postal__c", true, 60), field("Name", true, 80)];
    const targetDescribe = fakeClient({
      Contact: describeWithFields("Contact", [
        field("Postal__c", true, 9), // target is SHORTER
        field("Name", true, 80), // equal — untouched
      ]),
    });

    const { kept, dropped, lengthClamped } = await intersectWithTargetFields({
      object: "Contact",
      candidates,
      targetDescribe,
    });

    expect(dropped).toEqual([]);
    expect(lengthClamped).toEqual(["Postal__c"]);
    expect(kept.find((f) => f.name === "Postal__c")?.length).toBe(9);
    expect(kept.find((f) => f.name === "Name")?.length).toBe(80);
  });

  it("leaves lengths alone when the target is longer or lengths are absent", async () => {
    const candidates = [field("Longer__c", true, 10), field("NoLength__c")];
    const targetDescribe = fakeClient({
      Contact: describeWithFields("Contact", [field("Longer__c", true, 40), field("NoLength__c")]),
    });

    const { kept, lengthClamped } = await intersectWithTargetFields({
      object: "Contact",
      candidates,
      targetDescribe,
    });

    expect(lengthClamped).toEqual([]);
    expect(kept.find((f) => f.name === "Longer__c")?.length).toBe(10);
    expect(kept.find((f) => f.name === "NoLength__c")?.length).toBeUndefined();
  });
});
