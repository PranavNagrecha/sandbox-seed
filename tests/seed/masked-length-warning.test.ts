import { describe, expect, it } from "vitest";
import type { Field, SObjectDescribe } from "../../src/describe/types.ts";
import { _maskedLengthWarnings } from "../../src/seed/dry-run.ts";

/**
 * Dry-run warning for masked fields that are SHORTER on the target than
 * on the source (T14 finding 6). The run clamps mask generation to
 * min(source, target) — this warning makes the cap visible in the
 * report before anything inserts. Names and lengths only, no values.
 */

function field(name: string, length?: number): Field {
  return {
    name,
    type: "string",
    nillable: true,
    custom: false,
    createable: true,
    ...(length !== undefined ? { length } : {}),
  } as Field;
}

function describeWith(fields: Field[]): SObjectDescribe {
  return {
    name: "Contact",
    label: "Contact",
    custom: false,
    queryable: true,
    createable: true,
    fields,
    childRelationships: [],
  };
}

describe("maskedLengthWarnings", () => {
  it("warns for a masked field whose target length is shorter", () => {
    const src = describeWith([field("Postal__c", 60), field("Email", 80)]);
    const tgt = describeWith([field("Postal__c", 9), field("Email", 80)]);

    const warnings = _maskedLengthWarnings("Contact", src, tgt, ["Postal__c", "Email"]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Contact.Postal__c");
    expect(warnings[0]).toContain("capped to the target field length 9");
    expect(warnings[0]).toContain("source is 60");
  });

  it("does not warn for unmasked fields even when shorter on target", () => {
    const src = describeWith([field("Postal__c", 60)]);
    const tgt = describeWith([field("Postal__c", 9)]);

    expect(_maskedLengthWarnings("Contact", src, tgt, [])).toEqual([]);
    expect(_maskedLengthWarnings("Contact", src, tgt, undefined)).toEqual([]);
  });

  it("ignores equal/longer targets, missing fields, and absent lengths", () => {
    const src = describeWith([
      field("Equal__c", 20),
      field("Longer__c", 10),
      field("NoLen__c"),
      field("SourceOnly__c", 30),
    ]);
    const tgt = describeWith([field("Equal__c", 20), field("Longer__c", 40), field("NoLen__c")]);

    expect(
      _maskedLengthWarnings("Contact", src, tgt, [
        "Equal__c",
        "Longer__c",
        "NoLen__c",
        "SourceOnly__c",
      ]),
    ).toEqual([]);
  });
});
