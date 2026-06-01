import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import { type SeedResponse, seed } from "../../src/mcp/tools/seed.ts";
import { findForbiddenSubstrings, findRecordIdLeaks } from "../helpers/no-leak.ts";

/**
 * T11 — AI-boundary holds with masking ON (invariant #9), and the masking salt
 * never appears in any tool response (the salt-no-leak gap flagged at T8b; the
 * 64-char hex salt would NOT trip the record-ID detector, so it needs its own
 * assertion).
 *
 * Drives the full MCP flow (start → analyze → select → dry_run → run) with
 * `mask: true` against a fake Salesforce that returns Contacts carrying
 * sensitive Email/Phone values, then asserts:
 *   - the composite insert masked those values (originals never sent),
 *   - no original sensitive value appears in any response,
 *   - the salt (read from session.json on disk) appears in no response,
 *   - no record-ID-shaped string leaks into any response.
 */

const ALICE_EMAIL = "alice.secret@real-prod.example";
const BOB_EMAIL = "bob.secret@real-prod.example";
const ALICE_PHONE = "617-555-0100";
const BOB_PHONE = "617-555-0200";
const ORIGINALS = [ALICE_EMAIL, BOB_EMAIL, ALICE_PHONE, BOB_PHONE];

const sourceContacts = [
  {
    attributes: { type: "Contact" },
    Id: "003SRC000000001AAA",
    LastName: "Alice",
    Email: ALICE_EMAIL,
    Phone: ALICE_PHONE,
  },
  {
    attributes: { type: "Contact" },
    Id: "003SRC000000002AAA",
    LastName: "Bob",
    Email: BOB_EMAIL,
    Phone: BOB_PHONE,
  },
];

function fakeAuth(alias: string, orgId: string): OrgAuth {
  return {
    username: `${alias}@example.com`,
    orgId,
    accessToken: "00Dxxxxx!fake",
    instanceUrl: `https://${alias}.my.salesforce.com`,
    apiVersion: "60.0",
    alias,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: terse field fixtures
function fld(name: string, type: string, extra: Record<string, any> = {}): any {
  return {
    name,
    label: name,
    type,
    nillable: true,
    custom: false,
    createable: true,
    updateable: true,
    calculated: false,
    defaultedOnCreate: false,
    externalId: false,
    unique: false,
    idLookup: false,
    autoNumber: false,
    ...extra,
  };
}

const CONTACT_DESCRIBE = {
  name: "Contact",
  label: "Contact",
  custom: false,
  queryable: true,
  createable: true,
  fields: [
    fld("Id", "id", { createable: false, nillable: false, idLookup: true }),
    fld("LastName", "string", { nillable: false, length: 80 }),
    fld("Email", "email", { length: 80 }),
    fld("Phone", "phone", { length: 40 }),
  ],
  childRelationships: [],
  recordTypeInfos: [],
};

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type Call = { method: string; url: string; body?: unknown };

function makeFetch(calls: Call[]): typeof fetch {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const decoded = decodeURIComponent(u);
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
    const isTarget = u.includes("tgt.my.salesforce.com");
    calls.push({ method, url: u, body });

    if (u.endsWith("/sobjects/")) {
      return jsonResponse({
        sobjects: [
          { name: "Contact", label: "Contact", custom: false, queryable: true, createable: true },
        ],
      });
    }
    const dm = u.match(/\/sobjects\/([^/]+)\/describe\/$/);
    if (dm !== null) {
      return dm[1] === "Contact"
        ? jsonResponse(CONTACT_DESCRIBE)
        : new Response("", { status: 404 });
    }
    if (/IsSandbox\s+FROM\s+Organization/i.test(decoded)) {
      return jsonResponse({ records: [{ IsSandbox: isTarget }], done: true, totalSize: 1 });
    }
    if (/LastRefreshDate\s+FROM\s+Organization/i.test(decoded)) {
      return jsonResponse({
        records: [
          {
            Id: isTarget ? "00D000000000000BBB" : "00D000000000000AAA",
            LastRefreshDate: isTarget ? "2026-04-01T00:00:00.000Z" : null,
          },
        ],
        done: true,
        totalSize: 1,
      });
    }
    const qPart = decoded.replace(/^.*\bq=/, "");
    if (/^SELECT\s+COUNT\(\)/i.test(qPart)) {
      return jsonResponse({ totalSize: sourceContacts.length, done: true, records: [] });
    }
    // Full-field extract (field list has a comma) → return records with values.
    if (/FROM\s+Contact/i.test(decoded) && qPart.includes(",")) {
      return jsonResponse({
        totalSize: sourceContacts.length,
        done: true,
        records: sourceContacts,
      });
    }
    // Id-only materialization.
    if (/SELECT\s+Id\s+FROM\s+Contact/i.test(decoded)) {
      return jsonResponse({
        totalSize: sourceContacts.length,
        done: true,
        records: sourceContacts.map((c) => ({ attributes: { type: "Contact" }, Id: c.Id })),
      });
    }
    if (/\/query\?q=/.test(u)) {
      return jsonResponse({ totalSize: 0, done: true, records: [] });
    }
    if (/\/composite\/sobjects(\/|$)/.test(u)) {
      const recs = (body as { records?: unknown[] })?.records ?? [];
      return jsonResponse(recs.map((_, i) => ({ id: `003TGT00000000${i}AAA`, success: true })));
    }
    return new Response(`unhandled: ${u}`, { status: 500 });
  });
  return fn as unknown as typeof fetch;
}

