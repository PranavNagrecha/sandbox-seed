import type { OrgAuth } from "../auth/sf-auth.ts";
import { DescribeCache } from "../describe/cache.ts";
import { DescribeClient } from "../describe/client.ts";
import { type SObjectDescribe, isReference } from "../describe/types.ts";
import { SeedError, UserError } from "../errors.ts";
import {
  buildGraph,
  collectChildObjects,
  collectReferencedObjects,
  type DependencyGraph,
} from "../graph/build.ts";
import type { SCC } from "../graph/cycles.ts";
import { DEFAULT_FIELD_FILTERS, type FieldFilterOptions } from "../graph/filters.ts";
import { computeLoadOrder, type LoadPlan } from "../graph/order.ts";
import { isStandardRootObject } from "../graph/standard-objects.ts";
import { fetchRowCounts } from "../query/counts.ts";

export type InspectOptions = {
  auth: OrgAuth;
  /** The single object the user is focused on. */
  rootObject: string;
  /** Walk parents transitively up to this depth. Stops at standard root objects. */
  parentWalkDepth: number;
  /** If false, skip the 1-level child walk. */
  includeChildren: boolean;
  /** Record-type developer name (scopes required-field analysis on the root). */
  recordType?: string;
  /** Field filters (formula/audit/non-createable). Defaults = all excluded. */
  fieldFilters?: FieldFilterOptions;
  /** If true, run SELECT COUNT() per node (aggregate metadata only). */
  includeCounts: boolean;
  cacheTtlSeconds: number;
  bypassCache: boolean;
  cacheRoot?: string;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  /** Skip global-describe validation (unit-test shortcut). */
  skipGlobalValidate?: boolean;
  /**
   * User-selected "Child + 1" lookups. Key = direct-child-of-root object
   * name; value = reference-field names on that child to walk exactly one
   * hop further to their direct parent. No transitive recursion.
   * See walkFromRoot() Phase 2.
   */
  childLookups?: Record<string, string[]>;
};

export type InspectResult = {
  graph: DependencyGraph;
  plan: LoadPlan;
  cycles: SCC[];
  rootObject: string;
  /** Objects walked as parents of the root (described or referenced-only). */
  parentObjects: string[];
  /** Objects walked as 1-level children of the root. */
  childObjects: string[];
  /**
   * Objects pulled in by resolving user-selected `childLookups`. Subset of
   * parentObjects; surfaced separately so callers can auto-include them in
   * the final seed list without requiring a second `select` step.
   */
  childLookupTargets: string[];
};

/**
 * The pure engine behind `sandbox-seed inspect`. Given auth + a root object,
 * produce a focused dependency graph (root + transitive parents + 1-level children),
 * cycle report, and load plan.
 *
 * Does NOT render. Rendering is the caller's responsibility.
 */
export async function runInspect(opts: InspectOptions): Promise<InspectResult> {
  const filters = opts.fieldFilters ?? DEFAULT_FIELD_FILTERS;

  const cache = new DescribeCache({
    orgId: opts.auth.orgId,
    ttlSeconds: opts.cacheTtlSeconds,
    cacheRoot: opts.cacheRoot,
    bypass: opts.bypassCache,
  });
  const client = new DescribeClient({ auth: opts.auth, cache, fetchFn: opts.fetchFn });

  if (!opts.skipGlobalValidate) {
    await validateObjectsExist(client, [opts.rootObject]);
  }

  const walk = await walkFromRoot(client, {
    root: opts.rootObject,
    parentDepth: opts.parentWalkDepth,
    includeChildren: opts.includeChildren,
    filters,
    childLookups: opts.childLookups,
  });

  const rowCounts = opts.includeCounts
    ? await fetchRowCounts({
        auth: opts.auth,
        objects: [...walk.describes.keys()].filter((n) => !isStandardRootObject(n)),
        fetchFn: opts.fetchFn,
      })
    : undefined;

  const graph = buildGraph({
    rootObject: opts.rootObject,
    describes: walk.describes,
    parentObjects: walk.parents,
    childObjects: walk.children,
    distances: walk.distances,
    rowCounts,
    recordType: opts.recordType,
    fieldFilters: filters,
  });

  // Load plan includes: the root + any described parent/child that isn't a standard root.
  const loadable = [...walk.describes.keys()].filter((n) => {
    const attrs = graph.nodes.get(n);
    return attrs !== undefined && !attrs.isStandardRoot;
  });
  const plan = computeLoadOrder(graph, { requestedObjects: loadable });

  return {
    graph,
    plan,
    cycles: plan.cycles,
    rootObject: opts.rootObject,
    parentObjects: [...walk.parents],
    childObjects: [...walk.children],
    childLookupTargets: [...walk.childLookupTargets],
  };
}

async function validateObjectsExist(client: DescribeClient, objects: string[]): Promise<void> {
  const global = await client.describeGlobal();
  const known = new Set(global.sobjects.map((s) => s.name));
  const missing = objects.filter((o) => !known.has(o));
  if (missing.length > 0) {
    throw new UserError(
      `Unknown object(s) in target org: ${missing.join(", ")}.`,
      "Check spelling. Custom objects need the __c suffix (e.g. MyThing__c).",
    );
  }
}

type WalkResult = {
  describes: Map<string, SObjectDescribe>;
  parents: Set<string>;
  children: Set<string>;
  distances: Map<string, number>;
  /**
   * Targets resolved from user-selected `childLookups` (Phase 2). Subset of
   * `parents` — tracked separately so the MCP layer can auto-include them
   * in the final seed list. Self-references (child.field → child) are NOT
   * added here, since the child is already in scope via the child walk.
   */
  childLookupTargets: Set<string>;
};

