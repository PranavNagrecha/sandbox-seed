import type { OrgAuth } from "../auth/sf-auth.ts";
import type { Field, SObjectDescribe } from "../describe/types.ts";
import { queryRecords } from "./extract.ts";

/**
 * Upsert-key detection for Salesforce composite upsert.
 *
 * The problem we solve
 * --------------------
 * Plain composite INSERT against a non-empty target sandbox hits
 * DUPLICATE_VALUE errors on any row whose external-id field collides
 * with an existing target row. SFDMU's answer is to make the user
 * pre-configure per-object upsert keys — which users forget, get
 * wrong, or skip entirely.
 *
 * This module picks an upsert key automatically in the unambiguous
 * case. Scope-locked to the simplest rule that is **strictly not
 * worse than today's INSERT-only path**:
 *
 *   - Exactly ONE external-id field on the source object that is
 *     `createable && idLookup && externalId && !autoNumber &&
 *     !calculated`, AND
 *   - The target org describes the SAME field with the SAME flags.
 *
 *   → Use it as the upsert external-id. The composite upsert endpoint
 *     then matches source↔target rows by that field's value and
 *     UPDATEs rather than failing on duplicate.
 *
 * Everything else (0 candidates, 2+ candidates, target missing the
 * field) falls back to INSERT with a logged warning. This is the
 * scope boundary agreed for this phase — no thresholds, no
 * persistence, no standard-object defaults, no composite keys, no
 * user-override UI.
 *
 * Why `idLookup`
 * --------------
 * `externalId === true` is necessary but not sufficient — it just
 * flags the attribute in setup. `idLookup === true` is the flag
 * Salesforce sets on fields it will actually match against in an
 * upsert URL. For custom external-id fields the two always move
 * together; requiring both is belt-and-suspenders and filters out
 * rare edge cases (deprecated/fls-blocked fields).
 *
 * Why `!autoNumber`
 * -----------------
 * Auto-number fields (CaseNumber, OrderNumber) can be marked
 * External ID and idLookup, but their values are generated per-org —
 * "matching" a source CaseNumber to a target CaseNumber would be
 * luck, not identity. Always exclude.
 *
 * Why `createable`
 * ----------------
 * If the field isn't createable on the source, we can't send its
 * value from the source read, so it's useless as an upsert key even
 * if it exists. Mirrors `pickCreateableFields` in execute.ts.
 */

/** A field that passes every "could be an upsert key" test on one side (source or target). */
export type UpsertCandidate = {
  name: string;
  /** For logs / reports. */
  label: string | undefined;
};

/** The resolver's verdict for a single object. */
export type UpsertDecision =
  | { kind: "picked"; field: string }
  | {
      kind: "ambiguous";
      reason:
        | "no-candidates"
        | "multiple-candidates"
        | "target-missing-field"
        | "target-describe-failed"
        | "all-candidates-empty"
        | "override-invalid";
      /** Populated for multiple-candidates / all-candidates-empty / override-invalid. */
      candidates?: string[];
      /** Short human string for logs / the dry-run report. */
      detail: string;
    };

/**
 * Return every source field that *could* be an upsert key on its own.
 * Order-stable by describe order so callers that care about "first
 * candidate" get deterministic output.
 */
export function discoverCandidates(describe: SObjectDescribe): UpsertCandidate[] {
  const out: UpsertCandidate[] = [];
  for (const f of describe.fields) {
    if (!isUpsertEligible(f)) continue;
    out.push({ name: f.name, label: f.label });
  }
  return out;
}

/**
 * Optional inputs that disambiguate the multiple-candidates case.
 */
export type ResolveUpsertKeyOptions = {
  /**
   * Per-candidate-field source population count. Required to auto-pick
   * when more than one candidate exists. Absent fields are treated as 0.
   * Caller computes via `SELECT COUNT(field) FROM Object [WHERE scope]`
   * and threads the map through.
   */
  populationByField?: Map<string, number>;
  /**
   * Total count of source records considered, used to flag the
   * "all candidates have 0 populated rows" case explicitly. Optional;
   * absent → we still resolve by relative population (highest wins).
   */
  totalRecords?: number;
  /**
   * User override — when provided AND the field is in the candidate list,
   * we use it verbatim and skip auto-pick. Invalid overrides (field not
   * a candidate) are reported back via the `ambiguous` decision so the
   * caller can surface the mistake instead of silently falling back.
   */
  override?: string;
};

