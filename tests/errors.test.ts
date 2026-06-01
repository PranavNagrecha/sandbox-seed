import { describe, expect, it } from "vitest";
import { extractSalesforceErrorCodes, salesforceErrorSummary } from "../src/errors.ts";

/**
 * The AI-data boundary depends on Salesforce error bodies NEVER reaching the
 * model. `salesforceErrorSummary` is the single chokepoint every HTTP-error
 * throw site funnels through: it must surface the safe `errorCode` enum and
 * nothing from the data-bearing `message` / `error_description`.
 *
 * These bodies are realistic Salesforce error shapes carrying planted record
 * data (IDs, emails, values). Every assertion checks the planted data is gone.
 */

// A real-shaped DUPLICATE_VALUE body — `message` embeds a record ID + value.
const DUPLICATE_BODY = JSON.stringify([
  {
    message:
      "duplicate value found: Email__c duplicates value on record with id: 0035g00000AbCdEfGHI (alice@acme.com)",
    errorCode: "DUPLICATE_VALUE",
    fields: ["Email__c"],
  },
]);

// A custom validation rule echoing field values into `message`.
const VALIDATION_BODY = JSON.stringify([
  {
    message: "Discount 0.85 exceeds the maximum allowed for account alice@acme.com",
    errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION",
    fields: ["Discount__c"],
  },
]);

const LEAKED_STRINGS = ["0035g00000AbCdEfGHI", "alice@acme.com", "0.85", "Discount", "duplicate"];

describe("extractSalesforceErrorCodes", () => {
  it("captures the errorCode enum and nothing else", () => {
    expect(extractSalesforceErrorCodes(DUPLICATE_BODY)).toEqual(["DUPLICATE_VALUE"]);
  });

  it("captures OAuth `error` tokens", () => {
    const body = JSON.stringify({ error: "invalid_grant", error_description: "user hint here" });
    expect(extractSalesforceErrorCodes(body)).toEqual(["invalid_grant"]);
  });

  it("de-duplicates and collects multiple distinct codes", () => {
    const body = JSON.stringify([
      { message: "a", errorCode: "REQUIRED_FIELD_MISSING" },
      { message: "b", errorCode: "MALFORMED_QUERY" },
      { message: "c", errorCode: "REQUIRED_FIELD_MISSING" },
    ]);
    expect(extractSalesforceErrorCodes(body).sort()).toEqual([
      "MALFORMED_QUERY",
      "REQUIRED_FIELD_MISSING",
    ]);
  });

  it("never captures a value-shaped token (spaces, @, punctuation) even if mislabeled", () => {
    // Adversarial: a body that tries to smuggle data through an `error` field.
    const body = JSON.stringify({ error: "alice@acme.com has 5 records", errorCode: "ok" });
    // "alice@acme.com has 5 records" has spaces/@ → rejected. "ok" is a clean
    // token → captured, but it carries no data.
    const codes = extractSalesforceErrorCodes(body);
    expect(codes).toEqual(["ok"]);
    expect(codes.join(" ")).not.toContain("@");
  });

  it("returns [] for empty / non-JSON / truncated-before-code bodies (never throws)", () => {
    expect(extractSalesforceErrorCodes("")).toEqual([]);
    expect(extractSalesforceErrorCodes("<html>502 Bad Gateway</html>")).toEqual([]);
    expect(extractSalesforceErrorCodes('[{"message":"cut off mid pay')).toEqual([]);
  });
});

describe("salesforceErrorSummary", () => {
  it("surfaces status + code, never the record data in `message`", () => {
    const summary = salesforceErrorSummary(400, "Bad Request", DUPLICATE_BODY);
    expect(summary).toBe("HTTP 400 Bad Request (DUPLICATE_VALUE)");
    for (const leaked of LEAKED_STRINGS) {
      expect(summary).not.toContain(leaked);
    }
  });

  it("strips custom-validation field values", () => {
    const summary = salesforceErrorSummary(400, "Bad Request", VALIDATION_BODY);
    expect(summary).toContain("FIELD_CUSTOM_VALIDATION_EXCEPTION");
    expect(summary).not.toContain("0.85");
    expect(summary).not.toContain("alice@acme.com");
  });

  it("degrades to status-only on an unparseable body (no leak, no throw)", () => {
    const summary = salesforceErrorSummary(503, "Service Unavailable", "<html>oops 12345</html>");
    expect(summary).toBe("HTTP 503 Service Unavailable");
  });

  it("handles a missing statusText without a dangling space", () => {
    expect(salesforceErrorSummary(500, "", "")).toBe("HTTP 500");
  });

  it("still surfaces the code from a body truncated AFTER the errorCode", () => {
    // safeText truncates to 500 chars; the errorCode often survives. When it
    // does, we keep it; the dropped tail (which carries the message) is gone.
    const truncated =
      '[{"errorCode":"MALFORMED_QUERY","message":"\\nSELECT bad FROM ... ^ ERROR at';
    expect(salesforceErrorSummary(400, "Bad Request", truncated)).toBe(
      "HTTP 400 Bad Request (MALFORMED_QUERY)",
    );
  });
});
