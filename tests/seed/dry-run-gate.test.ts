import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import { seed } from "../../src/mcp/tools/seed.ts";
import { SessionStore, type Session } from "../../src/seed/session.ts";

/**
 * The mandatory-dry-run gate.
 *
 * `run` must refuse unless the session has a `dryRun.completedAt` within
 * 24h. This test drives `seed({action: "run", ...})` against a session
 * state we set up manually, asserting the gate fires before any network
 * I/O is attempted — we don't install a fetch, so if the gate leaked
 * through we'd get a surprising different error.
 */

function fakeAuth(alias: string): OrgAuth {
  return {
    username: `${alias}@example.com`,
    orgId: "00D000000000000AAA",
    accessToken: "00Dxxxxx!fake",
    instanceUrl: "https://test.my.salesforce.com",
    apiVersion: "60.0",
    alias,
  };
}

describe("run action: mandatory dry-run gate", () => {
  let sessionRoot: string;
  let store: SessionStore;

  beforeEach(async () => {
    sessionRoot = await mkdtemp(join(tmpdir(), "seed-gate-"));
    store = new SessionStore({ rootDir: sessionRoot });
  });

  afterEach(async () => {
    await rm(sessionRoot, { recursive: true, force: true });
  });

  async function createSession(overrides: Partial<Session> = {}): Promise<Session> {
    const s = await store.create({
      sourceOrg: "src",
      targetOrg: "tgt",
      rootObject: "Account",
      whereClause: "Id != null",
      limit: 10,
    });
    Object.assign(s, overrides);
    await store.save(s);
    return s;
  }

  it("refuses when confirm is not true", async () => {
    const s = await createSession({ step: "dry_run_complete" });
    await expect(
      seed(
        { action: "run", sessionId: s.id },
        {
          sessionRootDir: sessionRoot,
          authBySource: fakeAuth("src"),
          authByTarget: fakeAuth("tgt"),
        },
      ),
    ).rejects.toThrow(/confirm: true/i);
  });

  it("refuses when no dry-run has been recorded", async () => {
    const s = await createSession({ step: "selected" });
    await expect(
      seed(
        { action: "run", sessionId: s.id, confirm: true },
        {
          sessionRootDir: sessionRoot,
          authBySource: fakeAuth("src"),
          authByTarget: fakeAuth("tgt"),
        },
      ),
    ).rejects.toThrow(/no fresh dry run/i);
  });

  it("refuses when dry-run is stale (> 24h old)", async () => {
    const s = await createSession({
      step: "dry_run_complete",
      finalObjectList: ["Account"],
      dryRun: {
        reportPath: "/tmp/r.md",
        perObjectCounts: { Account: 1 },
        totalRecords: 1,
        completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        targetSchemaIssues: [],
      },
    });
    await expect(
      seed(
        { action: "run", sessionId: s.id, confirm: true },
        {
          sessionRootDir: sessionRoot,
          authBySource: fakeAuth("src"),
          authByTarget: fakeAuth("tgt"),
        },
      ),
    ).rejects.toThrow(/no fresh dry run/i);
  });

  it("refuses when session is fresh but has no finalObjectList", async () => {
    // Fresh dry-run summary attached to a session that never went through
    // `select` — defensive gate in doRun.
    const s = await createSession({
      step: "dry_run_complete",
      dryRun: {
        reportPath: "/tmp/r.md",
        perObjectCounts: {},
        totalRecords: 0,
        completedAt: new Date().toISOString(),
        targetSchemaIssues: [],
      },
    });
    await expect(
      seed(
        { action: "run", sessionId: s.id, confirm: true },
        {
          sessionRootDir: sessionRoot,
          authBySource: fakeAuth("src"),
          authByTarget: fakeAuth("tgt"),
        },
      ),
    ).rejects.toThrow(/no final object list/i);
  });

  it("refuses when sessionId is unknown", async () => {
    await expect(
      seed(
        { action: "run", sessionId: "does-not-exist", confirm: true },
        {
          sessionRootDir: sessionRoot,
          authBySource: fakeAuth("src"),
          authByTarget: fakeAuth("tgt"),
        },
      ),
    ).rejects.toThrow(/not found/i);
  });
});
