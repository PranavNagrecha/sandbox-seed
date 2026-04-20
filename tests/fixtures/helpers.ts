import type { SObjectDescribe } from "../../src/describe/types.ts";
import {
  buildGraph,
  collectChildObjects,
  collectReferencedObjects,
  type DependencyGraph,
} from "../../src/graph/build.ts";
import { DEFAULT_FIELD_FILTERS, type FieldFilterOptions } from "../../src/graph/filters.ts";
import { isStandardRootObject } from "../../src/graph/standard-objects.ts";

export type BuildFromRootOptions = {
  /** Defaults to true — walk 1-level children from root via childRelationships. */
  includeChildren?: boolean;
  recordType?: string;
  rowCounts?: Map<string, number>;
  fieldFilters?: FieldFilterOptions;
};

/**
 * Test-only helper: given a root object and a map of describes, derive
 * the parent/child/distance bookkeeping that `buildGraph` now requires.
 * Mirrors the runtime walk in `inspect/run.ts#walkFromRoot` without needing
 * a fetch client.
 */
export function buildFromRoot(
  rootObject: string,
  describes: Map<string, SObjectDescribe>,
  opts: BuildFromRootOptions = {},
): DependencyGraph {
  const filters = opts.fieldFilters ?? DEFAULT_FIELD_FILTERS;
  const parents = new Set<string>();
  const children = new Set<string>();
  const distances = new Map<string, number>([[rootObject, 0]]);

  const rootDesc = describes.get(rootObject);
  const seen = new Set<string>([rootObject]);
  const queue: Array<{ name: string; depth: number }> = [];

  if (rootDesc !== undefined) {
    for (const ref of collectReferencedObjects(rootDesc, filters)) {
      if (!seen.has(ref)) queue.push({ name: ref, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    parents.add(name);
    distances.set(name, depth);

    const desc = describes.get(name);
    if (desc === undefined || isStandardRootObject(name)) continue;

    for (const ref of collectReferencedObjects(desc, filters)) {
      if (!seen.has(ref) && !queue.some((q) => q.name === ref)) {
        queue.push({ name: ref, depth: depth + 1 });
      }
    }
  }

  const includeChildren = opts.includeChildren ?? true;
  if (includeChildren && rootDesc !== undefined) {
    for (const c of collectChildObjects(rootDesc)) {
      if (c === rootObject) continue;
      children.add(c);
      if (!distances.has(c)) distances.set(c, 1);
    }
  }

  return buildGraph({
    rootObject,
    describes,
    parentObjects: parents,
    childObjects: children,
    distances,
    rowCounts: opts.rowCounts,
    recordType: opts.recordType,
    fieldFilters: filters,
  });
}

/** Convenience — the parent/child sets a build produced, reused by render test helpers. */
export function walkedNeighbors(
  rootObject: string,
  describes: Map<string, SObjectDescribe>,
  opts: BuildFromRootOptions = {},
): { parents: string[]; children: string[] } {
  const filters = opts.fieldFilters ?? DEFAULT_FIELD_FILTERS;
  const parents = new Set<string>();
  const children = new Set<string>();
  const rootDesc = describes.get(rootObject);
  const seen = new Set<string>([rootObject]);
  const queue: string[] = [];

  if (rootDesc !== undefined) {
    for (const ref of collectReferencedObjects(rootDesc, filters)) {
      if (!seen.has(ref)) queue.push(ref);
    }
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    parents.add(name);
    const desc = describes.get(name);
    if (desc === undefined || isStandardRootObject(name)) continue;
    for (const ref of collectReferencedObjects(desc, filters)) {
      if (!seen.has(ref)) queue.push(ref);
    }
  }

  const includeChildren = opts.includeChildren ?? true;
  if (includeChildren && rootDesc !== undefined) {
    for (const c of collectChildObjects(rootDesc)) {
      if (c !== rootObject) children.add(c);
    }
  }

  return { parents: [...parents], children: [...children] };
}
