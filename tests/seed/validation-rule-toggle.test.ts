import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import {
  findPendingRecoveries,
  reactivateFromSnapshot,
  snapshotAndDeactivate,
  TOUCHED_VALIDATION_RULES_FILENAME,
  REACTIVATED_VALIDATION_RULES_FILENAME,
} from "../../src/seed/validation-rule-toggle.ts";

/**
 * Validation-rule toggle orchestrator.
 *
 * The feature's two invariants we have to prove:
 *   1. "THE SAME ONES" — we only snapshot and later reactivate rules
 *      that were Active=true at snapshot time. Pre-disabled rules are
 *      never touched.
 *   2. Crash-safety — the snapshot file lands on disk BEFORE any flip;
 *      reactivation is idempotent; partial failures leave a narrowed
 *      snapshot so recovery can retry.
 */

function fakeAuth(): OrgAuth {
  return {
    username: "tester@example.com",
    orgId: "00D000000000000AAA",
    accessToken: "fake",
    instanceUrl: "https://tgt.my.salesforce.com",
    apiVersion: "60.0",
    alias: "acme-dev",
  };
}

type FakeRule = {
  Id: string;
  ValidationName: string;
  FullName: string;
  Active: boolean;
  EntityDefinition: { QualifiedApiName: string };
  Metadata: Record<string, unknown>;
};

function fakeActive(
  name: string,
  entity = "Contact",
  id?: string,
): FakeRule {
  return {
    Id: id ?? `03d${name.padStart(15, "0").slice(-15)}AAA`,
    ValidationName: name,
    FullName: `${entity}.${name}`,
    Active: true,
    EntityDefinition: { QualifiedApiName: entity },
    Metadata: {
      active: true,
      errorConditionFormula: "TRUE",
      errorMessage: `msg for ${name}`,
    },
  };
}

/**
 * Build a fetch stub for the Tooling API. Accepts the rule list the
 * QUERY endpoint should return (server-side already filtered to
 * Active=true), and records every PATCH so assertions can check the
 * flip behaviour.
 */
function makeToolingFetch(opts: {
  queryResult: FakeRule[];
  patchBehavior?: (ruleId: string, newActive: boolean) => Response | Error;
}): {
  fetchFn: typeof fetch;
  patches: Array<{ ruleId: string; active: boolean }>;
} {
  const patches: Array<{ ruleId: string; active: boolean }> = [];
  // Index rules by id for phase-2 per-id GETs.
  const byId = new Map<string, FakeRule>();
  for (const r of opts.queryResult) byId.set(r.Id, r);
  const fetchFn = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      // Phase-1 SOQL filter. The real client intentionally omits
      // Metadata/FullName from the SELECT (those fields trigger
      // MALFORMED_QUERY for multi-row results), so we only need to
      // return the stub columns here — but including the extras is
      // harmless and keeps the fixture readable.
      if (u.includes("/tooling/query?q=")) {
        return new Response(
          JSON.stringify({ done: true, records: opts.queryResult }),
          { status: 200 },
        );
      }
      const m = u.match(/\/tooling\/sobjects\/ValidationRule\/([^/?]+)/);
      if (m !== null && init?.method === "PATCH") {
        const ruleId = m[1];
        const body = JSON.parse((init.body ?? "{}") as string);
        const newActive = body.Metadata?.active === true;
        patches.push({ ruleId, active: newActive });
        if (opts.patchBehavior !== undefined) {
          const r = opts.patchBehavior(ruleId, newActive);
          if (r instanceof Error) throw r;
          return r;
        }
        return new Response(null, { status: 204 });
      }
      // Phase-2 per-id GET — return the full record (with Metadata + FullName).
      if (m !== null && (init?.method === undefined || init.method === "GET")) {
        const ruleId = m[1];
        const rule = byId.get(ruleId);
        if (rule === undefined) {
          return new Response(`no fixture for ${ruleId}`, { status: 404 });
        }
        return new Response(JSON.stringify(rule), { status: 200 });
      }
      return new Response("unhandled", { status: 500 });
    },
  );
  return { fetchFn: fetchFn as unknown as typeof fetch, patches };
}

