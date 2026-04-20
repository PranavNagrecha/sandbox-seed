import { describe, expect, it, vi } from "vitest";
import {
  queryActiveValidationRules,
  setValidationRuleActive,
  type ValidationRuleRecord,
} from "../../src/describe/tooling-client.ts";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";

/**
 * Tooling API wrapper. Covers the exact subset of behaviour the
 * validation-rule toggle feature depends on — nothing more. We trust
 * Salesforce to implement the rest; these tests trust only our JSON
 * shaping and URL composition.
 *
 * NOTE: As of the two-phase fix (MALFORMED_QUERY bug), `queryActiveValidationRules`
 * now hits the Tooling API TWICE per rule set:
 *   1. SOQL filter query (no Metadata/FullName — Salesforce rejects > 1 row
 *      when either field is selected).
 *   2. Per-ID GET to /tooling/sobjects/ValidationRule/<id> to pull Metadata + FullName.
 * Mocks below reflect that.
 */

function fakeAuth(): OrgAuth {
  return {
    username: "test@example.com",
    orgId: "00D000000000000AAA",
    accessToken: "fake-token",
    instanceUrl: "https://target.my.salesforce.com",
    apiVersion: "60.0",
    alias: "tgt",
  };
}

/**
 * Build a fetch mock that routes:
 *   - /tooling/query        → the `queryBody` response
 *   - /tooling/sobjects/ValidationRule/<id> → `detailBodyById[id]`
 *   - everything else       → 500 (so we see bad routing as test failures)
 */
