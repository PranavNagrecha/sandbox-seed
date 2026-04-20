import { describe, expect, it } from "vitest";
import { DescribeClient } from "../../src/describe/client.ts";
import { DescribeCache } from "../../src/describe/cache.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";

/**
 * Describe normalizer flag capture — this is the keystone test for the
 * upsert-key flow. The resolver trusts `externalId`, `unique`, `idLookup`,
 * and `autoNumber` being correctly lifted off the raw Salesforce response.
 * If any of them fall through as undefined, `resolveUpsertKey` degrades
 * silently to "no-candidates" and every object falls back to INSERT.
 */

function mkAuth(): OrgAuth {
  return {
    username: "tester@example.com",
    alias: "test",
    instanceUrl: "https://example.my.salesforce.com",
    accessToken: "token",
    orgId: "00D000000000000",
    apiVersion: "60.0",
    isSandbox: true,
  };
}

function mkCache(): DescribeCache {
  const dir = mkdtempSync(join(tmpdir(), "describe-test-"));
  return new DescribeCache({
    orgId: "00D000000000000",
    ttlSeconds: 60,
    cacheRoot: dir,
  });
}

describe("DescribeClient.normalizeDescribe — upsert-identity flags", () => {
  it("captures externalId, unique, idLookup, autoNumber from raw describe", async () => {
    const rawBody = {
      name: "Contact",
      label: "Contact",
      custom: false,
      queryable: true,
      createable: true,
      fields: [
        {
          name: "SSN__c",
          label: "SSN",
          type: "string",
          nillable: true,
          custom: true,
          createable: true,
          updateable: true,
          externalId: true,
          unique: true,
          idLookup: true,
          autoNumber: false,
        },
        {
          name: "CaseNumber",
          label: "Case Number",
          type: "string",
          nillable: false,
          custom: false,
          createable: false,
          updateable: false,
          externalId: true,
          unique: true,
          idLookup: true,
          autoNumber: true,
        },
        {
          name: "Name",
          label: "Name",
          type: "string",
          nillable: false,
          custom: false,
          createable: true,
          updateable: true,
          // no ext-id flags at all — should normalize to false
        },
      ],
    };

    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => rawBody,
    })) as unknown as typeof fetch;

    const client = new DescribeClient({
      auth: mkAuth(),
      cache: mkCache(),
      fetchFn,
    });

    const result = await client.describeObject("Contact");

    const ssn = result.fields.find((f) => f.name === "SSN__c");
    expect(ssn).toBeDefined();
    expect(ssn?.externalId).toBe(true);
    expect(ssn?.unique).toBe(true);
    expect(ssn?.idLookup).toBe(true);
    expect(ssn?.autoNumber).toBe(false);

    const caseNumber = result.fields.find((f) => f.name === "CaseNumber");
    expect(caseNumber).toBeDefined();
    expect(caseNumber?.externalId).toBe(true);
    expect(caseNumber?.autoNumber).toBe(true); // critical for upsert-key filter

    const name = result.fields.find((f) => f.name === "Name");
    expect(name).toBeDefined();
    // Absent flags must normalize to boolean false (not undefined) so the
    // upsert-eligibility filter in upsert-key.ts can `=== true` them.
    expect(name?.externalId).toBe(false);
    expect(name?.unique).toBe(false);
    expect(name?.idLookup).toBe(false);
    expect(name?.autoNumber).toBe(false);
  });

  it("derives autoNumber from type='autonumber' when the flag is omitted", async () => {
    // Older API versions omit the explicit `autoNumber` flag on auto-number
    // fields and rely on `type: "autonumber"`. The normalizer falls back
    // to type-based detection so the upsert-key filter still excludes them.
    const rawBody = {
      name: "Case",
      label: "Case",
      custom: false,
      queryable: true,
      createable: true,
      fields: [
        {
          name: "CaseNumber",
          label: "Case Number",
          type: "autonumber",
          nillable: false,
          custom: false,
          createable: false,
          updateable: false,
          externalId: true,
          idLookup: true,
          // NO autoNumber flag
        },
      ],
    };

    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => rawBody,
    })) as unknown as typeof fetch;

    const client = new DescribeClient({
      auth: mkAuth(),
      cache: mkCache(),
      fetchFn,
    });

    const result = await client.describeObject("Case");
    const caseNumber = result.fields.find((f) => f.name === "CaseNumber");
    expect(caseNumber?.autoNumber).toBe(true);
  });
});