describe("snapshotAndDeactivate", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "vr-toggle-"));
  });
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("no-ops when objects is empty", async () => {
    const { fetchFn, patches } = makeToolingFetch({ queryResult: [] });
    const res = await snapshotAndDeactivate({
      auth: fakeAuth(),
      sessionId: "s1",
      sessionDir,
      targetOrg: "acme-dev",
      objects: [],
      fetchFn,
    });
    expect(res.touchedCount).toBe(0);
    expect(patches).toEqual([]);
    // No snapshot file should be written.
    await expect(
      stat(join(sessionDir, TOUCHED_VALIDATION_RULES_FILENAME)),
    ).rejects.toThrow();
  });

  it("no-ops (no file, no patches) when no active rules match", async () => {
    const { fetchFn, patches } = makeToolingFetch({ queryResult: [] });
    const res = await snapshotAndDeactivate({
      auth: fakeAuth(),
      sessionId: "s1",
      sessionDir,
      targetOrg: "acme-dev",
      objects: ["Contact", "Case"],
      fetchFn,
    });
    expect(res.touchedCount).toBe(0);
    expect(patches).toEqual([]);
    await expect(
      stat(join(sessionDir, TOUCHED_VALIDATION_RULES_FILENAME)),
    ).rejects.toThrow();
  });

  it("writes the snapshot file BEFORE any PATCH is issued", async () => {
    const rules = [
      fakeActive("SSN_Must_Be_9_Digits", "Contact"),
      fakeActive("Preferred_Phone_Required", "Contact"),
    ];
    // Intercept PATCH to verify the file already exists by the time the
    // first PATCH fires.
    let fileExistedAtFirstPatch: boolean | null = null;
    const { fetchFn } = makeToolingFetch({
      queryResult: rules,
      patchBehavior: (_id, _active) => {
        if (fileExistedAtFirstPatch === null) {
          // First PATCH — check for the file synchronously via Node fs.
          // Use require-equivalent since this is inside a stub.
          try {
            // statSync is fine here; we're inside a test.

            const fs = require("node:fs");
            fileExistedAtFirstPatch = fs.existsSync(
              join(sessionDir, TOUCHED_VALIDATION_RULES_FILENAME),
            );
          } catch {
            fileExistedAtFirstPatch = false;
          }
        }
        return new Response(null, { status: 204 });
      },
    });
    await snapshotAndDeactivate({
      auth: fakeAuth(),
      sessionId: "s1",
      sessionDir,
      targetOrg: "acme-dev",
      objects: ["Contact"],
      fetchFn,
    });
    expect(fileExistedAtFirstPatch).toBe(true);
  });

  it("deactivates every rule and persists them verbatim to the snapshot file", async () => {
    const rules = [
      fakeActive("Rule_A", "Contact", "03d000000000001AAA"),
      fakeActive("Rule_B", "Case", "03d000000000002AAA"),
    ];
    const { fetchFn, patches } = makeToolingFetch({ queryResult: rules });
    const res = await snapshotAndDeactivate({
      auth: fakeAuth(),
      sessionId: "s-xyz",
      sessionDir,
      targetOrg: "acme-dev",
      objects: ["Contact", "Case"],
      fetchFn,
    });
    expect(res.touchedCount).toBe(2);
    expect(patches).toEqual([
      { ruleId: "03d000000000001AAA", active: false },
      { ruleId: "03d000000000002AAA", active: false },
    ]);

    const raw = await readFile(
      join(sessionDir, TOUCHED_VALIDATION_RULES_FILENAME),
      "utf8",
    );
    const snap = JSON.parse(raw);
    expect(snap.sessionId).toBe("s-xyz");
    expect(snap.targetOrg).toBe("acme-dev");
    expect(snap.rules.length).toBe(2);
    expect(snap.rules[0].metadata.errorMessage).toBe("msg for Rule_A");
  });
});

