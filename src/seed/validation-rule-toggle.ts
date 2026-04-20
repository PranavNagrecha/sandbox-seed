import {
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { OrgAuth } from "../auth/sf-auth.ts";
import {
  queryActiveValidationRules,
  setValidationRuleActive,
  type ValidationRuleRecord,
} from "../describe/tooling-client.ts";

/**
 * Validation-rule toggle orchestrator.
 *
 * Lifecycle for a single run with `disableValidationRulesOnRun: true`:
 *
 *   1. `snapshotAndDeactivate` — query target org for every VR on the
 *      seeded objects with `Active = true`. Write the snapshot to
 *      `<session>/touched-validation-rules.json` SYNCHRONOUSLY before
 *      flipping anything. Then deactivate each rule.
 *
 *   2. caller runs the seed inserts.
 *
 *   3. `reactivateFromSnapshot` — in a `finally` block regardless of
 *      seed success. Reads the snapshot file, re-activates each rule,
 *      and (only on full success) moves the file to
 *      `touched-validation-rules.reactivated.json` as an audit trail.
 *
 * Crash-safety: if step 1 writes the file and then crashes before
 * deactivating anything, reactivation is a no-op (file exists but rules
 * are already active). If step 2 crashes between some deactivates and
 * others, reactivation reactivates every rule in the file regardless,
 * which restores the exact prior state. If step 3 crashes, the file
 * stays in place — the pending-recovery scan will detect it on the
 * next MCP tool call and force the user to recover before new work.
 *
 * "THE SAME ONES" guarantee: we only ever write rules where `Active
 * = true` at snapshot time into the file. Rules the user had disabled
 * beforehand are never touched; we have no record of them.
 */

const TOUCHED_FILE = "touched-validation-rules.json";
const REACTIVATED_FILE = "touched-validation-rules.reactivated.json";

export type TouchedValidationRulesFile = {
  sessionId: string;
  targetOrg: string;
  snapshotAt: string;
  rules: ValidationRuleRecord[];
};

export type PendingRecovery = {
  sessionId: string;
  targetOrg: string;
  count: number;
  snapshotAt: string;
};

export type Logger = (line: string) => Promise<void> | void;

/**
 * Query target org for active VRs on the seeded objects, persist the
 * snapshot to disk, then deactivate each one. Returns the number flipped.
 *
 * If `objects` is empty, this is a no-op (no file written, zero touched).
 */
export async function snapshotAndDeactivate(opts: {
  auth: OrgAuth;
  sessionId: string;
  sessionDir: string;
  targetOrg: string;
  objects: string[];
  log?: Logger;
  fetchFn?: typeof fetch;
}): Promise<{ touchedCount: number; rules: ValidationRuleRecord[] }> {
  const log = opts.log ?? noopLogger;

  if (opts.objects.length === 0) {
    await log("VR toggle: no objects to scope, skipping.");
    return { touchedCount: 0, rules: [] };
  }

  await log(
    `VR toggle: querying active validation rules on ${opts.objects.length} ` +
      `object(s) — ${opts.objects.join(", ")}.`,
  );
  const rules = await queryActiveValidationRules({
    auth: opts.auth,
    objects: opts.objects,
    fetchFn: opts.fetchFn,
  });

  if (rules.length === 0) {
    await log(`VR toggle: no active validation rules found. Nothing to touch.`);
    return { touchedCount: 0, rules: [] };
  }

  // CRITICAL: persist snapshot BEFORE flipping anything. If we crash
  // mid-flip, the snapshot tells recovery exactly which rules to
  // reactivate.
  const snapshot: TouchedValidationRulesFile = {
    sessionId: opts.sessionId,
    targetOrg: opts.targetOrg,
    snapshotAt: new Date().toISOString(),
    rules,
  };
  await writeFile(
    join(opts.sessionDir, TOUCHED_FILE),
    JSON.stringify(snapshot, null, 2),
    "utf8",
  );
  await log(
    `VR toggle: snapshotted ${rules.length} active rule(s) to ${TOUCHED_FILE}. ` +
      `Deactivating...`,
  );

  for (const rule of rules) {
    await setValidationRuleActive({
      auth: opts.auth,
      rule,
      active: false,
      fetchFn: opts.fetchFn,
    });
    await log(
      `VR toggle: deactivated ${rule.fullName} (Id=${rule.id}).`,
    );
  }

  return { touchedCount: rules.length, rules };
}

/**
 * Read the snapshot file and PATCH every rule back to `Active = true`.
 *
 * Failure semantics:
 *   - Each rule is attempted independently. Failures are collected, not
 *     thrown, so one bad rule doesn't leave the rest disabled.
 *   - If ALL rules succeed, the snapshot is moved to
 *     `touched-validation-rules.reactivated.json` (audit trail; the
 *     pending-recovery scan ignores this suffix).
 *   - If ANY rule fails, the snapshot stays in place with `rules`
 *     narrowed to the failed subset, and the next tool call will be
 *     forced into recovery again.
 *
 * If the snapshot file doesn't exist, this is a no-op.
 */
export async function reactivateFromSnapshot(opts: {
  auth: OrgAuth;
  sessionDir: string;
  log?: Logger;
  fetchFn?: typeof fetch;
}): Promise<{
  reactivatedCount: number;
  failed: Array<{ fullName: string; error: string }>;
  totalInSnapshot: number;
}> {
  const log = opts.log ?? noopLogger;
  const snapshotPath = join(opts.sessionDir, TOUCHED_FILE);

  let raw: string;
  try {
    raw = await readFile(snapshotPath, "utf8");
  } catch {
    return { reactivatedCount: 0, failed: [], totalInSnapshot: 0 };
  }

  let snapshot: TouchedValidationRulesFile;
  try {
    snapshot = JSON.parse(raw) as TouchedValidationRulesFile;
  } catch {
    await log(
      `VR toggle: snapshot file is corrupted; leaving in place for manual review.`,
    );
    return { reactivatedCount: 0, failed: [], totalInSnapshot: 0 };
  }

  const totalInSnapshot = snapshot.rules.length;
  const failed: Array<{ fullName: string; error: string }> = [];
  const remainingOnFail: ValidationRuleRecord[] = [];
  let reactivatedCount = 0;

  for (const rule of snapshot.rules) {
    try {
      await setValidationRuleActive({
        auth: opts.auth,
        rule,
        active: true,
        fetchFn: opts.fetchFn,
      });
      reactivatedCount += 1;
      await log(`VR toggle: reactivated ${rule.fullName} (Id=${rule.id}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ fullName: rule.fullName, error: msg });
      remainingOnFail.push(rule);
      await log(
        `VR toggle: FAILED to reactivate ${rule.fullName} (Id=${rule.id}): ${msg}`,
      );
    }
  }

  if (failed.length === 0) {
    // All good — rename to audit trail. rename() is atomic on POSIX.
    await rename(snapshotPath, join(opts.sessionDir, REACTIVATED_FILE));
    await log(
      `VR toggle: all ${reactivatedCount} rule(s) reactivated. ` +
        `Snapshot moved to ${REACTIVATED_FILE}.`,
    );
  } else {
    // Narrow the snapshot to the failed subset so the next recovery
    // attempt only retries what's still off.
    const narrowed: TouchedValidationRulesFile = {
      ...snapshot,
      rules: remainingOnFail,
    };
    await writeFile(snapshotPath, JSON.stringify(narrowed, null, 2), "utf8");
    await log(
      `VR toggle: ${failed.length} rule(s) failed to reactivate. ` +
        `Snapshot narrowed — retry with action: "recover_validation_rules".`,
    );
  }

  return { reactivatedCount, failed, totalInSnapshot };
}

/**
 * Scan every session directory under `sessionsRoot` for a
 * `touched-validation-rules.json` file. Used at the top of every MCP
 * tool call to block new work while any recovery is pending.
 *
 * Robust to missing dir / unreadable files — returns what it can, never
 * throws. (A failing guard must not brick the tool.)
 */
export async function findPendingRecoveries(
  sessionsRoot: string,
): Promise<PendingRecovery[]> {
  const out: PendingRecovery[] = [];
  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return out;
  }

  for (const entry of entries) {
    const dir = join(sessionsRoot, entry);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const filePath = join(dir, TOUCHED_FILE);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue; // no touched file = nothing pending in this session
    }

    try {
      const parsed = JSON.parse(raw) as TouchedValidationRulesFile;
      if (Array.isArray(parsed.rules) && parsed.rules.length > 0) {
        out.push({
          sessionId: parsed.sessionId ?? entry,
          targetOrg: parsed.targetOrg ?? "(unknown)",
          count: parsed.rules.length,
          snapshotAt: parsed.snapshotAt ?? "(unknown)",
        });
      }
    } catch {
      // Corrupt file — surface as pending anyway so the user notices.
      out.push({
        sessionId: entry,
        targetOrg: "(corrupt snapshot)",
        count: -1,
        snapshotAt: "(unknown)",
      });
    }
  }

  return out;
}

/** Public accessor to the canonical filename (used by tests/UI text). */
export const TOUCHED_VALIDATION_RULES_FILENAME = TOUCHED_FILE;
export const REACTIVATED_VALIDATION_RULES_FILENAME = REACTIVATED_FILE;

const noopLogger: Logger = async () => {
  /* no-op */
};
