import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { UserError } from "../errors.ts";

/**
 * Session state for the agentic seed flow.
 *
 * MCP tool calls are stateless. The `seed` tool is multi-turn
 * (start → analyze → select → dry_run → run), so we persist the session
 * between calls. The AI threads the `sessionId` through each call.
 *
 * Files live under `~/.sandbox-seed/sessions/<id>/`:
 *   - session.json     — the state object defined below
 *   - dry-run.md       — human-readable dry-run report (has record IDs)
 *   - id-map.json      — source→target ID map (populated during `run`)
 *   - execute.log      — append-only insert log (populated during `run`)
 *
 * Sensitive artifacts (IDs, insert logs) stay on disk. The tool responses
 * reference them by path — the LLM sees the path, not the contents.
 */
export type SessionStep =
  | "started"
  | "analyzed"
  | "selected"
  | "dry_run_complete"
  | "executed"
  | "errored";

export type SessionCycle = {
  objects: string[];
  breakEdge: { source: string; target: string; fieldName: string } | null;
};

/**
 * Per-object upsert-key decision captured at dry-run time and
 * consumed by `run`. Kept on the session (not recomputed during run)
 * so the record the user saw in the dry-run report is exactly what
 * the run uses — no surprise switches between INSERT and UPSERT.
 */
export type UpsertDecisionSummary =
  | { kind: "picked"; field: string }
  | {
      kind: "ambiguous";
      reason:
        | "no-candidates"
        | "multiple-candidates"
        | "target-missing-field"
        | "target-describe-failed";
      candidates?: string[];
      detail: string;
    };

export type DryRunSummary = {
  reportPath: string;
  perObjectCounts: Record<string, number>;
  totalRecords: number;
  completedAt: string;
  targetSchemaIssues: string[];
  /**
   * Per-object INSERT-vs-UPSERT decision. Absent for objects where the
   * dry-run couldn't describe source or target (those fall back to
   * INSERT at run time). Populated for every object in `finalObjectList`
   * when describes succeed on both sides.
   */
  upsertDecisions?: Record<string, UpsertDecisionSummary>;
};

export type ExecuteSummary = {
  logPath: string;
  idMapPath: string;
  insertedCounts: Record<string, number>;
  completedAt: string;
  errorCount: number;
  /**
   * If `disableValidationRulesOnRun` was set, this is the number of
   * target-org validation rules the run snapshotted + deactivated +
   * reactivated. 0 or undefined otherwise.
   */
  validationRulesTouched?: number;
  /** If reactivation had partial failures, the remaining fullNames. */
  validationRulesReactivationFailed?: string[];
};

export type Session = {
  id: string;
  createdAt: string;
  step: SessionStep;
  sourceOrg: string;
  targetOrg: string;
  rootObject: string;
  whereClause: string;
  limit: number | null;
  /** Count returned by the SELECT COUNT() scope probe on `start`. */
  scopeCount?: number;
  /** Populated by `analyze`. */
  mustIncludeParents?: string[];
  optionalParents?: string[];
  optionalChildren?: string[];
  cycles?: SessionCycle[];
  /** Full load order from `analyze` (pre-select). */
  analyzedLoadOrder?: string[];
  /** Populated by `select`. */
  selectedOptionalParents?: string[];
  selectedOptionalChildren?: string[];
  finalObjectList?: string[];
  /** Restricted load order after `select`. */
  finalLoadOrder?: string[];
  dryRun?: DryRunSummary;
  executed?: ExecuteSummary;
  /**
   * If true, `run` will snapshot + deactivate + reactivate every active
   * validation rule on the target org scoped to `finalObjectList` —
   * exactly the rules we touched, no more. Default false.
   *
   * Safety net: if the process dies between deactivate and reactivate,
   * the snapshot file `touched-validation-rules.json` remains in the
   * session directory. The next `seed` call scans for that
   * file across all sessions and refuses to start new work until the
   * user calls `action: "recover_validation_rules"` to reactivate.
   */
  disableValidationRulesOnRun?: boolean;
  /** If the user retries a step after an error, the last error is stored here. */
  lastError?: string;
};

export type SessionStoreOptions = {
  /** Override for tests. Defaults to `~/.sandbox-seed`. */
  rootDir?: string;
};

/** Max age before a session is garbage-collected on next load. */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Dry-run freshness window — `run` is gated on this. */
export const DRY_RUN_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SessionStore {
  private readonly rootDir: string;

  constructor(opts: SessionStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultRootDir();
  }

  /** Absolute path to the session directory (may not exist yet). */
  sessionDir(id: string): string {
    return join(this.rootDir, "sessions", sanitize(id));
  }

  /** Absolute path to the parent dir that holds every session's folder. */
  sessionsRoot(): string {
    return join(this.rootDir, "sessions");
  }

  private sessionJsonPath(id: string): string {
    return join(this.sessionDir(id), "session.json");
  }

  async create(
    init: Omit<Session, "id" | "createdAt" | "step">,
  ): Promise<Session> {
    const id = newSessionId();
    const session: Session = {
      ...init,
      id,
      createdAt: new Date().toISOString(),
      step: "started",
    };
    await mkdir(this.sessionDir(id), { recursive: true });
    await this.save(session);
    return session;
  }

  async load(id: string): Promise<Session> {
    let raw: string;
    try {
      raw = await readFile(this.sessionJsonPath(id), "utf8");
    } catch {
      throw new UserError(
        `Session "${id}" not found.`,
        "Call seed with action: \"start\" to create a new session.",
      );
    }
    try {
      return JSON.parse(raw) as Session;
    } catch {
      throw new UserError(
        `Session "${id}" is corrupted (could not parse session.json).`,
        "Start a new session.",
      );
    }
  }

  async save(session: Session): Promise<void> {
    await mkdir(this.sessionDir(session.id), { recursive: true });
    await writeFile(
      this.sessionJsonPath(session.id),
      JSON.stringify(session, null, 2),
      "utf8",
    );
  }

  /** Sweep sessions older than SESSION_MAX_AGE_MS. Idempotent, swallows errors. */
  async gc(): Promise<{ removed: string[] }> {
    const sessionsRoot = join(this.rootDir, "sessions");
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(sessionsRoot);
    } catch {
      return { removed };
    }
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    for (const entry of entries) {
      const dir = join(sessionsRoot, entry);
      const jsonPath = join(dir, "session.json");
      try {
        const raw = await readFile(jsonPath, "utf8");
        const s = JSON.parse(raw) as Session;
        const created = Date.parse(s.createdAt);
        if (!Number.isFinite(created) || created < cutoff) {
          await rm(dir, { recursive: true, force: true });
          removed.push(entry);
        }
      } catch {
        // If we can't read/parse, leave it — don't delete on ambiguity.
      }
    }
    return { removed };
  }
}

function defaultRootDir(): string {
  return join(homedir(), ".sandbox-seed");
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function newSessionId(): string {
  // Date prefix makes ad-hoc `ls` chronological; random suffix avoids
  // collisions if two sessions are created in the same millisecond.
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const suffix = randomBytes(5).toString("hex"); // 10 hex chars
  return `${date}-${suffix}`;
}

/**
 * Is this dry-run fresh enough to allow `run`?
 * Returns `true` if the session has a dry_run completed within the window.
 */
export function isDryRunFresh(session: Session, now = Date.now()): boolean {
  if (session.dryRun === undefined) return false;
  const completed = Date.parse(session.dryRun.completedAt);
  if (!Number.isFinite(completed)) return false;
  return now - completed <= DRY_RUN_FRESHNESS_MS;
}