function insertedBodies(calls: Call[]): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.method === "POST" && /\/composite\/sobjects$/.test(c.url))
    .flatMap((c) => (c.body as { records: Array<Record<string, unknown>> }).records);
}

describe("seed: AI-boundary + salt-no-leak with masking ON (T11)", () => {
  let sessionRoot: string;
  let cacheRoot: string;

  beforeEach(async () => {
    sessionRoot = await mkdtemp(join(tmpdir(), "mask-bound-sess-"));
    cacheRoot = await mkdtemp(join(tmpdir(), "mask-bound-cache-"));
  });
  afterEach(async () => {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("masks PII end-to-end; no original, salt, or record ID leaks into any response", async () => {
    const calls: Call[] = [];
    const overrides = {
      sessionRootDir: sessionRoot,
      cacheRoot,
      fetchFn: makeFetch(calls),
      authBySource: fakeAuth("src", "00D000000000000AAA"),
      authByTarget: fakeAuth("tgt", "00D000000000000BBB"),
    };

    const start = await seed(
      {
        action: "start",
        sourceOrg: "src",
        targetOrg: "tgt",
        object: "Contact",
        whereClause: "Id != null",
        mask: true,
        isolateIdMap: true,
      },
      overrides,
    );
    const analyze = await seed({ action: "analyze", sessionId: start.sessionId }, overrides);
    const select = await seed(
      {
        action: "select",
        sessionId: start.sessionId,
        includeOptionalParents: [],
        includeOptionalChildren: [],
      },
      overrides,
    );
    const dryRun = await seed({ action: "dry_run", sessionId: start.sessionId }, overrides);
    const run = await seed({ action: "run", sessionId: start.sessionId, confirm: true }, overrides);

    const responses: SeedResponse[] = [start, analyze, select, dryRun, run];

    // The salt lives only in session.json on disk — read it to assert no-leak.
    const sess = JSON.parse(
      await readFile(join(sessionRoot, "sessions", start.sessionId, "session.json"), "utf8"),
    ) as { maskSalt?: string };
    expect(typeof sess.maskSalt).toBe("string");
    expect((sess.maskSalt as string).length).toBe(64);
    const salt = sess.maskSalt as string;

    // #9 + salt-no-leak: every response is clean of record IDs, originals, salt.
    for (const r of responses) {
      expect(findRecordIdLeaks(r)).toEqual([]);
      expect(findForbiddenSubstrings(r, ORIGINALS)).toEqual([]);
      expect(findForbiddenSubstrings(r, [salt])).toEqual([]);
    }

    // Dry-run surfaced the masking plan (field NAMES are allowed metadata).
    const masked = (dryRun.summary as { maskedFieldsByObject?: Record<string, string[]> })
      .maskedFieldsByObject;
    expect(masked?.Contact).toEqual(expect.arrayContaining(["Email", "Phone"]));

    // The composite insert actually masked the values.
    const bodies = insertedBodies(calls);
    expect(bodies.length).toBe(2);
    for (const rec of bodies) {
      expect(rec.Email).toMatch(/@/);
      expect(rec.Email).not.toBe(ALICE_EMAIL);
      expect(rec.Email).not.toBe(BOB_EMAIL);
      expect(rec.Phone).not.toBe(ALICE_PHONE);
      expect(rec.Phone).not.toBe(BOB_PHONE);
      // Non-sensitive field copied verbatim.
      expect(["Alice", "Bob"]).toContain(rec.LastName);
    }

    // Originals were never sent to Salesforce in ANY request.
    expect(findForbiddenSubstrings(calls, ORIGINALS)).toEqual([]);

    expect(run.step).toBe("executed");
    expect((run.summary as { insertedCounts: Record<string, number> }).insertedCounts.Contact).toBe(
      2,
    );
  });
});
