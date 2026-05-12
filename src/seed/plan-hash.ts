import { createHash } from "node:crypto";
import type { LoadPlan } from "../graph/order.ts";
import type { UpsertDecisionSummary } from "./session.ts";

/**
 * Plan hash — "the plan you reviewed is the plan that runs."
 *
 * `dry_run` writes a canonical `plan.json` and persists its SHA-256 onto
 * the session. `run` recomputes the hash from the current graph / upsert
 * decisions and refuses if it diverges — the source graph changed, the
 * user edited the session, or the describe cache was rebuilt with
 * different results since dry-run.
 *
 * The hash covers the inputs that materially change what gets inserted:
 *   - root object + WHERE clause
 *   - source / target aliases
 *   - the full restricted load order (step kind, objects, break edges)
 *   - per-object upsert decision (INSERT vs UPSERT + picked key)
 *   - sampled-root-IDs fingerprint when `sampleSize` was applied (so the
 *     run can't drift onto a different sample after the user signed off
 *     on the dry-run)
 *
 * Intentionally NOT in the hash:
 *   - createable field list per object — schema drift is a per-field
 *     observation already surfaced separately in the dry-run report.
 *   - absolute record counts — those can drift legitimately between the
 *     dry-run probe and the run query (new rows land in the source org
 *     between the two). Blocking on count parity would force pointless
 *     re-dry-runs.
 */

export type CanonicalPlan = {
  version: 1;
  rootObject: string;
  whereClause: string;
  sourceAlias: string;
  targetAlias: string;
  objects: CanonicalPlanObject[];
  /**
   * SHA-256 hex of the sorted sampled root-ID list when `sampleSize` was
   * applied at start. Absent when the seed wasn't sampled (full WHERE
   * scope). The full ID list isn't in the canonical plan to keep
   * `plan.json` small at high sample counts; the fingerprint is enough
   * for the dry_run/run drift check.
   */
  sampledRootIdsFingerprint?: string;
};

export type CanonicalPlanObject = {
  name: string;
  step: "single" | "cycle";
  breakEdge: { source: string; target: string; fieldName: string } | null;
  upsertDecision:
    | { kind: "picked"; field: string }
    | { kind: "ambiguous"; reason: string }
    | { kind: "none" };
};

export type BuildCanonicalPlanArgs = {
  rootObject: string;
  whereClause: string;
  sourceAlias: string;
  targetAlias: string;
  finalObjectList: string[];
  loadPlan: LoadPlan;
  upsertDecisions?: Record<string, UpsertDecisionSummary>;
  /**
   * Pre-materialized sampled root IDs from `start`. When provided, the
   * canonical plan includes a fingerprint so dry_run / run cannot drift
   * onto a different sample silently. Pass the same array that was
   * stored on the session — order is normalized internally.
   */
  sampledRootIds?: string[];
};

/**
 * Build the canonical plan object. The returned structure's fields are
 * all primitive / sorted-array, so feeding it through `canonicalStringify`
 * always yields byte-identical output for equivalent inputs.
 */
export function buildCanonicalPlan(args: BuildCanonicalPlanArgs): CanonicalPlan {
  // Map each object to its step kind + breakEdge by walking the load plan.
  // Objects not present in the load plan (e.g. excluded standard-roots)
  // fall back to step="single", breakEdge=null so their presence/absence
  // in finalObjectList still contributes to the hash.
  const stepByObject = new Map<
    string,
    { kind: "single" | "cycle"; breakEdge: CanonicalPlanObject["breakEdge"] }
  >();
  for (const step of args.loadPlan.steps) {
    if (step.kind === "single") {
      stepByObject.set(step.object, { kind: "single", breakEdge: null });
    } else {
      for (const obj of step.objects) {
        stepByObject.set(obj, { kind: "cycle", breakEdge: step.breakEdge });
      }
    }
  }

  const objects: CanonicalPlanObject[] = [];
  const sortedNames = [...args.finalObjectList].sort();
  for (const name of sortedNames) {
    const step = stepByObject.get(name) ?? { kind: "single" as const, breakEdge: null };
    const decision = args.upsertDecisions?.[name];
    const upsertDecision: CanonicalPlanObject["upsertDecision"] =
      decision === undefined
        ? { kind: "none" }
        : decision.kind === "picked"
          ? { kind: "picked", field: decision.field }
          : { kind: "ambiguous", reason: decision.reason };
    objects.push({ name, step: step.kind, breakEdge: step.breakEdge, upsertDecision });
  }

  const sampledRootIdsFingerprint =
    args.sampledRootIds !== undefined && args.sampledRootIds.length > 0
      ? fingerprintIds(args.sampledRootIds)
      : undefined;

  return {
    version: 1,
    rootObject: args.rootObject,
    whereClause: args.whereClause,
    sourceAlias: args.sourceAlias,
    targetAlias: args.targetAlias,
    objects,
    ...(sampledRootIdsFingerprint !== undefined ? { sampledRootIdsFingerprint } : {}),
  };
}

/**
 * Stable fingerprint over an unordered ID set. Sort first so the hash is
 * invariant to the order Salesforce happened to return rows in.
 */
function fingerprintIds(ids: string[]): string {
  const sorted = [...ids].sort();
  return createHash("sha256").update(sorted.join(",")).digest("hex");
}

/**
 * Stable JSON serialization — recursively sorts object keys so equivalent
 * shapes serialize byte-identical regardless of insertion order.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k]));
  return "{" + parts.join(",") + "}";
}

/** SHA-256 hex of the canonical representation. */
export function hashCanonicalPlan(plan: CanonicalPlan): string {
  return createHash("sha256").update(canonicalStringify(plan)).digest("hex");
}
