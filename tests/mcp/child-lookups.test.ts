import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import { seed } from "../../src/mcp/tools/seed.ts";
import {
  ACCOUNT,
  CASE,
  CASE_COMMENT,
  CONTACT,
  CONTACT_WITH_REPORTS_TO,
  OPPORTUNITY,
  TASK,
  USER,
} from "../fixtures/describes.ts";

const OBJECTS = {
  Account: ACCOUNT,
  Contact: CONTACT_WITH_REPORTS_TO,
  Opportunity: OPPORTUNITY,
  Case: CASE,
  CaseComment: CASE_COMMENT,
  Task: TASK,
  User: USER,
};

function fakeAuth(alias: string, orgId = "00D000000000000AAA"): OrgAuth {
  return {
    username: `${alias}@example.com`,
    orgId,
    accessToken: "00Dxxxxx!fake",
    instanceUrl: `https://${alias}.my.salesforce.com`,
    apiVersion: "60.0",
    alias,
  };
}

function makeFetch(): typeof fetch {
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const decoded = decodeURIComponent(u);
    const isTarget = u.includes("tgt.my.salesforce.com");

    if (u.endsWith("/sobjects/")) {
      return new Response(
        JSON.stringify({
          sobjects: Object.values(OBJECTS).map((o) => ({
            name: o.name,
            label: o.label,
            custom: o.custom,
            queryable: o.queryable,
            createable: o.createable,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const describeMatch = u.match(/\/sobjects\/([^/]+)\/describe\/$/);
    if (describeMatch !== null) {
      const name = describeMatch[1];
      const obj = (OBJECTS as Record<string, unknown>)[name];
      if (obj === undefined) return new Response("", { status: 404 });
      return new Response(JSON.stringify(obj), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/IsSandbox\s+FROM\s+Organization/i.test(decoded)) {
      return new Response(
        JSON.stringify({ records: [{ IsSandbox: isTarget }], done: true, totalSize: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (/SELECT\s+COUNT\(\)/i.test(decoded)) {
      return new Response(
        JSON.stringify({ totalSize: 3, done: true, records: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (/\/query\?q=/.test(u)) {
      return new Response(
        JSON.stringify({ totalSize: 0, done: true, records: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(`unhandled: ${u}`, { status: 500 });
  });
  return fetchFn as unknown as typeof fetch;
}

describe("seed action=start: childLookups validation", () => {
  let sessionRoot: string;
  let cacheRoot: string;

  beforeEach(async () => {
    sessionRoot = await mkdtemp(join(tmpdir(), "seed-cl-sess-"));
    cacheRoot = await mkdtemp(join(tmpdir(), "seed-cl-cache-"));
  });

  afterEach(async () => {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  });

  function overrides() {
    return {
      sessionRootDir: sessionRoot,
      cacheRoot,
      fetchFn: makeFetch(),
      authBySource: fakeAuth("src", "00D000000000000AAA"),
      authByTarget: fakeAuth("tgt", "00D000000000000BBB"),
    };
  }

  it("accepts valid childLookups and persists them on the session", async () => {
    const resp = await seed(
      {
        action: "start",
        sourceOrg: "src",
        targetOrg: "tgt",
        object: "Account",
        whereClause: "Name != null",
        childLookups: { Contact: ["ReportsToId"] },
      },
      overrides(),
    );
    expect(resp.sessionId).toMatch(/^[0-9a-f-]+/);
  });

  it("rejects unknown child object", async () => {
    await expect(
      seed(
        {
          action: "start",
          sourceOrg: "src",
          targetOrg: "tgt",
          object: "Account",
          whereClause: "Name != null",
          childLookups: { Fizzbuzz__c: ["X"] },
        },
        overrides(),
      ),
    ).rejects.toThrow(/unknown object/i);
  });

  it("rejects non-child object (not in root's childRelationships)", async () => {
    await expect(
      seed(
        {
          action: "start",
          sourceOrg: "src",
          targetOrg: "tgt",
          object: "Account",
          whereClause: "Name != null",
          childLookups: { Task: ["WhatId"] },
        },
        overrides(),
      ),
    ).rejects.toThrow(/not a 1-level child/i);
  });

  it("rejects unknown field name on child", async () => {
    await expect(
      seed(
        {
          action: "start",
          sourceOrg: "src",
          targetOrg: "tgt",
          object: "Account",
          whereClause: "Name != null",
          childLookups: { Contact: ["Nonsense__c"] },
        },
        overrides(),
      ),
    ).rejects.toThrow(/does not exist/i);
  });

  it("rejects non-reference field", async () => {
    await expect(
      seed(
        {
          action: "start",
          sourceOrg: "src",
          targetOrg: "tgt",
          object: "Account",
          whereClause: "Name != null",
          childLookups: { Contact: ["LastName"] },
        },
        overrides(),
      ),
    ).rejects.toThrow(/not a reference/i);
  });
});
