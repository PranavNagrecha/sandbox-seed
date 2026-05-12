import { describe, expect, it } from "vitest";
import type { Field, SObjectDescribe } from "../../src/describe/types.ts";
import {
  discoverCandidates,
  pickByPopulation,
  resolveUpsertKey,
} from "../../src/seed/upsert-key.ts";

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
    // Salesforce setup defaults `Unique` to true when `External ID` is
    // ticked. Mirror that here so tests that mark a field as an external
    // id without spelling out `unique:` still produce an upsert-eligible
    // candidate. Tests that need a non-unique external id pass
    // `unique: false` explicitly.
    unique: overrides.unique ?? overrides.externalId === true,
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
    const d = mkDescribe("Account", [mkField({ name: "Name" }), mkField({ name: "Phone" })]);
    expect(discoverCandidates(d)).toEqual([]);
  });

  it("returns multiple candidates in describe order", () => {
    const d = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
      mkField({ name: "SSN__c", externalId: true, idLookup: true }),
      mkField({ name: "LegacyId__c", externalId: true, idLookup: true }),
    ]);
    const result = discoverCandidates(d);
    expect(result.map((c) => c.name)).toEqual(["EmailExtId__c", "SSN__c", "LegacyId__c"]);
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
    const tgt = mkDescribe("Contact", [{ ...srcField }, mkField({ name: "Name" })]);

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

  it("excludes non-unique external-id fields (would fail composite UPSERT at runtime)", () => {
    // Salesforce permits External-ID fields with `unique=false`, but
    // composite UPSERT against such a field fails the whole batch when
    // any single source value matches more than one target row. We
    // filter these out at discovery so the run drops to INSERT (with
    // DUPLICATE_VALUE recovery) instead of erroring.
    const src = mkDescribe("Lead", [
      mkField({
        name: "MarketoId__c",
        externalId: true,
        idLookup: true,
        unique: false,
      }),
    ]);
    const tgt = mkDescribe("Lead", [
      mkField({
        name: "MarketoId__c",
        externalId: true,
        idLookup: true,
        unique: false,
      }),
    ]);
    const decision = resolveUpsertKey(src, tgt);
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

/**
 * Locks in the issue #2 fix: when an object has multiple eligible
 * external-id fields, auto-pick by population count breaks the
 * stalemate that previously forced INSERT-only / DUPLICATE_VALUE.
 */
describe("resolveUpsertKey — auto-pick by population", () => {
  function multiKeyDescribe(): SObjectDescribe {
    return mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
      mkField({ name: "LegacyId__c", externalId: true, idLookup: true }),
      mkField({ name: "SSN__c", externalId: true, idLookup: true }),
    ]);
  }

  it("picks the most-populated candidate when population data is provided", () => {
    const src = multiKeyDescribe();
    const tgt = multiKeyDescribe();
    const decision = resolveUpsertKey(src, tgt, {
      populationByField: new Map([
        ["EmailExtId__c", 100],
        ["LegacyId__c", 50],
        ["SSN__c", 10],
      ]),
    });
    expect(decision).toEqual({ kind: "picked", field: "EmailExtId__c" });
  });

  it("breaks population ties alphabetically by field name", () => {
    const src = multiKeyDescribe();
    const tgt = multiKeyDescribe();
    const decision = resolveUpsertKey(src, tgt, {
      populationByField: new Map([
        ["EmailExtId__c", 50],
        ["LegacyId__c", 50],
        ["SSN__c", 50],
      ]),
    });
    expect(decision).toEqual({ kind: "picked", field: "EmailExtId__c" });
  });

  it("returns all-candidates-empty when every candidate has zero population", () => {
    const src = multiKeyDescribe();
    const tgt = multiKeyDescribe();
    const decision = resolveUpsertKey(src, tgt, {
      populationByField: new Map([
        ["EmailExtId__c", 0],
        ["LegacyId__c", 0],
        ["SSN__c", 0],
      ]),
    });
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("all-candidates-empty");
      expect(decision.candidates).toEqual(["EmailExtId__c", "LegacyId__c", "SSN__c"]);
    }
  });

  it("falls back to multiple-candidates when no population data is provided", () => {
    // Backward-compat: callers that don't compute population (e.g. old tests
    // or the cycle path before it threads population data) keep the historic
    // ambiguous result and INSERT-only fallback.
    const src = multiKeyDescribe();
    const tgt = multiKeyDescribe();
    const decision = resolveUpsertKey(src, tgt);
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("multiple-candidates");
    }
  });

  it("ignores missing fields in the population map (treats as zero)", () => {
    const src = multiKeyDescribe();
    const tgt = multiKeyDescribe();
    const decision = resolveUpsertKey(src, tgt, {
      populationByField: new Map([["EmailExtId__c", 7]]),
    });
    // Only one candidate has data; it wins.
    expect(decision).toEqual({ kind: "picked", field: "EmailExtId__c" });
  });
});

describe("resolveUpsertKey — user override", () => {
  it("honors a valid override even when population would have picked differently", () => {
    const src = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
      mkField({ name: "LegacyId__c", externalId: true, idLookup: true }),
    ]);
    const tgt = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
      mkField({ name: "LegacyId__c", externalId: true, idLookup: true }),
    ]);
    const decision = resolveUpsertKey(src, tgt, {
      populationByField: new Map([
        ["EmailExtId__c", 999],
        ["LegacyId__c", 1],
      ]),
      override: "LegacyId__c",
    });
    expect(decision).toEqual({ kind: "picked", field: "LegacyId__c" });
  });

  it("rejects an override that names a non-eligible field", () => {
    const src = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
      // Not eligible — externalId=false.
      mkField({ name: "Name", externalId: false, idLookup: false }),
    ]);
    const tgt = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
    ]);
    const decision = resolveUpsertKey(src, tgt, { override: "Name" });
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("override-invalid");
      expect(decision.detail).toContain("Name");
    }
  });

  it("rejects an override that names a field absent from the source", () => {
    const src = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
    ]);
    const tgt = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
    ]);
    const decision = resolveUpsertKey(src, tgt, { override: "Typo__c" });
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("override-invalid");
    }
  });

  it("still verifies the target side when override is valid", () => {
    const src = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
      mkField({ name: "LegacyId__c", externalId: true, idLookup: true }),
    ]);
    const tgt = mkDescribe("Contact", [
      mkField({ name: "EmailExtId__c", externalId: true, idLookup: true }),
      // LegacyId__c missing on target.
    ]);
    const decision = resolveUpsertKey(src, tgt, { override: "LegacyId__c" });
    expect(decision.kind).toBe("ambiguous");
    if (decision.kind === "ambiguous") {
      expect(decision.reason).toBe("target-missing-field");
    }
  });
});

describe("pickByPopulation", () => {
  function cand(name: string) {
    return { name, label: name };
  }

  it("returns null when every candidate is unpopulated", () => {
    const result = pickByPopulation(
      [cand("A__c"), cand("B__c")],
      new Map([
        ["A__c", 0],
        ["B__c", 0],
      ]),
    );
    expect(result).toBeNull();
  });

  it("returns null when no candidates are in the map at all", () => {
    const result = pickByPopulation([cand("A__c"), cand("B__c")], new Map());
    expect(result).toBeNull();
  });

  it("picks the highest-count candidate", () => {
    const result = pickByPopulation(
      [cand("A__c"), cand("B__c"), cand("C__c")],
      new Map([
        ["A__c", 5],
        ["B__c", 12],
        ["C__c", 8],
      ]),
    );
    expect(result?.name).toBe("B__c");
  });
});
