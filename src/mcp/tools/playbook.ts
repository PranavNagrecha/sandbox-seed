import { z } from "zod";
import { UserError } from "../../errors.ts";
import { writeAggregatedDryRun, type AggregateStepInput } from "../../playbook/aggregate-dry-run.ts";
import {
  listPlaybooks,
  loadPlaybookByName,
  playbooksDir,
} from "../../playbook/load.ts";
import {
  newPlaybookRunId,
  PlaybookRunStore,
} from "../../playbook/run-store.ts";
import type {
  Playbook,
  PlaybookRunManifest,
  PlaybookStep,
} from "../../playbook/types.ts";
import {
  DRY_RUN_FRESHNESS_MS,
  isDryRunFresh,
  SessionStore,
} from "../../seed/session.ts";
import { seed, type SeedOverrides, type SeedResponse } from "./seed.ts";

/**
 * The `playbook` MCP tool: chain N ordered seed steps into one run.
 *
 * Composes the existing `seed()` function in a loop — does NOT
 * re-implement seeding. Each step gets its own session under
 * `~/.sandbox-seed/sessions/<sid>/`; the playbook adds a parent
 * manifest at `~/.sandbox-seed/playbook-runs/<run-id>/`.
 *
 * The aggregated dry-run report (one per playbook run, all steps rolled
 * up) is written to disk; the response references it by path. Cross-run
 * FK stitching across step boundaries works for free via the persistent
 * project-level id-map (see `src/seed/project-id-map.ts`).
 */