/**
 * Decide whether to UPSERT or INSERT this object.
 *
 * Resolution order:
 *   1. User override (when provided AND valid).
 *   2. Single candidate.
 *   3. Multiple candidates: pick by highest source population, with
 *      alphabetical name as the deterministic tiebreaker. If all
 *      candidates report zero populated source rows we return
 *      `ambiguous: "all-candidates-empty"` so the caller logs and INSERTs
 *      — DUPLICATE_VALUE recovery picks up from there at run time.
 *   4. Zero candidates / target missing field / target describe failed
 *      → existing ambiguous reasons.
 *
 * `targetDescribe` may be `null` — callers that can't or didn't fetch
 * the target describe (object missing from target entirely, describe
 * threw) should pass null; we return `ambiguous: "target-describe-failed"`
 * so the caller logs the gap explicitly.
 */
export function resolveUpsertKey(
  sourceDescribe: SObjectDescribe,
  targetDescribe: SObjectDescribe | null,
  options: ResolveUpsertKeyOptions = {},
): UpsertDecision {
  const sourceCandidates = discoverCandidates(sourceDescribe);

  if (sourceCandidates.length === 0) {
    return {
      kind: "ambiguous",
      reason: "no-candidates",
      detail: `no external-id field on ${sourceDescribe.name} passes the upsert-eligible filter (externalId + idLookup + createable + !autoNumber + !calculated)`,
    };
  }

  // User override path. The override must name a candidate we already
  // discovered on the source — anything else is rejected, otherwise the
  // user could send the run down a path that fails opaquely at composite
  // upsert time.
  if (options.override !== undefined) {
    const matched = sourceCandidates.find((c) => c.name === options.override);
    if (matched === undefined) {
      return {
        kind: "ambiguous",
        reason: "override-invalid",
        candidates: sourceCandidates.map((c) => c.name),
        detail: `upsertKeyOverrides[${sourceDescribe.name}] = "${options.override}" is not an upsert-eligible field on the source (candidates: ${sourceCandidates.map((c) => c.name).join(", ") || "none"})`,
      };
    }
    return verifyTargetAndReturn(sourceDescribe, targetDescribe, matched.name);
  }

  let pick: UpsertCandidate;
  if (sourceCandidates.length === 1) {
    pick = sourceCandidates[0];
  } else {
    const populationByField = options.populationByField;
    if (populationByField === undefined) {
      // Caller didn't compute population data — keep historic behavior so
      // we don't pick blindly. Same shape as before so the dry-run log
      // and report stay legible.
      return {
        kind: "ambiguous",
        reason: "multiple-candidates",
        candidates: sourceCandidates.map((c) => c.name),
        detail: `${sourceDescribe.name} has ${sourceCandidates.length} eligible external-id fields (${sourceCandidates.map((c) => c.name).join(", ")}); auto-pick needs population data to disambiguate`,
      };
    }
    const ranked = pickByPopulation(sourceCandidates, populationByField);
    if (ranked === null) {
      return {
        kind: "ambiguous",
        reason: "all-candidates-empty",
        candidates: sourceCandidates.map((c) => c.name),
        detail: `${sourceDescribe.name} has ${sourceCandidates.length} eligible external-id fields but every candidate is unpopulated on the in-scope source rows; falling back to INSERT (DUPLICATE_VALUE recovery covers already-seeded rows)`,
      };
    }
    pick = ranked;
  }

  return verifyTargetAndReturn(sourceDescribe, targetDescribe, pick.name);
}

/**
 * Pick the most-populated candidate, breaking ties alphabetically by
 * field name. Returns `null` when every candidate has zero populated
 * rows on the source (no signal to disambiguate from).
 */
