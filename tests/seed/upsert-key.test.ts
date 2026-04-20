import { describe, expect, it } from "vitest";
import {
  discoverCandidates,
  resolveUpsertKey,
} from "../../src/seed/upsert-key.ts";
import type { Field, SObjectDescribe } from "../../src/describe/types.ts";

/**
 * Upsert-key detection is the hinge of the duplicate-handling ship-block:
 * without a correct single-candidate rule we either do nothing (today's
 * DUPLICATE_VALUE errors on re-runs) or over-pick and silently rewrite
 * rows the user didn't want touched. These tests lock both behaviors:
 * every ambiguous shape has an explicit test, every positive shape has an
 * explicit test, and the target-verification pass is exercised separately
 * from the source-side discovery.
 */

function mkField(overrides: Partial<Field> & { name: string; type?: string }): Field {
  const base = {
    name: overrides.name,
    label: overrides.label ?? overrides.name,
    nillable: overrides.nillable ?? true,
    custom: overrides.custom ?? true,
    createable: overrides.createable ?? true,
    updateable: overrides.updateable ?? true,
    calculated: overrides.calculated ?? false,
    defaultedOnCreate: overrides.defaultedOnCreate ?? false,
    externalId: overrides.externalId ?? false,
    unique: overrides.unique ?? false,
    idLookup: overrides.idLookup ?? false,
    autoNumber: overrides.autoNumber ?? false,
  };
  const type = overrides.type ?? "string";
  if (type === "reference") {
    return {
      ...base,
      type: "reference",
      referenceTo: [],
      relationshipName: null,
    };
  }
  return { ...base, type };
}

function mkDescribe(name: string, fields: Field[]): SObjectDescribe {
  return {
    name,
    label: name,
    custom: name.endsWith("__c"),
    queryable: true,
    createable: true,
    fields,
  };
}

describe("discoverCandidates", () => {
  it("returns fields that are externalId + idLookup + createable + !autoNumber + !calculated", () => {
    const d = mkDescribe("Contact", [
      mkField({
        name: "SSN__c",
        externalId: true,
        idLookup: true,
        createable: true,
      }),
      mkField({ name: "Name" }), // plain field — not a candidate
      mkField({
        name: "CaseNumber",
        externalId: true,
        idLookup: true,
        createable: true,
        autoNumber: true, // excluded
      }),
      mkField({
        name: "LegacyKey__c",
        externalId: true,
        idLookup: true,
        createable: false, // not createable → excluded
      }),
      mkField({
        name: "ComputedKey__c",
        externalId: true,
        idLookup: true,
        createable: true,
        calculated: true, // excluded
      }),
      mkField({
        name: "FlaggedButNotLookupable__c",
        externalId: true,
        idLookup: false, // excluded
        createable: true,
      }),
    ]);

    const result = discoverCandidates(d);
    expect(result.map((c) => c.name)).toEqual(["SSN__c"]);
  });

  it("returns zero candidates when no field has both externalId and idLookup", () => {
    const d = mkDescribe("Account", [
      mkField({ name: "Name" }),
      mkField({ name: "Phone" }),
    ]);
    expect(discoverCandidates(d)).toEqual([]);
  });

  it("returns multiple candidates in describe order", () => {
    const d = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
      mkField({ name: "SSN__c", externalId: true, idLookup: true }),
      mkField({ name: "LegacyId__c", externalId: true, idLookup: true }),
    ]);
    const result = discoverCandidates(d);
    expect(result.map((c) => c.name)).toEqual([
      "EmailExtId__c",
      "SSN__c",
      "LegacyId__c",
    ]);
  });
});

describe("resolveUpsertKey", () => {
  it("picks the single candidate when target has the same field with matching flags", () => {
    const srcField = mkField({
      name: "SSN__c",
      externalId: true,
      idLookup: true,
      createable: true,
    });
    const src = mkDescribe("Contact", [srcField, mkField({ name: "Name" })]);
    const tgt = mkDescribe("Contact", [
      { ...srcField },
      mkField({ name: "Name" }),
    ]);

    const decision = resolveUpsertKey(src, tgt);
    expect(decision).toEqual({ kind: "picked", field: "SSN__c" });
  });

  it("returns no-candidates when source has zero eligible fields", () => {
    const src = mkDescribe("Account", [mkField({ name: "Name" })]);
    const tgt = mkDescribe("Account", [mkField({ name: "Name" })]);
    const decision = resolveUpsertKey(src, tgt);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("no-candidates");
    }
  });

  it("returns multiple-candidates when source has 2+ eligible fields", () => {
    const src = mkDescribe("Contact", [
      mkField({ name: "SSN__c", externalId: true, idLookup: true }),
      mkField({ name: "LegacyId__c", externalId: true, idLookup: true }),
    ]);
    const tgt = mkDescribe("Contact", [
      mkField({ name: "SSN__c", externalId: true, idLookup: true }),
      mkField({ name: "LegacyId__c", externalId: true, idLookup: true }),
    ]);
    const decision = resolveUpsertKey(src, tgt);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("multiple-candidates");
      expect(decision.candidates).toEqual(["SSN__c", "LegacyId__c"]);
    }
  });

  it("returns target-missing-field when target lacks the picked field", () => {
    const src = mkDescribe("Contact", [
      mkField({ name: "SSN__c", externalId: true, idLookup: true }),
    ]);
    const tgt = mkDescribe("Contact", [mkField({ name: "Name" })]);
    const decision = resolveUpsertKey(src, tgt);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("target-missing-field");
    }
  });

  it("returns target-missing-field when target has the field but flags don't match", () => {
    const src = mkDescribe("Contact", [
      mkField({ name: "SSN__c", externalId: true, idLookup: true }),
    ]);
    const tgt = mkDescribe("Contact", [
      mkField({
        name: "SSN__c",
        externalId: false, // target lost the ext-id flag
        idLookup: false,
      }),
    ]);
    const decision = resolveUpsertKey(src, tgt);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("target-missing-field");
    }
  });

  it("returns target-describe-failed when target describe is null", () => {
    const src = mkDescribe("Contact", [
      mkField({ name: "SSN__c", externalId: true, idLookup: true }),
    ]);
    const decision = resolveUpsertKey(src, null);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("target-describe-failed");
    }
  });

  it("still returns no-candidates (not target-describe-failed) when source has zero candidates AND target is null", () => {
    // Zero-candidate precedence matters: if the source itself has no
    // eligible field, no amount of target fetching would change the
    // verdict, so we skip the target probe entirely and report the
    // most-specific reason.
    const src = mkDescribe("Account", [mkField({ name: "Name" })]);
    const decision = resolveUpsertKey(src, null);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("no-candidates");
    }
  });

  it("excludes autoNumber fields from candidates even if they carry externalId+idLookup", () => {
    // Regression guard: CaseNumber / OrderNumber are autogenerated per-org,
    // so matching a source CaseNumber to a target CaseNumber is luck, not
    // identity. Must never be picked.
    const src = mkDescribe("Case", [
      mkField({
        name: "CaseNumber",
        externalId: true,
        idLookup: true,
        autoNumber: true,
      }),
    ]);
    const tgt = mkDescribe("Case", [
      mkField({
        name: "CaseNumber",
        externalId: true,
        idLookup: true,
        autoNumber: true,
      }),
    ]);
    const decision = resolveUpsertKey(src, tgt);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("no-candidates");
    }
  });
});