export const PlaybookArgs = z.object({
  action: z
    .enum(["list", "dry_run", "run"])
    .describe(
      "Which step of the playbook flow to execute. " +
        "`list` lists available playbooks. " +
        "`dry_run` parses the YAML, walks every step through the seed wizard up to dry-run, and writes one aggregated report. " +
        "`run` executes every step in order against its session — requires the playbookRunId from a recent dry_run + confirm:true.",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Playbook filename stem (no `.yml` extension). Required for action=dry_run."),
  playbookRunId: z
    .string()
    .min(1)
    .optional()
    .describe("Returned by action=dry_run. Required for action=run."),
  confirm: z
    .literal(true)
    .optional()
    .describe("For action=run. Must be `true` — final confirmation gate."),
});

export type PlaybookArgsT = z.infer<typeof PlaybookArgs>;

export type PlaybookResponse = {
  action: PlaybookArgsT["action"];
  summary: Record<string, unknown>;
  guidance: string;
};

export type PlaybookOverrides = {
  /** Defaults to `~/.sandbox-seed`. */
  rootDir?: string;
  /** Forwarded to every per-step `seed()` call. */
  seedOverrides?: SeedOverrides;
};

export async function playbook(
  args: PlaybookArgsT,
  overrides: PlaybookOverrides = {},
): Promise<PlaybookResponse> {
  switch (args.action) {
    case "list":
      return await doList(overrides);
    case "dry_run":
      return await doDryRun(args, overrides);
    case "run":
      return await doRun(args, overrides);
  }
}

async function doList(overrides: PlaybookOverrides): Promise<PlaybookResponse> {
  const dir = playbooksDir(overrides.rootDir);
  const items = await listPlaybooks(overrides.rootDir);
  return {
    action: "list",
    summary: {
      playbooksDir: dir,
      count: items.length,
      playbooks: items,
    },
    guidance:
      items.length === 0
        ? `No playbooks found under ${dir}. Drop a YAML file there (apiVersion: sandbox-seed/v1, kind: Playbook) to get started.`
        : `Found ${items.length} playbook(s). Call action: "dry_run" with the chosen name to see what would run.`,
  };
}

async function doDryRun(
  args: PlaybookArgsT,
  overrides: PlaybookOverrides,
): Promise<PlaybookResponse> {
  if (args.name === undefined) {
    throw new UserError(
      `action: "dry_run" requires \`name\`.`,
      `Pass the playbook filename stem (no .yml extension).`,
    );
  }
  const { playbook: pb, path: playbookPath } = await loadPlaybookByName(
    args.name,
    overrides.rootDir,
  );

  const runId = newPlaybookRunId();
  const runStore = new PlaybookRunStore({ rootDir: overrides.rootDir });
  const manifest: PlaybookRunManifest = {
    playbookRunId: runId,
    playbookName: pb.name,
    playbookPath,
    createdAt: new Date().toISOString(),
    steps: pb.steps.map((s) => ({
      name: s.name,
      sessionId: "",
      status: "pending" as const,
    })),
  };
  await runStore.create(manifest);

  const aggInputs: AggregateStepInput[] = [];
  for (let i = 0; i < pb.steps.length; i++) {
    const step = pb.steps[i];
    const merged = mergeStepWithDefaults(step, pb);
    let res: SeedResponse;
    try {
      res = await driveStepThroughDryRun(merged, overrides.seedOverrides);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      manifest.steps[i].status = "errored";
      manifest.steps[i].errorMessage = msg;
      await runStore.save(manifest);
      throw new UserError(
        `Playbook "${pb.name}" failed at dry_run for step "${step.name}": ${msg}`,
        `Fix the step and re-run action: "dry_run". Manifest: ${runStore.runDir(runId)}.`,
      );
    }

    const summary = res.summary as Record<string, unknown>;
    const sessionId = res.sessionId;
    manifest.steps[i].sessionId = sessionId;
    manifest.steps[i].status = "dry_run_complete";
    manifest.steps[i].dryRunReportPath = String(summary.reportPath ?? "");
    manifest.steps[i].dryRunTotalRecords = Number(summary.totalRecords ?? 0);

    aggInputs.push({
      stepName: step.name,
      sessionId,
      perObjectCounts:
        (summary.perObjectCounts as Record<string, number>) ?? {},
      totalRecords: Number(summary.totalRecords ?? 0),
      alreadySeededCounts:
        (summary.alreadySeededCounts as Record<string, number> | undefined) ??
        undefined,
      schemaIssueCount: Number(summary.schemaWarningCount ?? 0),
      reportPath: String(summary.reportPath ?? ""),
      projectIdMapPath: summary.projectIdMapPath as string | undefined,
      projectIdMapInvalidated: summary.projectIdMapInvalidated as
        | AggregateStepInput["projectIdMapInvalidated"]
        | undefined,
    });
  }

  const completedAt = new Date().toISOString();
  manifest.dryRunAggregatedAt = completedAt;
  await runStore.save(manifest);

  const aggregatedPath = runStore.aggregatedDryRunPath(runId);
  await writeAggregatedDryRun({
    outputPath: aggregatedPath,
    playbook: pb,
    runId,
    completedAt,
    steps: aggInputs,
  });

  const totalRecords = aggInputs.reduce((a, s) => a + s.totalRecords, 0);
  const totalAlready = aggInputs.reduce(
    (a, s) =>
      a + Object.values(s.alreadySeededCounts ?? {}).reduce((x, y) => x + y, 0),
    0,
  );

  return {
    action: "dry_run",
    summary: {
      playbookRunId: runId,
      playbookName: pb.name,
      stepCount: pb.steps.length,
      totalRecords,
      totalAlreadySeeded: totalAlready,
      perStep: aggInputs.map((s) => ({
        name: s.stepName,
        sessionId: s.sessionId,
        totalRecords: s.totalRecords,
        reportPath: s.reportPath,
      })),
      aggregatedReportPath: aggregatedPath,
      manifestPath: `${runStore.runDir(runId)}/manifest.json`,
    },
    guidance:
      `Dry-run complete for ${pb.steps.length} step(s); ${totalRecords} total record(s) in scope` +
      (totalAlready > 0
        ? ` (${totalAlready} would be skipped via project id-map)`
        : "") +
      `. Review ${aggregatedPath}. When the user confirms, call ` +
      `playbook with action: "run", playbookRunId: "${runId}", confirm: true.`,
  };
}

async function doRun(
  args: PlaybookArgsT,
  overrides: PlaybookOverrides,
): Promise<PlaybookResponse> {
  if (args.confirm !== true) {
    throw new UserError(
      `action: "run" requires confirm: true.`,
      `The user must explicitly confirm the playbook run.`,
    );
  }
  if (args.playbookRunId === undefined) {
    throw new UserError(
      `action: "run" requires \`playbookRunId\`.`,
      `Pass the id returned by action: "dry_run".`,
    );
  }
  const runStore = new PlaybookRunStore({ rootDir: overrides.rootDir });
  const manifest = await runStore.load(args.playbookRunId);

  // Re-load the playbook off disk so we get the latest YAML — but we
  // refuse if step names diverge from the manifest, since that means the
  // user edited the playbook in the gap between dry_run and run.
  const { playbook: pb } = await loadPlaybookByName(
    manifest.playbookName,
    overrides.rootDir,
  );
  if (pb.steps.length !== manifest.steps.length) {
    throw new UserError(
      `Playbook "${manifest.playbookName}" was edited (step count changed) since dry_run.`,
      `Re-run action: "dry_run" to refresh the playbookRunId.`,
    );
  }
  for (let i = 0; i < pb.steps.length; i++) {
    if (pb.steps[i].name !== manifest.steps[i].name) {
      throw new UserError(
        `Playbook "${manifest.playbookName}" step ${i} name diverged ` +
          `(was "${manifest.steps[i].name}", now "${pb.steps[i].name}") since dry_run.`,
        `Re-run action: "dry_run" to refresh the playbookRunId.`,
      );
    }
  }

  // Freshness gate — every step's session must have a dry_run within
  // DRY_RUN_FRESHNESS_MS. Fail fast if any is stale rather than running
  // partway through and aborting mid-flight.
  const sessionStore = new SessionStore({
    rootDir: overrides.seedOverrides?.sessionRootDir,
  });
  for (let i = 0; i < manifest.steps.length; i++) {
    const ms = manifest.steps[i];
    if (ms.status !== "dry_run_complete" && ms.status !== "executed") {
      throw new UserError(
        `Step "${ms.name}" is in status "${ms.status}" — playbook run cannot proceed.`,
        `Re-run action: "dry_run".`,
      );
    }
    const session = await sessionStore.load(ms.sessionId);
    if (!isDryRunFresh(session)) {
      const hours = Math.round(DRY_RUN_FRESHNESS_MS / 3_600_000);
      throw new UserError(
        `Step "${ms.name}" dry-run is older than ${hours}h.`,
        `Re-run action: "dry_run" to refresh.`,
      );
    }
  }

  const errors: Array<{ step: string; message: string }> = [];
  let aborted = false;
  for (let i = 0; i < pb.steps.length; i++) {
    const step = pb.steps[i];
    const ms = manifest.steps[i];
    if (aborted) {
      ms.status = "skipped";
      continue;
    }
    if (ms.status === "executed") {
      // Skip steps already run in a previous (partial) execution — let
      // the user re-issue dry_run if they want to re-do them.
      continue;
    }
    try {
      const res = await seed(
        { action: "run", sessionId: ms.sessionId, confirm: true },
        overrides.seedOverrides,
      );
      const summary = res.summary as Record<string, unknown>;
      ms.status = "executed";
      ms.insertedCounts =
        (summary.insertedCounts as Record<string, number> | undefined) ??
        undefined;
      ms.alreadySeededCounts =
        (summary.alreadySeededCounts as Record<string, number> | undefined) ??
        undefined;
      ms.executeLogPath = summary.logPath as string | undefined;
      await runStore.save(manifest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ms.status = "errored";
      ms.errorMessage = msg;
      errors.push({ step: step.name, message: msg });
      await runStore.save(manifest);
      if (step.continueOnError !== true) {
        aborted = true;
      }
    }
  }

  manifest.runCompletedAt = new Date().toISOString();
  await runStore.save(manifest);

  const totalInserted = manifest.steps.reduce((a, s) => {
    const v = Object.values(s.insertedCounts ?? {}).reduce((x, y) => x + y, 0);
    return a + v;
  }, 0);
  const totalAlready = manifest.steps.reduce((a, s) => {
    const v = Object.values(s.alreadySeededCounts ?? {}).reduce(
      (x, y) => x + y,
      0,
    );
    return a + v;
  }, 0);

  const guidance =
    errors.length === 0
      ? `Playbook complete. Inserted ${totalInserted} record(s) across ${pb.steps.length} step(s).` +
        (totalAlready > 0
          ? ` Skipped ${totalAlready} already-seeded record(s) via project id-map.`
          : "")
      : `Playbook completed with ${errors.length} error(s)` +
        (aborted ? " (aborted before remaining steps)" : "") +
        `. Inserted ${totalInserted} record(s) before failure. ` +
        `See manifest at ${runStore.runDir(args.playbookRunId)}/manifest.json.`;

  return {
    action: "run",
    summary: {
      playbookRunId: args.playbookRunId,
      stepCount: pb.steps.length,
      totalInserted,
      totalAlreadySeeded: totalAlready,
      errorCount: errors.length,
      errors,
      perStep: manifest.steps.map((s) => ({
        name: s.name,
        sessionId: s.sessionId,
        status: s.status,
        insertedCounts: s.insertedCounts ?? {},
        alreadySeededCounts: s.alreadySeededCounts ?? {},
        executeLogPath: s.executeLogPath,
        errorMessage: s.errorMessage,
      })),
      manifestPath: `${runStore.runDir(args.playbookRunId)}/manifest.json`,
    },
    guidance,
  };
}

/**
 * Walk a single step through the seed wizard up to (and including)
 * `dry_run`. Returns the dry_run response so the caller can extract
 * counts + paths.
 */
async function driveStepThroughDryRun(
  step: ResolvedStep,
  seedOverrides: SeedOverrides | undefined,
): Promise<SeedResponse> {
  const start = await seed(
    {
      action: "start",
      sourceOrg: step.sourceOrg,
      targetOrg: step.targetOrg,
      object: step.object,
      whereClause: step.whereClause,
      limit: step.limit,
      sampleSize: step.sampleSize,
      disableValidationRulesOnRun: step.disableValidationRulesOnRun,
      childLookups: step.childLookups,
      isolateIdMap: step.isolateIdMap,
    },
    seedOverrides,
  );

  await seed(
    {
      action: "analyze",
      sessionId: start.sessionId,
      includeManagedPackages: step.includeManagedPackages,
      includeSystemChildren: step.includeSystemChildren,
    },
    seedOverrides,
  );

  await seed(
    {
      action: "select",
      sessionId: start.sessionId,
      includeOptionalParents: step.includeOptionalParents ?? [],
      includeOptionalChildren: step.includeOptionalChildren ?? [],
    },
    seedOverrides,
  );

  return await seed(
    { action: "dry_run", sessionId: start.sessionId },
    seedOverrides,
  );
}

type ResolvedStep = PlaybookStep & {
  sourceOrg: string;
  targetOrg: string;
};

function mergeStepWithDefaults(step: PlaybookStep, pb: Playbook): ResolvedStep {
  const sourceOrg = step.sourceOrg ?? pb.defaults?.sourceOrg;
  const targetOrg = step.targetOrg ?? pb.defaults?.targetOrg;
  if (sourceOrg === undefined) {
    throw new UserError(
      `Playbook step "${step.name}" has no sourceOrg.`,
      `Set defaults.sourceOrg or override on the step.`,
    );
  }
  if (targetOrg === undefined) {
    throw new UserError(
      `Playbook step "${step.name}" has no targetOrg.`,
      `Set defaults.targetOrg or override on the step.`,
    );
  }
  return {
    ...step,
    sourceOrg,
    targetOrg,
    disableValidationRulesOnRun:
      step.disableValidationRulesOnRun ??
      pb.defaults?.disableValidationRulesOnRun,
    isolateIdMap: step.isolateIdMap ?? pb.defaults?.isolateIdMap,
  };
}
