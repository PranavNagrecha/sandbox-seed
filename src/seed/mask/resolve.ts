import type { DependencyGraph } from "../../graph/build.ts";
import type { MaskSelection, MaskStrategy } from "./types.ts";

/**
 * A user-supplied masking instruction for one field. Either a bare field name
 * (masked with strategy "auto" — `pickStrategy` chooses the preset) or an
 * explicit strategy. `"copy"` opts a field OUT — it removes the field from the
 * selection, which is how a user un-masks something the detector flagged by
 * default.
 *
 * Field NAMES only, never values — so this stays inside the AI boundary.
 */
export type MaskFieldSpec = string | { field: string; strategy: MaskStrategy | "copy" };

/** object API name → list of field instructions. */
export type UserMaskFields = Record<string, MaskFieldSpec[]>;

/**
 * Build the masking selection (object → field → strategy) for a run.
 *
 * SIMPLE v1 (phases/masking-spec.md T8): the default selection is exactly the
 * fields the detector already flagged on each node (`sensitiveFields`), each
 * with strategy `"auto"`. The user then layers explicit instructions on top —
 * add a field, pin its strategy, or `"copy"` to opt out.
 *
 * Deliberately NOT in v1 (the "complex later"): augmenting the default with
 * type-based detection (`type ∈ email|phone`) or a broader name pattern. The
 * G1 recall analysis (masking-spec.md §4.4) showed the detector under-flags —
 * it misses names, `MailingStreet`, demographics, and whole custom objects —
 * but the mandatory dry-run review surfaces the selection so the user adds
 * those explicitly. Auto-expansion can land later without changing this
 * signature.
 */
export function resolveMaskSelection(
  graph: DependencyGraph,
  userMaskFields?: UserMaskFields,
  scopeObjects?: Iterable<string>,
): MaskSelection {
  // Restrict to the objects actually being seeded (finalObjectList). Without
  // it the selection spans the entire ANALYZED graph — on a real
  // managed-package org that's hundreds of related objects the run never
  // touches, which made the dry-run masking plan wildly over-report (192
  // fields across dozens of objects for a single-object seed). Caught by the
  // T14 real-org dry-run.
  const inScope = scopeObjects !== undefined ? new Set(scopeObjects) : undefined;
  const selection: MaskSelection = new Map();
  const ensure = (object: string): Map<string, MaskStrategy> => {
    const existing = selection.get(object);
    if (existing !== undefined) return existing;
    const created = new Map<string, MaskStrategy>();
    selection.set(object, created);
    return created;
  };

  // 1. Defaults: every detector-flagged sensitive field → "auto" (in scope).
  for (const [object, attrs] of graph.nodes) {
    if (inScope !== undefined && !inScope.has(object)) continue;
    for (const sf of attrs.sensitiveFields) {
      ensure(object).set(sf.name, "auto");
    }
  }

  // 2. User overrides: add a field, pin a strategy, or opt out with "copy".
  if (userMaskFields !== undefined) {
    for (const [object, specs] of Object.entries(userMaskFields)) {
      if (inScope !== undefined && !inScope.has(object)) continue;
      const fields = ensure(object);
      for (const spec of specs) {
        if (typeof spec === "string") {
          fields.set(spec, "auto");
        } else if (spec.strategy === "copy") {
          fields.delete(spec.field);
        } else {
          fields.set(spec.field, spec.strategy);
        }
      }
    }
  }

  // Drop objects left with no fields (e.g. every default opted out).
  for (const object of [...selection.keys()]) {
    if (selection.get(object)?.size === 0) selection.delete(object);
  }
  return selection;
}

/**
 * Flatten a selection to per-object field NAMES (sorted). For the dry-run
 * report and response — names only, never values. Empty objects are omitted.
 */
export function maskedFieldNames(selection: MaskSelection): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [object, fields] of selection) {
    if (fields.size > 0) out[object] = [...fields.keys()].sort();
  }
  return out;
}
