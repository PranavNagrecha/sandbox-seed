import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectIdMap,
  type TargetIdentity,
} from "../../src/seed/project-id-map.ts";
import { SessionStore } from "../../src/seed/session.ts";

/**
 * Cross-run stitching: three sequential playbook runs against the same
 * (sourceOrg, targetOrg) pair share a single persistent project id-map
 * under <root>/id-maps/<source>__<target>.json. Records seeded by run N
 * are recognized as "already seeded" by run N+1's dry-run, and the FK
 * targets carry forward.
 *
 * The fake `seed` below is wired into the same ProjectIdMap module the
 * production execute.ts uses — so the project-map file on disk is the
 * real artifact, and the assertions below probe its actual contents.
 */

const TARGET_IDENTITY: TargetIdentity = {
  orgId: "00D000000000000BBB",
  lastRefreshDate: "2026-04-01T00:00:00.000Z",
};

/**
 * Minimal per-step "scope" the fake seed will turn into project-map
 * entries on `run`. Indexed by playbook step name. Each entry is a
 * source ID; the fake assigns a fresh target ID on insert.
 */
const stepScope: Record<string, Array<{ object: string; sourceId: string }>> =
  {};

/** Records what the fake seed observed at each call (for assertions). */
type RecordedDryRun = {
  stepName: string;
  alreadySeededCounts: Record<string, number>;
};
const dryRunObserved: RecordedDryRun[] = [];

const seedSpy = vi.fn();

vi.mock("../../src/mcp/tools/seed.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    seed: async (
      args: Record<string, unknown>,
      overrides: { sessionRootDir?: string; rootDir?: string } & {
        rootDir?: string;
      } = {},
    ) => {
      seedSpy(args, overrides);
      const { SessionStore } = await import("../../src/seed/session.ts");
      const { ProjectIdMap } = await import(
        "../../src/seed/project-id-map.ts"
      );
      const action = args.action as string;
      const store = new SessionStore({ rootDir: overrides.sessionRootDir });

      if (action === "start") {
        const session = await store.create({
          sourceOrg: String(args.sourceOrg),
          targetOrg: String(args.targetOrg),
          rootObject: String(args.object),
          whereClause: String(args.whereClause),
          limit: (args.limit as number | undefined) ?? null,
        });
        return {
          sessionId: session.id,
          step: "started",
          action: "start",
          summary: { sessionId: session.id },
          nextAction: "analyze",
          guidance: "ok",
        };
      }

      const sessionId = String(args.sessionId);
      const session = await store.load(sessionId);
      const stepName = stepNameForObject(session.rootObject, session);

      if (action === "analyze") {
        session.step = "analyzed";
        session.finalObjectList = [session.rootObject];
        session.finalLoadOrder = [session.rootObject];
        await store.save(session);
        return {
          sessionId,
          step: "analyzed",
          action: "analyze",
          summary: {},
          nextAction: "select",
          guidance: "ok",
        };
      }
      if (action === "select") {
        session.step = "selected";
        session.finalObjectList = [session.rootObject];
        await store.save(session);
        return {
          sessionId,
          step: "selected",
          action: "select",
          summary: {},
          nextAction: "dry_run",
          guidance: "ok",
        };
      }
      if (action === "dry_run") {
        const projectMap = new ProjectIdMap({
          rootDir: idMapRoot,
          sourceAlias: session.sourceOrg,
          targetAlias: session.targetOrg,
        });
        const loaded = await projectMap.load(TARGET_IDENTITY);
        const scope = stepScope[stepName] ?? [];
        const perObj: Record<string, number> = { [session.rootObject]: scope.length };
        const already: Record<string, number> = { [session.rootObject]: 0 };
        for (const row of scope) {
          if (loaded.entries[`${row.object}:${row.sourceId}`] !== undefined) {
            already[row.object] = (already[row.object] ?? 0) + 1;
          }
        }
        dryRunObserved.push({
          stepName,
          alreadySeededCounts: { ...already },
        });
        const reportPath = join(store.sessionDir(sessionId), "dry-run.md");
        await writeFile(reportPath, "# fake\n", "utf8");
        session.step = "dry_run_complete";
        session.dryRun = {
          reportPath,
          perObjectCounts: perObj,
          totalRecords: scope.length,
          completedAt: new Date().toISOString(),
          targetSchemaIssues: [],
          alreadySeededCounts: already,
        };
        await store.save(session);
        return {
          sessionId,
          step: "dry_run_complete",
          action: "dry_run",
          summary: {
            reportPath,
            perObjectCounts: perObj,
            totalRecords: scope.length,
            alreadySeededCounts: already,
            schemaWarningCount: 0,
          },
          nextAction: "run",
          guidance: "ok",
        };
      }
      if (action === "run") {
        const projectMap = new ProjectIdMap({
          rootDir: idMapRoot,
          sourceAlias: session.sourceOrg,
          targetAlias: session.targetOrg,
        });
        const prior = await projectMap.load(TARGET_IDENTITY);
        const scope = stepScope[stepName] ?? [];
        const incoming: Record<string, string> = {};
        let inserted = 0;
        for (const row of scope) {
          const key = `${row.object}:${row.sourceId}`;
          if (prior.entries[key] !== undefined) continue; // dedup via project map
          incoming[key] = `T_${row.object}_${row.sourceId}`;
          inserted++;
        }
        await projectMap.merge(incoming, TARGET_IDENTITY);
        const logPath = join(store.sessionDir(sessionId), "execute.log");
        await writeFile(logPath, "", "utf8");
        session.step = "executed";
        session.executed = {
          logPath,
          idMapPath: join(store.sessionDir(sessionId), "id-map.json"),
          insertedCounts: { [session.rootObject]: inserted },
          completedAt: new Date().toISOString(),
          errorCount: 0,
        };
        await store.save(session);
        return {
          sessionId,
          step: "executed",
          action: "run",
          summary: {
            logPath,
            insertedCounts: { [session.rootObject]: inserted },
            errorCount: 0,
          },
          nextAction: null,
          guidance: "ok",
        };
      }
      throw new Error(`unsupported: ${action}`);
    },
  };
});