describe("reactivateFromSnapshot", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "vr-reactivate-"));
  });
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("is a no-op when no snapshot file exists", async () => {
    const { fetchFn } = makeToolingFetch({ queryResult: [] });
    const res = await reactivateFromSnapshot({
      auth: fakeAuth(),
      sessionDir,
      fetchFn,
    });
    expect(res).toEqual({
      reactivatedCount: 0,
      failed: [],
      totalInSnapshot: 0,
    });
  });

  it("reactivates every rule in the file and renames to .reactivated.json", async () => {
    // Seed the file by running snapshotAndDeactivate first (easier than
    // hand-writing JSON, and covers the real file shape).
    const rules = [fakeActive("R1", "Contact"), fakeActive("R2", "Case")];
    {
      const { fetchFn } = makeToolingFetch({ queryResult: rules });
      await snapshotAndDeactivate({
        auth: fakeAuth(),
        sessionId: "s1",
        sessionDir,
        targetOrg: "acme-dev",
        objects: ["Contact", "Case"],
        fetchFn,
      });
    }

    const { fetchFn, patches } = makeToolingFetch({ queryResult: [] });
    const res = await reactivateFromSnapshot({
      auth: fakeAuth(),
      sessionDir,
      fetchFn,
    });
    expect(res.reactivatedCount).toBe(2);
    expect(res.failed).toEqual([]);
    expect(patches.every((p) => p.active === true)).toBe(true);

    // Original file gone, audit file present.
    await expect(
      stat(join(sessionDir, TOUCHED_VALIDATION_RULES_FILENAME)),
    ).rejects.toThrow();
    const archived = await readFile(
      join(sessionDir, REACTIVATED_VALIDATION_RULES_FILENAME),
      "utf8",
    );
    expect(JSON.parse(archived).rules.length).toBe(2);
  });

  it("narrows the snapshot to failed rules on partial failure", async () => {
    const rules = [
      fakeActive("R_GOOD", "Contact", "03d000000000001AAA"),
      fakeActive("R_BAD", "Contact", "03d000000000002AAA"),
    ];
    {
      const { fetchFn } = makeToolingFetch({ queryResult: rules });
      await snapshotAndDeactivate({
        auth: fakeAuth(),
        sessionId: "s1",
        sessionDir,
        targetOrg: "acme-dev",
        objects: ["Contact"],
        fetchFn,
      });
    }

    // Reactivate fails on R_BAD only.
    const { fetchFn } = makeToolingFetch({
      queryResult: [],
      patchBehavior: (id, _active) =>
        id === "03d000000000002AAA"
          ? new Response("FIELD_INTEGRITY_EXCEPTION", { status: 400 })
          : new Response(null, { status: 204 }),
    });
    const res = await reactivateFromSnapshot({
      auth: fakeAuth(),
      sessionDir,
      fetchFn,
    });
    expect(res.reactivatedCount).toBe(1);
    expect(res.failed.map((f) => f.fullName)).toEqual(["Contact.R_BAD"]);

    // Snapshot still present, now only the failed rule.
    const raw = await readFile(
      join(sessionDir, TOUCHED_VALIDATION_RULES_FILENAME),
      "utf8",
    );
    const snap = JSON.parse(raw);
    expect(snap.rules.length).toBe(1);
    expect(snap.rules[0].validationName).toBe("R_BAD");
  });

  it("tolerates a corrupted snapshot by leaving it in place (no throw)", async () => {
    await writeFile(
      join(sessionDir, TOUCHED_VALIDATION_RULES_FILENAME),
      "not json",
      "utf8",
    );
    const { fetchFn, patches } = makeToolingFetch({ queryResult: [] });
    const res = await reactivateFromSnapshot({
      auth: fakeAuth(),
      sessionDir,
      fetchFn,
    });
    expect(res).toEqual({
      reactivatedCount: 0,
      failed: [],
      totalInSnapshot: 0,
    });
    expect(patches).toEqual([]);
    // File still present for manual inspection.
    await expect(
      stat(join(sessionDir, TOUCHED_VALIDATION_RULES_FILENAME)),
    ).resolves.toBeTruthy();
  });
});

describe("findPendingRecoveries", () => {
  let sessionsRoot: string;

  beforeEach(async () => {
    sessionsRoot = await mkdtemp(join(tmpdir(), "vr-pending-"));
  });
  afterEach(async () => {
    await rm(sessionsRoot, { recursive: true, force: true });
  });

  it("returns [] when the root doesn't exist", async () => {
    const res = await findPendingRecoveries(
      join(sessionsRoot, "does-not-exist"),
    );
    expect(res).toEqual([]);
  });

  it("finds touched-validation-rules.json but IGNORES .reactivated.json", async () => {
    // Session A: pending.
    const sessionA = join(sessionsRoot, "session-a");
    const sessionB = join(sessionsRoot, "session-b");
    await rm(sessionA, { recursive: true, force: true });
    await rm(sessionB, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionA, { recursive: true });
    await mkdir(sessionB, { recursive: true });

    await writeFile(
      join(sessionA, TOUCHED_VALIDATION_RULES_FILENAME),
      JSON.stringify({
        sessionId: "session-a",
        targetOrg: "acme-dev",
        snapshotAt: "2026-04-19T12:00:00Z",
        rules: [{ id: "03d..." }, { id: "03d..." }],
      }),
      "utf8",
    );

    // Session B: has only the reactivated archive.
    await writeFile(
      join(sessionB, REACTIVATED_VALIDATION_RULES_FILENAME),
      JSON.stringify({ sessionId: "session-b", rules: [{ id: "03d..." }] }),
      "utf8",
    );

    const pending = await findPendingRecoveries(sessionsRoot);
    expect(pending.length).toBe(1);
    expect(pending[0].sessionId).toBe("session-a");
    expect(pending[0].count).toBe(2);
  });

  it("reports corrupt snapshots as pending so the user notices", async () => {
    const { mkdir } = await import("node:fs/promises");
    const sessionC = join(sessionsRoot, "session-c");
    await mkdir(sessionC, { recursive: true });
    await writeFile(
      join(sessionC, TOUCHED_VALIDATION_RULES_FILENAME),
      "garbage",
      "utf8",
    );
    const pending = await findPendingRecoveries(sessionsRoot);
    expect(pending.length).toBe(1);
    expect(pending[0].targetOrg).toContain("corrupt");
  });
});