function routingFetch(
  queryPages: Array<{ status?: number; body: unknown }>,
  detailBodyById: Record<string, { status?: number; body: unknown }>,
) {
  let queryIdx = 0;
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/tooling/query")) {
      const page = queryPages[Math.min(queryIdx, queryPages.length - 1)];
      queryIdx += 1;
      return new Response(JSON.stringify(page.body), {
        status: page.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    const match = u.match(/\/tooling\/sobjects\/ValidationRule\/([^?]+)/);
    if (match !== null) {
      const id = decodeURIComponent(match[1]);
      const detail = detailBodyById[id];
      if (detail === undefined) {
        return new Response(`no mock for id ${id}`, { status: 500 });
      }
      return new Response(JSON.stringify(detail.body), {
        status: detail.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(`unrouted url ${u}`, { status: 500 });
  });
}

describe("queryActiveValidationRules", () => {
  it("returns an empty array with no fetch when objects is empty", async () => {
    const fetchFn = vi.fn();
    const rules = await queryActiveValidationRules({
      auth: fakeAuth(),
      objects: [],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(rules).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("runs phase-1 SOQL (no Metadata/FullName) and phase-2 per-id GETs", async () => {
    const fetchFn = routingFetch(
      [
        {
          body: {
            done: true,
            records: [
              {
                Id: "03d000000000001AAA",
                ValidationName: "SSN_Must_Be_9_Digits",
                Active: true,
                EntityDefinition: { QualifiedApiName: "Contact" },
              },
            ],
          },
        },
      ],
      {
        "03d000000000001AAA": {
          body: {
            Id: "03d000000000001AAA",
            FullName: "Contact.SSN_Must_Be_9_Digits",
            Active: true,
            Metadata: {
              active: true,
              errorConditionFormula: "LEN(SSN__c) != 9",
              errorMessage: "Please enter 9 digits for the SSN field",
              description: null,
            },
          },
        },
      },
    );

    const rules = await queryActiveValidationRules({
      auth: fakeAuth(),
      objects: ["Contact"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(rules.length).toBe(1);
    expect(rules[0]).toMatchObject({
      id: "03d000000000001AAA",
      validationName: "SSN_Must_Be_9_Digits",
      entityApiName: "Contact",
      fullName: "Contact.SSN_Must_Be_9_Digits",
      active: true,
    });
    // Metadata is round-tripped verbatim from the phase-2 GET.
    expect(rules[0].metadata.errorMessage).toBe(
      "Please enter 9 digits for the SSN field",
    );

    // Phase-1 URL sanity: /tooling/query with Active=true predicate, NO Metadata field.
    const queryUrl = fetchFn.mock.calls[0][0] as string;
    expect(queryUrl).toContain("/tooling/query");
    const decoded = decodeURIComponent(queryUrl);
    expect(decoded).toContain("Active = true");
    expect(decoded).toContain("QualifiedApiName IN ('Contact')");
    expect(decoded).not.toContain("Metadata"); // critical — would trigger MALFORMED_QUERY
    expect(decoded).not.toContain("FullName");

    // Phase-2 URL: per-id GET.
    const detailUrl = fetchFn.mock.calls[1][0] as string;
    expect(detailUrl).toContain(
      "/tooling/sobjects/ValidationRule/03d000000000001AAA",
    );
  });

  it("skips malformed phase-1 records gracefully", async () => {
    const fetchFn = routingFetch(
      [
        {
          body: {
            done: true,
            records: [
              { Id: "03d...", ValidationName: null }, // missing fields
              {
                Id: "03d000000000002AAA",
                ValidationName: "Ok_Rule",
                Active: true,
                EntityDefinition: { QualifiedApiName: "Account" },
              },
            ],
          },
        },
      ],
      {
        "03d000000000002AAA": {
          body: {
            Id: "03d000000000002AAA",
            FullName: "Account.Ok_Rule",
            Active: true,
            Metadata: { active: true },
          },
        },
      },
    );
    const rules = await queryActiveValidationRules({
      auth: fakeAuth(),
      objects: ["Account", "Contact"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(rules.length).toBe(1);
    expect(rules[0].validationName).toBe("Ok_Rule");
  });

  it("skips records whose phase-2 GET returns no Metadata blob", async () => {
    const fetchFn = routingFetch(
      [
        {
          body: {
            done: true,
            records: [
              {
                Id: "03d000000000003AAA",
                ValidationName: "No_Metadata_Rule",
                Active: true,
                EntityDefinition: { QualifiedApiName: "Contact" },
              },
            ],
          },
        },
      ],
      {
        "03d000000000003AAA": {
          body: {
            Id: "03d000000000003AAA",
            FullName: "Contact.No_Metadata_Rule",
            Active: true,
            // Metadata omitted entirely — unexpected but handled.
          },
        },
      },
    );
    const rules = await queryActiveValidationRules({
      auth: fakeAuth(),
      objects: ["Contact"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(rules).toEqual([]);
  });

  it("falls back to composed fullName if phase-2 GET omits FullName", async () => {
    const fetchFn = routingFetch(
      [
        {
          body: {
            done: true,
            records: [
              {
                Id: "03d000000000004AAA",
                ValidationName: "Fallback_Rule",
                Active: true,
                EntityDefinition: { QualifiedApiName: "Contact" },
              },
            ],
          },
        },
      ],
      {
        "03d000000000004AAA": {
          body: {
            Id: "03d000000000004AAA",
            Active: true,
            // FullName omitted.
            Metadata: { active: true },
          },
        },
      },
    );
    const rules = await queryActiveValidationRules({
      auth: fakeAuth(),
      objects: ["Contact"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(rules.length).toBe(1);
    expect(rules[0].fullName).toBe("Contact.Fallback_Rule");
  });

  it("surfaces phase-1 Tooling API HTTP errors as ApiError with permission hint", async () => {
    const fetchFn = routingFetch(
      [{ status: 403, body: "INSUFFICIENT_ACCESS" }],
      {},
    );
    await expect(
      queryActiveValidationRules({
        auth: fakeAuth(),
        objects: ["Contact"],
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Tooling API query for ValidationRule failed \(403\)/);
  });

  it("surfaces phase-2 per-id GET errors as ApiError", async () => {
    const fetchFn = routingFetch(
      [
        {
          body: {
            done: true,
            records: [
              {
                Id: "03d000000000005AAA",
                ValidationName: "Boom",
                Active: true,
                EntityDefinition: { QualifiedApiName: "Contact" },
              },
            ],
          },
        },
      ],
      {
        "03d000000000005AAA": { status: 500, body: "INTERNAL" },
      },
    );
    await expect(
      queryActiveValidationRules({
        auth: fakeAuth(),
        objects: ["Contact"],
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Tooling GET ValidationRule\/03d000000000005AAA/);
  });

  it("follows pagination on phase-1 via nextRecordsUrl", async () => {
    const fetchFn = routingFetch(
      [
        {
          body: {
            done: false,
            nextRecordsUrl: "/services/data/v60.0/tooling/query/01g-next",
            records: [
              {
                Id: "03d000000000001AAA",
                ValidationName: "Rule1",
                Active: true,
                EntityDefinition: { QualifiedApiName: "Contact" },
              },
            ],
          },
        },
        {
          body: {
            done: true,
            records: [
              {
                Id: "03d000000000002AAA",
                ValidationName: "Rule2",
                Active: true,
                EntityDefinition: { QualifiedApiName: "Contact" },
              },
            ],
          },
        },
      ],
      {
        "03d000000000001AAA": {
          body: {
            Id: "03d000000000001AAA",
            FullName: "Contact.Rule1",
            Active: true,
            Metadata: { active: true },
          },
        },
        "03d000000000002AAA": {
          body: {
            Id: "03d000000000002AAA",
            FullName: "Contact.Rule2",
            Active: true,
            Metadata: { active: true },
          },
        },
      },
    );
    const rules = await queryActiveValidationRules({
      auth: fakeAuth(),
      objects: ["Contact"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(rules.map((r) => r.validationName).sort()).toEqual([
      "Rule1",
      "Rule2",
    ]);
  });
});

describe("setValidationRuleActive", () => {
  function fakeRule(overrides: Partial<ValidationRuleRecord> = {}): ValidationRuleRecord {
    return {
      id: "03d000000000001AAA",
      validationName: "SSN_Rule",
      entityApiName: "Contact",
      fullName: "Contact.SSN_Rule",
      active: true,
      metadata: {
        active: true,
        errorConditionFormula: "LEN(SSN__c) != 9",
        errorMessage: "need 9 digits",
        description: null,
      },
      ...overrides,
    };
  }

  it("PATCHes /tooling/sobjects/ValidationRule with preserved metadata and flipped active", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await setValidationRuleActive({
      auth: fakeAuth(),
      rule: fakeRule(),
      active: false,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(
      "https://target.my.salesforce.com/services/data/v60.0/tooling/sobjects/ValidationRule/03d000000000001AAA",
    );
    const opts = init as RequestInit;
    expect(opts.method).toBe("PATCH");
    const body = JSON.parse(opts.body as string);
    expect(body.FullName).toBe("Contact.SSN_Rule");
    expect(body.Metadata.active).toBe(false); // overridden
    // Every OTHER metadata field is preserved byte-for-byte.
    expect(body.Metadata.errorConditionFormula).toBe("LEN(SSN__c) != 9");
    expect(body.Metadata.errorMessage).toBe("need 9 digits");
  });

  it("throws ApiError on non-success response", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("FIELD_INTEGRITY_EXCEPTION", { status: 400 }),
    );
    await expect(
      setValidationRuleActive({
        auth: fakeAuth(),
        rule: fakeRule(),
        active: false,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Tooling PATCH ValidationRule\/03d000000000001AAA/);
  });

  it("treats 204 No Content as success", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      setValidationRuleActive({
        auth: fakeAuth(),
        rule: fakeRule(),
        active: true,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});