let idMapRoot = "";

function stepNameForObject(
  rootObject: string,
  session: { sourceOrg: string },
): string {
  // Test-fixture convention: object name + originating playbook tag.
  // We look up by exact object — each playbook below uses unique
  // pairings, and the "Contact" step appears in two playbooks but
  // intentionally points at the same scope (so dedup kicks in).
  void session;
  return rootObject;
}

const { playbook } = await import("../../src/mcp/tools/playbook.ts");

describe("playbook: cross-run stitching via persistent project id-map", () => {
  let root: string;
  let sessionRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pb-stitch-"));
    sessionRoot = await mkdtemp(join(tmpdir(), "pb-stitch-sess-"));
    idMapRoot = root;
    await mkdir(join(root, "playbooks"), { recursive: true });
    seedSpy.mockClear();
    dryRunObserved.length = 0;
    for (const k of Object.keys(stepScope)) delete stepScope[k];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sessionRoot, { recursive: true, force: true });
  });

  async function writePlaybook(name: string, body: string): Promise<void> {
    await writeFile(join(root, "playbooks", `${name}.yml`), body, "utf8");
  }

  async function runPlaybookEndToEnd(name: string): Promise<void> {
    const dr = await playbook(
      { action: "dry_run", name },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );
    const runId = (dr.summary as Record<string, unknown>)
      .playbookRunId as string;
    await playbook(
      { action: "run", playbookRunId: runId, confirm: true },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );
  }

  it("three playbooks against the same orgs share one project id-map and dedup across runs", async () => {
    // === Playbook A: Accounts (3) + Contacts (4) ===
    stepScope.Account = [
      { object: "Account", sourceId: "A1" },
      { object: "Account", sourceId: "A2" },
      { object: "Account", sourceId: "A3" },
    ];
    stepScope.Contact = [
      { object: "Contact", sourceId: "C1" },
      { object: "Contact", sourceId: "C2" },
      { object: "Contact", sourceId: "C3" },
      { object: "Contact", sourceId: "C4" },
    ];
    await writePlaybook(
      "playbook-a",
      `
apiVersion: sandbox-seed/v1
kind: Playbook
name: playbook-a
defaults:
  sourceOrg: prod
  targetOrg: dev
steps:
  - { name: accounts, object: Account, whereClause: "Id != null" }
  - { name: contacts, object: Contact, whereClause: "Id != null" }
`.trimStart(),
    );
    await runPlaybookEndToEnd("playbook-a");

    // The project map file should now contain 3 Accounts + 4 Contacts.
    const projectMap = new ProjectIdMap({
      rootDir: root,
      sourceAlias: "prod",
      targetAlias: "dev",
    });
    let loaded = await projectMap.load(TARGET_IDENTITY);
    expect(Object.keys(loaded.entries).sort()).toEqual([
      "Account:A1",
      "Account:A2",
      "Account:A3",
      "Contact:C1",
      "Contact:C2",
      "Contact:C3",
      "Contact:C4",
    ]);
    // Target IDs follow our fake's `T_<obj>_<srcId>` shape.
    expect(loaded.entries["Account:A1"]).toBe("T_Account_A1");

    // === Playbook B: Applications (2) + Contacts (3 NEW + 4 OVERLAP from A) ===
    stepScope.Application__c = [
      { object: "Application__c", sourceId: "AP1" },
      { object: "Application__c", sourceId: "AP2" },
    ];
    stepScope.Contact = [
      { object: "Contact", sourceId: "C1" }, // overlap
      { object: "Contact", sourceId: "C2" }, // overlap
      { object: "Contact", sourceId: "C3" }, // overlap
      { object: "Contact", sourceId: "C4" }, // overlap
      { object: "Contact", sourceId: "C5" }, // new
      { object: "Contact", sourceId: "C6" }, // new
      { object: "Contact", sourceId: "C7" }, // new
    ];
    await writePlaybook(
      "playbook-b",
      `
apiVersion: sandbox-seed/v1
kind: Playbook
name: playbook-b
defaults:
  sourceOrg: prod
  targetOrg: dev
steps:
  - { name: applications, object: Application__c, whereClause: "Id != null" }
  - { name: contacts, object: Contact, whereClause: "Id != null" }
`.trimStart(),
    );
    dryRunObserved.length = 0;
    await runPlaybookEndToEnd("playbook-b");

    // Contacts step's dry_run should have observed 4 already-seeded.
    const bContactsDryRun = dryRunObserved.find((r) => r.stepName === "Contact");
    expect(bContactsDryRun?.alreadySeededCounts.Contact).toBe(4);

    loaded = await projectMap.load(TARGET_IDENTITY);
    // 3 Accounts + 7 Contacts (4 reused + 3 new) + 2 Applications = 12
    expect(Object.keys(loaded.entries)).toHaveLength(12);
    // New Contacts present, old Contacts unchanged target id.
    expect(loaded.entries["Contact:C5"]).toBe("T_Contact_C5");
    expect(loaded.entries["Contact:C1"]).toBe("T_Contact_C1");

    // === Playbook C: Term (2) + Accounts (3 OVERLAP from A) ===
    stepScope.Term__c = [
      { object: "Term__c", sourceId: "T1" },
      { object: "Term__c", sourceId: "T2" },
    ];
    stepScope.Account = [
      { object: "Account", sourceId: "A1" }, // overlap
      { object: "Account", sourceId: "A2" }, // overlap
      { object: "Account", sourceId: "A3" }, // overlap
    ];
    await writePlaybook(
      "playbook-c",
      `
apiVersion: sandbox-seed/v1
kind: Playbook
name: playbook-c
defaults:
  sourceOrg: prod
  targetOrg: dev
steps:
  - { name: terms, object: Term__c, whereClause: "Id != null" }
  - { name: accounts, object: Account, whereClause: "Id != null" }
`.trimStart(),
    );
    dryRunObserved.length = 0;
    await runPlaybookEndToEnd("playbook-c");

    // Accounts step's dry_run should have observed all 3 already-seeded.
    const cAccountsDryRun = dryRunObserved.find((r) => r.stepName === "Account");
    expect(cAccountsDryRun?.alreadySeededCounts.Account).toBe(3);

    loaded = await projectMap.load(TARGET_IDENTITY);
    // 3 Accounts (no growth) + 7 Contacts + 2 Applications + 2 Terms = 14
    expect(Object.keys(loaded.entries)).toHaveLength(14);
    // FK continuity: Account target IDs from playbook A are still here.
    expect(loaded.entries["Account:A1"]).toBe("T_Account_A1");
    expect(loaded.entries["Account:A2"]).toBe("T_Account_A2");
    expect(loaded.entries["Account:A3"]).toBe("T_Account_A3");
  });

  it("isolates the project map per (source, target) alias pair", async () => {
    stepScope.Account = [{ object: "Account", sourceId: "A1" }];
    await writePlaybook(
      "to-dev",
      `
apiVersion: sandbox-seed/v1
kind: Playbook
name: to-dev
defaults: { sourceOrg: prod, targetOrg: dev }
steps:
  - { name: accounts, object: Account, whereClause: "Id != null" }
`.trimStart(),
    );
    await writePlaybook(
      "to-uat",
      `
apiVersion: sandbox-seed/v1
kind: Playbook
name: to-uat
defaults: { sourceOrg: prod, targetOrg: uat }
steps:
  - { name: accounts, object: Account, whereClause: "Id != null" }
`.trimStart(),
    );
    await runPlaybookEndToEnd("to-dev");
    await runPlaybookEndToEnd("to-uat");

    const devMap = await new ProjectIdMap({
      rootDir: root,
      sourceAlias: "prod",
      targetAlias: "dev",
    }).load(TARGET_IDENTITY);
    const uatMap = await new ProjectIdMap({
      rootDir: root,
      sourceAlias: "prod",
      targetAlias: "uat",
    }).load(TARGET_IDENTITY);
    expect(Object.keys(devMap.entries)).toEqual(["Account:A1"]);
    expect(Object.keys(uatMap.entries)).toEqual(["Account:A1"]);

    // Files genuinely separate.
    const devFile = await readFile(
      join(root, "id-maps", "prod__dev.json"),
      "utf8",
    );
    const uatFile = await readFile(
      join(root, "id-maps", "prod__uat.json"),
      "utf8",
    );
    expect(devFile).toBe(uatFile); // identical contents, different files
  });
});

// Suppress unused-import warning — SessionStore is exported for type inference
// in the fake seed module above.
void SessionStore;
