import { describe, expect, it } from "vitest";
import type { LoadPlan } from "../../src/graph/order.ts";
import { buildCanonicalPlan, hashCanonicalPlan } from "../../src/seed/plan-hash.ts";

/**
 * Locks in the issue #1 follow-up: sampledRootIds get fingerprinted into
 * the canonical plan so the dry_run / run drift check fires when the
 * sample changes between the two phases. Without this guard, a user who
 * silently re-rolls the sample (or a stale `sampledRootIds` value drifting
 * from the dry-run sample) would get a different scope at run time than
 * the one they reviewed.
 *
 * Keeps the plan.json small: a 32-byte SHA-256 hex string regardless of
 * sample size.
 */

const baseLoadPlan: LoadPlan = {
  steps: [{ kind: "single", object: "Account" }],
  excluded: [],
};

function basePlan(overrides: { sampledRootIds?: string[] } = {}) {
  return buildCanonicalPlan({
    rootObject: "Account",
    whereClause: "Industry = 'Education'",
    sourceAlias: "src",
    targetAlias: "tgt",
    finalObjectList: ["Account"],
    loadPlan: baseLoadPlan,
    ...overrides,
  });
}

describe("buildCanonicalPlan + sampledRootIds fingerprint", () => {
  it("omits the fingerprint field when no sample was applied", () => {
    const plan = basePlan();
    expect(plan.sampledRootIdsFingerprint).toBeUndefined();
  });

  it("omits the fingerprint field when sampledRootIds is empty", () => {
    const plan = basePlan({ sampledRootIds: [] });
    expect(plan.sampledRootIdsFingerprint).toBeUndefined();
  });

  it("emits a 64-char SHA-256 hex when sampledRootIds is present", () => {
    const plan = basePlan({ sampledRootIds: ["a", "b", "c"] });
    expect(plan.sampledRootIdsFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same fingerprint regardless of input order", () => {
    const a = basePlan({ sampledRootIds: ["c", "a", "b"] });
    const b = basePlan({ sampledRootIds: ["a", "b", "c"] });
    expect(a.sampledRootIdsFingerprint).toBe(b.sampledRootIdsFingerprint);
  });

  it("changes the plan hash when the sample changes", () => {
    const a = hashCanonicalPlan(basePlan({ sampledRootIds: ["a", "b"] }));
    const b = hashCanonicalPlan(basePlan({ sampledRootIds: ["a", "c"] }));
    expect(a).not.toBe(b);
  });

  it("changes the plan hash between sampled and unsampled with the same WHERE clause", () => {
    // Without this guard, a user could re-roll a session and end up at
    // run time with the un-sampled scope while the dry-run was sampled.
    const unsampled = hashCanonicalPlan(basePlan());
    const sampled = hashCanonicalPlan(basePlan({ sampledRootIds: ["a1", "b2"] }));
    expect(unsampled).not.toBe(sampled);
  });
});
