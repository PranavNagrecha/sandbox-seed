import { describe, expect, it } from "vitest";
import { extractDuplicateValueTargetId } from "../../src/seed/execute.ts";

/**
 * Locks in the issue #2.3 fix: when an INSERT collides with an existing
 * target row on a uniqueness constraint, Salesforce returns the
 * conflicting row's id in the error message. `extractDuplicateValueTargetId`
 * pulls it out so the executor can stitch a source→target mapping into
 * the id-map and treat the row as already-seeded — instead of erroring
 * out and letting downstream FKs cascade-fail.
 *
 * Conservative regex: only recognized message shapes return an id.
 * Anything else returns null so the caller falls back to error-counting.
 */

describe("extractDuplicateValueTargetId", () => {
  it("extracts the 18-char id from the standard DUPLICATE_VALUE message", () => {
    const errs = [
      {
        statusCode: "DUPLICATE_VALUE",
        message:
          "duplicate value found: SSN__c duplicates value on record with id: 003cW00000lGkWrQAK",
        fields: ["SSN__c"],
      },
    ];
    expect(extractDuplicateValueTargetId(errs)).toBe("003cW00000lGkWrQAK");
  });

  it("extracts the 15-char canonical id when that's what Salesforce returned", () => {
    const errs = [
      {
        statusCode: "DUPLICATE_VALUE",
        message:
          "duplicate value found: ExtKey__c duplicates value on record with id: 001000000000ABC",
        fields: ["ExtKey__c"],
      },
    ];
    expect(extractDuplicateValueTargetId(errs)).toBe("001000000000ABC");
  });

  it("accepts errorCode in addition to statusCode (composite upsert response shape)", () => {
    // Composite UPSERT returns errors with `errorCode`, plain INSERT uses
    // `statusCode`. Both routes funnel through this parser.
    const errs = [
      {
        errorCode: "DUPLICATE_VALUE",
        message: "duplicate found, record with id: a01abc000000000123",
      },
    ];
    expect(extractDuplicateValueTargetId(errs)).toBe("a01abc000000000123");
  });

  it("returns null when no DUPLICATE_VALUE entry is present", () => {
    const errs = [
      {
        statusCode: "REQUIRED_FIELD_MISSING",
        message: "Required fields are missing: [Name]",
        fields: ["Name"],
      },
    ];
    expect(extractDuplicateValueTargetId(errs)).toBeNull();
  });

  it("returns null when the message doesn't include a parseable id", () => {
    // Defensive: if Salesforce ever changes the message wording, we'd rather
    // count an error than write a random string into the id-map.
    const errs = [
      {
        statusCode: "DUPLICATE_VALUE",
        message: "duplicate value found on SSN__c",
      },
    ];
    expect(extractDuplicateValueTargetId(errs)).toBeNull();
  });

  it("returns null for malformed inputs", () => {
    expect(extractDuplicateValueTargetId(null)).toBeNull();
    expect(extractDuplicateValueTargetId(undefined)).toBeNull();
    expect(extractDuplicateValueTargetId([])).toBeNull();
    expect(extractDuplicateValueTargetId([null])).toBeNull();
    expect(extractDuplicateValueTargetId(["string"])).toBeNull();
  });

  it("walks multiple errors and returns the first DUPLICATE_VALUE match", () => {
    const errs = [
      { statusCode: "FIELD_FILTER_VALIDATION_EXCEPTION", message: "filter blah" },
      {
        statusCode: "DUPLICATE_VALUE",
        message: "duplicates value on record with id: 003abc000000def123",
      },
      {
        statusCode: "DUPLICATE_VALUE",
        message: "duplicates value on record with id: 003xyz000000aaa987",
      },
    ];
    expect(extractDuplicateValueTargetId(errs)).toBe("003abc000000def123");
  });
});
