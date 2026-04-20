import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { SessionStore, type Session } from "../../src/seed/session.ts";

/**
 * Replace the `seed` MCP function with a fake that drives a real
 * `SessionStore` so the playbook tool's freshness gate (which calls
 * `SessionStore.load`) sees real session.json files on disk.
 *
 * `__seedSpy` and `__seedConfig` let each test inspect call order,
 * counts, and inject per-action behavior (errors, custom summaries).
 */
type FakeSeedConfig = {
  /** When set, `run` for this stepName throws this error. */
  runErrors?: Record<string, string>;
  /** Custom dry_run summary fields per stepName (object name -> count). */
  perObjectCounts?: Record<string, Record<string, number>>;
  /** Custom alreadySeededCounts per stepName. */
  alreadySeededCounts?: Record<string, Record<string, number>>;
  /** Custom insertedCounts per stepName for `run`. */
  insertedCounts?: Record<string, Record<string, number>>;
};

const seedSpy: Mock = vi.fn();
const seedConfig: FakeSeedConfig = {};

vi.mock("../../src/mcp/tools/seed.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    seed: async (
      args: Record<string, unknown>,
      overrides: { sessionRootDir?: string } = {},
    ) => {
      seedSpy(args, overrides);
      const { SessionStore } = await import("../../src/seed/session.ts");
      const store = new SessionStore({ rootDir: overrides.sessionRootDir });
      const action = args.action as string;

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
          summary: { sessionId: session.id, matchedCount: 10 },
          nextAction: "analyze",
          guidance: "ok",
        };
      }

      const sessionId = String(args.sessionId);
      const session = await store.load(sessionId);

      if (action === "analyze") {
        session.step = "analyzed";
        session.mustIncludeParents = [];
        session.optionalParents = [];
        session.optionalChildren = [];
        session.analyzedLoadOrder = [session.rootObject];
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
        session.finalLoadOrder = [session.rootObject];
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
        const stepName = stepNameForSession(session);
        const perObj =
          seedConfig.perObjectCounts?.[stepName] ??
          { [session.rootObject]: 5 };
        const already = seedConfig.alreadySeededCounts?.[stepName];
        const total = Object.values(perObj).reduce((a, b) => a + b, 0);
        const reportPath = join(store.sessionDir(sessionId), "dry-run.md");
        await writeFile(reportPath, "# fake report\n", "utf8");
        session.step = "dry_run_complete";
        session.dryRun = {
          reportPath,
          perObjectCounts: perObj,
          totalRecords: total,
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
            totalRecords: total,
            alreadySeededCounts: already,
            schemaWarningCount: 0,
          },
          nextAction: "run",
          guidance: "ok",
        };
      }

      if (action === "run") {
        const stepName = stepNameForSession(session);
        const errMsg = seedConfig.runErrors?.[stepName];
        if (errMsg !== undefined) {
          throw new Error(errMsg);
        }
        const inserted =
          seedConfig.insertedCounts?.[stepName] ??
          { [session.rootObject]: 5 };
        const logPath = join(store.sessionDir(sessionId), "execute.log");
        await writeFile(logPath, "", "utf8");
        session.step = "executed";
        session.executed = {
          logPath,
          idMapPath: join(store.sessionDir(sessionId), "id-map.json"),
          insertedCounts: inserted,
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
            insertedCounts: inserted,
            errorCount: 0,
          },
          nextAction: null,
          guidance: "ok",
        };
      }

      throw new Error(`fake seed: unsupported action ${action}`);
    },
  };
});

/**
 * Extract the playbook step name from the session's rootObject. Each
 * step in our fixtures uses a unique object so we can map back.
 */
function stepNameForSession(session: Session): string {
  // Tests below use a 1:1 object<->step mapping by convention.
  return rootToStepName.get(session.rootObject) ?? session.rootObject;
}

const rootToStepName = new Map<string, string>();

// Imported AFTER vi.mock so the mock is in effect.
const { playbook } = await import("../../src/mcp/tools/playbook.ts");

