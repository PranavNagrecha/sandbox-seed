import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DRY_RUN_FRESHNESS_MS,
  isDryRunFresh,
  SessionStore,
  type Session,
} from "../../src/seed/session.ts";

describe("SessionStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seed-session-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a session with a date-prefixed id and writes session.json", async () => {
    const store = new SessionStore({ rootDir: root });
    const s = await store.create({
      sourceOrg: "src",
      targetOrg: "tgt",
      rootObject: "Opportunity",
      whereClause: "Amount > 100",
      limit: 10_000,
    });

    expect(s.id).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{10}$/);
    expect(s.step).toBe("started");
    expect(s.createdAt).toMatch(/\d{4}-\d{2}-\d{2}T/);

    const onDisk = await readFile(join(store.sessionDir(s.id), "session.json"), "utf8");
    const parsed = JSON.parse(onDisk) as Session;
    expect(parsed.id).toBe(s.id);
    expect(parsed.whereClause).toBe("Amount > 100");
  });

  it("load() round-trips a session", async () => {
    const store = new SessionStore({ rootDir: root });
    const s = await store.create({
      sourceOrg: "src",
      targetOrg: "tgt",
      rootObject: "Case",
      whereClause: "IsClosed = false",
      limit: 5000,
    });

    const loaded = await store.load(s.id);
    expect(loaded).toEqual(s);
  });

  it("load() on unknown id throws UserError", async () => {
    const store = new SessionStore({ rootDir: root });
    await expect(store.load("nope-nope")).rejects.toThrow(/not found/i);
  });

  it("save() mutates an existing session without rewriting the id", async () => {
    const store = new SessionStore({ rootDir: root });
    const s = await store.create({
      sourceOrg: "src",
      targetOrg: "tgt",
      rootObject: "Account",
      whereClause: "Name != null",
      limit: 1000,
    });

    s.step = "analyzed";
    s.mustIncludeParents = ["User"];
    await store.save(s);

    const reloaded = await store.load(s.id);
    expect(reloaded.step).toBe("analyzed");
    expect(reloaded.mustIncludeParents).toEqual(["User"]);
    expect(reloaded.id).toBe(s.id);
  });

  it("gc() removes sessions older than 7 days", async () => {
    const store = new SessionStore({ rootDir: root });
    // Create session and backdate its createdAt by 8 days.
    const s = await store.create({
      sourceOrg: "src",
      targetOrg: "tgt",
      rootObject: "Account",
      whereClause: "Id != null",
      limit: 10,
    });
    s.createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await store.save(s);

    const { removed } = await store.gc();
    expect(removed).toContain(s.id);
    await expect(store.load(s.id)).rejects.toThrow(/not found/i);
  });

  it("gc() leaves fresh sessions alone", async () => {
    const store = new SessionStore({ rootDir: root });
    const s = await store.create({
      sourceOrg: "src",
      targetOrg: "tgt",
      rootObject: "Account",
      whereClause: "Id != null",
      limit: 10,
    });
    const { removed } = await store.gc();
    expect(removed).not.toContain(s.id);
    await expect(store.load(s.id)).resolves.toBeTruthy();
  });

  it("gc() is idempotent on a non-existent sessions root", async () => {
    const store = new SessionStore({ rootDir: join(root, "never-written") });
    const { removed } = await store.gc();
    expect(removed).toEqual([]);
  });
});

describe("isDryRunFresh", () => {
  function session(overrides: Partial<Session> = {}): Session {
    return {
      id: "2026-04-19-abc",
      createdAt: new Date().toISOString(),
      step: "dry_run_complete",
      sourceOrg: "src",
      targetOrg: "tgt",
      rootObject: "Account",
      whereClause: "Id != null",
      limit: 10,
      ...overrides,
    };
  }

  it("returns false when no dryRun summary exists", () => {
    expect(isDryRunFresh(session({ dryRun: undefined }))).toBe(false);
  });

  it("returns true when dryRun completedAt is within the window", () => {
    const now = Date.now();
    expect(
      isDryRunFresh(
        session({
          dryRun: {
            reportPath: "/tmp/r.md",
            perObjectCounts: {},
            totalRecords: 0,
            completedAt: new Date(now - 1000).toISOString(),
            targetSchemaIssues: [],
          },
        }),
        now,
      ),
    ).toBe(true);
  });

  it("returns false when dryRun completedAt is older than the window", () => {
    const now = Date.now();
    expect(
      isDryRunFresh(
        session({
          dryRun: {
            reportPath: "/tmp/r.md",
            perObjectCounts: {},
            totalRecords: 0,
            completedAt: new Date(now - DRY_RUN_FRESHNESS_MS - 1000).toISOString(),
            targetSchemaIssues: [],
          },
        }),
        now,
      ),
    ).toBe(false);
  });

  it("returns false when completedAt is unparseable", () => {
    expect(
      isDryRunFresh(
        session({
          dryRun: {
            reportPath: "/tmp/r.md",
            perObjectCounts: {},
            totalRecords: 0,
            completedAt: "not a date",
            targetSchemaIssues: [],
          },
        }),
      ),
    ).toBe(false);
  });
});