/**
 * Breadth-first walk starting from the root.
 *
 * Up-direction (parents): transitive, bounded by `parentDepth`. Stops at standard
 * root objects regardless of depth (they're not seedable). Skips describes that
 * 404 (lack of permission) — the node still appears as "referenced-only".
 *
 * Down-direction (children): exactly one level. Pulled from the root's
 * childRelationships[]. We fetch each child's describe too so we can classify
 * its required fields, BUT we do NOT walk the child's own parents (that would
 * re-explode the graph).
 */
async function walkFromRoot(
  client: DescribeClient,
  opts: {
    root: string;
    parentDepth: number;
    includeChildren: boolean;
    filters: FieldFilterOptions;
    childLookups?: Record<string, string[]>;
  },
): Promise<WalkResult> {
  const describes = new Map<string, SObjectDescribe>();
  const parents = new Set<string>();
  const children = new Set<string>();
  const distances = new Map<string, number>();
  const childLookupTargets = new Set<string>();

  const rootDescribe = await client.describeObject(opts.root);
  describes.set(opts.root, rootDescribe);
  distances.set(opts.root, 0);

  // Parent BFS
  const parentQueue: Array<{ name: string; depth: number }> = [];
  for (const ref of collectReferencedObjects(rootDescribe, opts.filters)) {
    if (ref === opts.root) continue;
    parentQueue.push({ name: ref, depth: 1 });
  }

  while (parentQueue.length > 0) {
    const { name, depth } = parentQueue.shift()!;
    if (describes.has(name)) continue;
    parents.add(name);
    if (isStandardRootObject(name)) {
      // Record as a parent but don't describe it (we won't seed it anyway).
      distances.set(name, depth);
      continue;
    }

    let describe: SObjectDescribe;
    try {
      describe = await client.describeObject(name);
    } catch (err) {
      if (err instanceof SeedError) {
        // Permission denied on this parent — leave it as referenced-only.
        distances.set(name, depth);
        continue;
      }
      throw err;
    }
    describes.set(name, describe);
    distances.set(name, depth);

    if (depth >= opts.parentDepth) continue;
    for (const ref of collectReferencedObjects(describe, opts.filters)) {
      if (describes.has(ref)) continue;
      if (parentQueue.some((q) => q.name === ref)) continue;
      parentQueue.push({ name: ref, depth: depth + 1 });
    }
  }

  // Child walk — exactly one level, from root.
  //
  // Subtle: we ALWAYS record the child in the `children` set, even if the
  // parent walk has already fetched its describe. Previously we skipped with
  // `if (describes.has(child)) continue;` which silently dropped children
  // that had been dragged in as parents-of-parents on managed-package-heavy
  // orgs. Found by smoke-testing against a real sandbox where CaseComment
  // (a standard child of Case) was vanishing from the output because some
  // other object that referenced Case had already pulled CaseComment into
  // `describes` via the parent walk.
  if (opts.includeChildren) {
    for (const child of collectChildObjects(rootDescribe)) {
      if (child === opts.root) continue;
      children.add(child);
      if (isStandardRootObject(child)) {
        if (!distances.has(child)) distances.set(child, 1);
        continue;
      }
      if (describes.has(child)) {
        // Describe already fetched by parent walk — reuse it, but make
        // sure the child is recorded as a 1-level child of root.
        if (!distances.has(child)) distances.set(child, 1);
        continue;
      }
      try {
        const childDescribe = await client.describeObject(child);
        describes.set(child, childDescribe);
        distances.set(child, 1);
      } catch (err) {
        if (err instanceof SeedError) {
          distances.set(child, 1);
          continue;
        }
        throw err;
      }
    }
  }

  // Phase 2: "Child + 1" — user-selected lookup fields on direct children.
  // Exactly one hop from the child to its direct parent. No transitive walk,
  // no recursion into the target's own parents. Self-references (the target
  // equals the child itself, e.g. Contact.ReportsToId → Contact) are a
  // no-op: the target is already in `describes` via the child walk, and
  // buildGraph will emit the self-edge from the child's describe for us.
  if (opts.childLookups !== undefined) {
    for (const [childName, fieldNames] of Object.entries(opts.childLookups)) {
      const childDescribe = describes.get(childName);
      if (childDescribe === undefined) {
        // Validated at `start` to be a direct child; if we got here, the
        // child walk was disabled (includeChildren=false). Skip rather
        // than throw — the walker is used in multiple contexts.
        continue;
      }
      const byName = new Map(childDescribe.fields.map((f) => [f.name, f]));
      for (const fname of fieldNames) {
        const field = byName.get(fname);
        if (field === undefined || !isReference(field)) continue;
        for (const target of field.referenceTo) {
          if (target === opts.root) continue;
          if (target === childName) continue; // self-ref — already in graph
          if (isStandardRootObject(target)) {
            // Surface the target as a parent-ish node but don't describe
            // (unseedable anyway).
            parents.add(target);
            if (!distances.has(target)) distances.set(target, 2);
            continue;
          }
          if (describes.has(target)) {
            parents.add(target);
            childLookupTargets.add(target);
            if (!distances.has(target)) distances.set(target, 2);
            continue;
          }
          try {
            const targetDescribe = await client.describeObject(target);
            describes.set(target, targetDescribe);
          } catch (err) {
            if (err instanceof SeedError) {
              // Permission-denied; leave as referenced-only.
              parents.add(target);
              childLookupTargets.add(target);
              distances.set(target, 2);
              continue;
            }
            throw err;
          }
          parents.add(target);
          childLookupTargets.add(target);
          distances.set(target, 2);
        }
      }
    }
  }

  return { describes, parents, children, distances, childLookupTargets };
}