describe("playbook tool: dry_run + run flow", () => {
  let root: string;
  let sessionRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pb-run-"));
    sessionRoot = await mkdtemp(join(tmpdir(), "pb-run-sess-"));
    await mkdir(join(root, "playbooks"), { recursive: true });
    seedSpy.mockClear();
    rootToStepName.clear();
    delete seedConfig.runErrors;
    delete seedConfig.perObjectCounts;
    delete seedConfig.alreadySeededCounts;
    delete seedConfig.insertedCounts;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sessionRoot, { recursive: true, force: true });
  });

  async function writePlaybook(name: string, body: string): Promise<void> {
    await writeFile(join(root, "playbooks", `${name}.yml`), body, "utf8");
  }

  const TWO_STEP = `
apiVersion: sandbox-seed/v1
kind: Playbook
name: two-step
defaults:
  sourceOrg: prod
  targetOrg: dev
steps:
  - name: accounts
    object: Account
    whereClause: "Industry = 'Tech'"
  - name: contacts
    object: Contact
    whereClause: "Account.Industry = 'Tech'"
`.trimStart();

  it("dry_run drives every step through start→analyze→select→dry_run", async () => {
    rootToStepName.set("Account", "accounts");
    rootToStepName.set("Contact", "contacts");
    seedConfig.perObjectCounts = {
      accounts: { Account: 7 },
      contacts: { Contact: 11 },
    };
    await writePlaybook("two-step", TWO_STEP);
    const res = await playbook(
      { action: "dry_run", name: "two-step" },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );

    // 4 actions × 2 steps = 8 seed calls
    expect(seedSpy).toHaveBeenCalledTimes(8);
    const actions = seedSpy.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual([
      "start", "analyze", "select", "dry_run",
      "start", "analyze", "select", "dry_run",
    ]);

    const summary = res.summary as Record<string, unknown>;
    expect(summary.stepCount).toBe(2);
    expect(summary.totalRecords).toBe(18);
    expect(summary.aggregatedReportPath).toMatch(/aggregated-dry-run\.md$/);

    const aggBody = await readFile(
      summary.aggregatedReportPath as string,
      "utf8",
    );
    expect(aggBody).toContain("two-step");
    expect(aggBody).toContain("`accounts`");
    expect(aggBody).toContain("`contacts`");
  });

  it("run executes each step's session in playbook order with confirm:true", async () => {
    rootToStepName.set("Account", "accounts");
    rootToStepName.set("Contact", "contacts");
    seedConfig.insertedCounts = {
      accounts: { Account: 7 },
      contacts: { Contact: 11 },
    };
    await writePlaybook("two-step", TWO_STEP);

    const dryRunRes = await playbook(
      { action: "dry_run", name: "two-step" },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );
    const runId = (dryRunRes.summary as Record<string, unknown>)
      .playbookRunId as string;

    seedSpy.mockClear();

    const runRes = await playbook(
      { action: "run", playbookRunId: runId, confirm: true },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );

    expect(seedSpy).toHaveBeenCalledTimes(2);
    expect(seedSpy.mock.calls[0][0]).toMatchObject({
      action: "run",
      confirm: true,
    });
    expect(seedSpy.mock.calls[1][0]).toMatchObject({
      action: "run",
      confirm: true,
    });
    // Step order preserved: accounts session first, then contacts.
    const sids = seedSpy.mock.calls.map((c) => c[0].sessionId);
    expect(sids[0]).not.toBe(sids[1]);

    const summary = runRes.summary as Record<string, unknown>;
    expect(summary.totalInserted).toBe(18);
    expect(summary.errorCount).toBe(0);
  });

  it("run requires confirm:true", async () => {
    await writePlaybook("two-step", TWO_STEP);
    await expect(
      playbook(
        { action: "run", playbookRunId: "anything" },
        { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
      ),
    ).rejects.toThrow(/confirm/i);
  });

  it("run requires a playbookRunId", async () => {
    await expect(
      playbook(
        { action: "run", confirm: true },
        { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
      ),
    ).rejects.toThrow(/playbookRunId/);
  });

  it("aborts on first error when continueOnError is unset", async () => {
    rootToStepName.set("Account", "accounts");
    rootToStepName.set("Contact", "contacts");
    seedConfig.runErrors = { accounts: "boom: account insert failed" };
    await writePlaybook("two-step", TWO_STEP);

    const dr = await playbook(
      { action: "dry_run", name: "two-step" },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );
    const runId = (dr.summary as Record<string, unknown>)
      .playbookRunId as string;

    seedSpy.mockClear();
    const runRes = await playbook(
      { action: "run", playbookRunId: runId, confirm: true },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );

    // Only one `run` call attempted before abort; second step skipped.
    expect(seedSpy).toHaveBeenCalledTimes(1);
    const summary = runRes.summary as Record<string, unknown>;
    expect(summary.errorCount).toBe(1);
    const perStep = summary.perStep as Array<Record<string, unknown>>;
    expect(perStep[0].status).toBe("errored");
    expect(perStep[1].status).toBe("skipped");
  });

  it("continueOnError lets later steps run after a failure", async () => {
    rootToStepName.set("Account", "accounts");
    rootToStepName.set("Contact", "contacts");
    seedConfig.runErrors = { accounts: "boom" };
    seedConfig.insertedCounts = { contacts: { Contact: 4 } };
    await writePlaybook(
      "two-step",
      `
apiVersion: sandbox-seed/v1
kind: Playbook
name: two-step
defaults:
  sourceOrg: prod
  targetOrg: dev
steps:
  - name: accounts
    object: Account
    whereClause: "Industry = 'Tech'"
    continueOnError: true
  - name: contacts
    object: Contact
    whereClause: "Account.Industry = 'Tech'"
`.trimStart(),
    );

    const dr = await playbook(
      { action: "dry_run", name: "two-step" },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );
    const runId = (dr.summary as Record<string, unknown>)
      .playbookRunId as string;

    seedSpy.mockClear();
    const runRes = await playbook(
      { action: "run", playbookRunId: runId, confirm: true },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );

    expect(seedSpy).toHaveBeenCalledTimes(2);
    const summary = runRes.summary as Record<string, unknown>;
    expect(summary.errorCount).toBe(1);
    expect(summary.totalInserted).toBe(4);
    const perStep = summary.perStep as Array<Record<string, unknown>>;
    expect(perStep[0].status).toBe("errored");
    expect(perStep[1].status).toBe("executed");
  });

  it("freshness gate refuses run when a step's dry_run is stale", async () => {
    rootToStepName.set("Account", "accounts");
    rootToStepName.set("Contact", "contacts");
    await writePlaybook("two-step", TWO_STEP);

    const dr = await playbook(
      { action: "dry_run", name: "two-step" },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );
    const runId = (dr.summary as Record<string, unknown>)
      .playbookRunId as string;

    // Backdate the first step's session.dryRun.completedAt past the
    // 24h freshness window.
    const store = new SessionStore({ rootDir: sessionRoot });
    const manifestPath = join(
      root,
      "playbook-runs",
      runId,
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      steps: Array<{ sessionId: string }>;
    };
    const stale = await store.load(manifest.steps[0].sessionId);
    if (stale.dryRun !== undefined) {
      stale.dryRun.completedAt = new Date(
        Date.now() - 25 * 60 * 60 * 1000,
      ).toISOString();
      await store.save(stale);
    }

    await expect(
      playbook(
        { action: "run", playbookRunId: runId, confirm: true },
        { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
      ),
    ).rejects.toThrow(/older than/i);
  });

  it("rejects run when playbook YAML diverged (step name changed) since dry_run", async () => {
    rootToStepName.set("Account", "accounts");
    rootToStepName.set("Contact", "contacts");
    await writePlaybook("two-step", TWO_STEP);

    const dr = await playbook(
      { action: "dry_run", name: "two-step" },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );
    const runId = (dr.summary as Record<string, unknown>)
      .playbookRunId as string;

    // Edit the playbook between dry_run and run.
    await writePlaybook(
      "two-step",
      TWO_STEP.replace("name: contacts", "name: contacts-renamed"),
    );

    await expect(
      playbook(
        { action: "run", playbookRunId: runId, confirm: true },
        { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
      ),
    ).rejects.toThrow(/diverged/i);
  });

  it("list returns playbooks with metadata", async () => {
    await writePlaybook("two-step", TWO_STEP);
    const res = await playbook(
      { action: "list" },
      { rootDir: root, seedOverrides: { sessionRootDir: sessionRoot } },
    );
    const summary = res.summary as Record<string, unknown>;
    expect(summary.count).toBe(1);
    const items = summary.playbooks as Array<{ name: string; stepCount: number }>;
    expect(items[0].name).toBe("two-step");
    expect(items[0].stepCount).toBe(2);
  });
});
