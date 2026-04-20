import type { Field, SObjectDescribe } from "../describe/types.ts";

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
        | "target-describe-failed";
      /** When reason=multiple-candidates, the field names on the source. */
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
 * Decide whether to UPSERT or INSERT this object.
 *
 * Single-candidate rule:
 *   - Source has exactly one candidate
 *   - Target describes the same field name with the same flags
 *   → pick it
 *
 * Anything else → ambiguous. Caller falls back to INSERT and logs.
 *
 * `targetDescribe` may be `null` — callers that can't or didn't fetch
 * the target describe (object missing from target entirely, describe
 * threw) should pass null; we return `ambiguous: "target-describe-failed"`
 * so the caller logs the gap explicitly.
 */
export function resolveUpsertKey(
  sourceDescribe: SObjectDescribe,
  targetDescribe: SObjectDescribe | null,
): UpsertDecision {
  const sourceCandidates = discoverCandidates(sourceDescribe);

  if (sourceCandidates.length === 0) {
    return {
      kind: "ambiguous",
      reason: "no-candidates",
      detail: `no external-id field on ${sourceDescribe.name} passes the upsert-eligible filter (externalId + idLookup + createable + !autoNumber + !calculated)`,
    };
  }

  if (sourceCandidates.length > 1) {
    return {
      kind: "ambiguous",
      reason: "multiple-candidates",
      candidates: sourceCandidates.map((c) => c.name),
      detail: `${sourceDescribe.name} has ${sourceCandidates.length} eligible external-id fields (${sourceCandidates.map((c) => c.name).join(", ")}); this phase requires exactly one to auto-pick`,
    };
  }

  const pick = sourceCandidates[0];

  if (targetDescribe === null) {
    return {
      kind: "ambiguous",
      reason: "target-describe-failed",
      detail: `target describe for ${sourceDescribe.name} unavailable; cannot verify ${pick.name} is upsert-eligible on the target`,
    };
  }

  const targetField = targetDescribe.fields.find((f) => f.name === pick.name);
  if (targetField === undefined || !isUpsertEligible(targetField)) {
    return {
      kind: "ambiguous",
      reason: "target-missing-field",
      detail:
        targetField === undefined
          ? `target ${sourceDescribe.name} is missing ${pick.name}; cannot use it as an upsert key`
          : `target ${sourceDescribe.name}.${pick.name} exists but is not upsert-eligible (externalId/idLookup/createable flags differ)`,
    };
  }

  return { kind: "picked", field: pick.name };
}

/**
 * The per-object filter. Used by both `discoverCandidates` (source
 * side) and `resolveUpsertKey` (target-side verification) so the two
 * sides can never disagree silently.
 */
function isUpsertEligible(field: Field): boolean {
  if (field.externalId !== true) return false;
  if (field.idLookup !== true) return false;
  if (field.createable !== true) return false;
  if (field.autoNumber === true) return false;
  if (field.calculated === true) return false;
  return true;
}