export function pickByPopulation(
  candidates: UpsertCandidate[],
  populationByField: Map<string, number>,
): UpsertCandidate | null {
  let best: UpsertCandidate | null = null;
  let bestCount = -1;
  let total = 0;
  for (const c of candidates) {
    const n = populationByField.get(c.name) ?? 0;
    total += n;
    if (n > bestCount || (n === bestCount && best !== null && c.name < best.name)) {
      best = c;
      bestCount = n;
    }
  }
  if (total === 0) return null;
  return best;
}

function verifyTargetAndReturn(
  sourceDescribe: SObjectDescribe,
  targetDescribe: SObjectDescribe | null,
  fieldName: string,
): UpsertDecision {
  if (targetDescribe === null) {
    return {
      kind: "ambiguous",
      reason: "target-describe-failed",
      detail: `target describe for ${sourceDescribe.name} unavailable; cannot verify ${fieldName} is upsert-eligible on the target`,
    };
  }

  const targetField = targetDescribe.fields.find((f) => f.name === fieldName);
  if (targetField === undefined || !isUpsertEligible(targetField)) {
    return {
      kind: "ambiguous",
      reason: "target-missing-field",
      detail:
        targetField === undefined
          ? `target ${sourceDescribe.name} is missing ${fieldName}; cannot use it as an upsert key`
          : `target ${sourceDescribe.name}.${fieldName} exists but is not upsert-eligible (externalId/idLookup/createable flags differ)`,
    };
  }

  return { kind: "picked", field: fieldName };
}

/**
 * The per-object filter. Used by both `discoverCandidates` (source
 * side) and `resolveUpsertKey` (target-side verification) so the two
 * sides can never disagree silently.
 *
 * `unique=true` is enforced explicitly even though most External ID
 * fields are unique in practice: Salesforce allows non-unique External
 * IDs (e.g. lookup-only fields used for cross-system matching), and
 * composite UPSERT against a non-unique key fails the whole batch with
 * `MULTIPLE_RECORDS_FOUND` when more than one target row carries the
 * same value. Filtering here keeps that failure mode out of the run
 * loop entirely — the row falls through to INSERT, and the
 * DUPLICATE_VALUE recovery path covers the already-seeded case.
 */
function isUpsertEligible(field: Field): boolean {
  if (field.externalId !== true) return false;
  if (field.idLookup !== true) return false;
  if (field.unique !== true) return false;
  if (field.createable !== true) return false;
  if (field.autoNumber === true) return false;
  if (field.calculated === true) return false;
  return true;
}

/**
 * One-shot population probe for a candidate set.
 *
 * Emits `SELECT COUNT(f0) c0, COUNT(f1) c1, ... FROM <object> [WHERE ...]`,
 * which Salesforce evaluates as a single aggregate read regardless of the
 * candidate count. COUNT(field) excludes nulls, so the per-field value is
 * the populated row count — the signal `pickByPopulation` needs to break
 * ties between multiple eligible external-id fields.
 *
 * AI-boundary note: result is a per-FIELD count map, never row values.
 * Counts are aggregate metadata — same disclosure shape as `SELECT COUNT()`.
 */
export async function queryFieldPopulation(opts: {
  auth: OrgAuth;
  object: string;
  fields: string[];
  /** Apply the user's WHERE clause when probing root scope; omit elsewhere. */
  whereClause?: string;
  fetchFn?: typeof fetch;
}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (opts.fields.length === 0) return out;

  const projection = opts.fields.map((f, i) => `COUNT(${f}) c${i}`).join(", ");
  const where =
    opts.whereClause !== undefined && opts.whereClause.trim() !== ""
      ? ` WHERE ${opts.whereClause}`
      : "";
  const soql = `SELECT ${projection} FROM ${opts.object}${where}`;

  const records = await queryRecords({
    auth: opts.auth,
    soql,
    fetchFn: opts.fetchFn,
  });
  const row = records[0];
  if (row === undefined) return out;
  for (let i = 0; i < opts.fields.length; i++) {
    const value = row[`c${i}`];
    if (typeof value === "number") {
      out.set(opts.fields[i], value);
    }
  }
  return out;
}
