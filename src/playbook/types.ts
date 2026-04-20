import { z } from "zod";

/**
 * Playbook types + zod schemas.
 *
 * A playbook chains N ordered seed steps into one run. File layout at
 * `~/.sandbox-seed/playbooks/<name>.yml` (user-scope only — see
 * `feedback_playbooks_user_scope_only.md`).
 *
 * Each step's body mirrors the existing `seed` tool's `action: "start"`
 * args (minus `action`/`sessionId`). The runner composes the existing
 * `seed()` function in a loop; it does NOT re-implement seeding.
 */

/** Per-step body — same fields the `seed` tool accepts at `start`. */
export const PlaybookStepSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Step identifier (unique within the playbook). Used in reports + logs."),
  object: z
    .string()
    .min(1)
    .describe("Root sObject API name to seed."),
  whereClause: z
    .string()
    .min(1)
    .describe("SOQL WHERE clause scoping the root scope."),
  sourceOrg: z.string().min(1).optional(),
  targetOrg: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
  sampleSize: z.number().int().positive().optional(),
  includeOptionalParents: z.array(z.string().min(1)).optional(),
  includeOptionalChildren: z.array(z.string().min(1)).optional(),
  includeManagedPackages: z.boolean().optional(),
  includeSystemChildren: z.boolean().optional(),
  disableValidationRulesOnRun: z.boolean().optional(),
  childLookups: z
    .record(z.string().min(1), z.array(z.string().min(1)).min(1))
    .optional(),
  isolateIdMap: z.boolean().optional(),
  /**
   * If true, a step failure is logged and the playbook continues with the
   * next step instead of aborting. Defaults to false — abort on first
   * error so the user can fix and re-run from a known state.
   */
  continueOnError: z.boolean().optional(),
});

export const PlaybookDefaultsSchema = z.object({
  sourceOrg: z.string().min(1).optional(),
  targetOrg: z.string().min(1).optional(),
  disableValidationRulesOnRun: z.boolean().optional(),
  isolateIdMap: z.boolean().optional(),
});

export const PlaybookSchema = z.object({
  apiVersion: z.literal("sandbox-seed/v1"),
  kind: z.literal("Playbook"),
  name: z.string().min(1),
  description: z.string().optional(),
  defaults: PlaybookDefaultsSchema.optional(),
  steps: z.array(PlaybookStepSchema).min(1),
});

export type PlaybookStep = z.infer<typeof PlaybookStepSchema>;
export type PlaybookDefaults = z.infer<typeof PlaybookDefaultsSchema>;
export type Playbook = z.infer<typeof PlaybookSchema>;

/** Status of a single step inside a playbook run. */
export type PlaybookStepStatus =
  | "pending"
  | "dry_run_complete"
  | "executed"
  | "errored"
  | "skipped";

/** Per-step entry in the run manifest. */
export type PlaybookRunStep = {
  name: string;
  sessionId: string;
  status: PlaybookStepStatus;
  /** Populated after dry_run — the returned report path. */
  dryRunReportPath?: string;
  /** Populated after dry_run — totalRecords for this step. */
  dryRunTotalRecords?: number;
  /** Populated after run — {object: count} and log path. */
  insertedCounts?: Record<string, number>;
  alreadySeededCounts?: Record<string, number>;
  executeLogPath?: string;
  errorMessage?: string;
};

/**
 * The manifest written to
 * `~/.sandbox-seed/playbook-runs/<run-id>/manifest.json`.
 * Persistent across the dry_run → run gap (up to DRY_RUN_FRESHNESS_MS).
 */
export type PlaybookRunManifest = {
  playbookRunId: string;
  playbookName: string;
  playbookPath: string;
  createdAt: string;
  /** ISO timestamp of the playbook-level dry_run aggregate completion. */
  dryRunAggregatedAt?: string;
  /** ISO timestamp of the run-all completion. */
  runCompletedAt?: string;
  /** Per-step state. Index matches the playbook's `steps` array. */
  steps: PlaybookRunStep[];
};
