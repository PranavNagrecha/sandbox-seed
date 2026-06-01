import type { DependencyGraph } from "../graph/build.ts";
import { isStandardRootObject } from "../graph/standard-objects.ts";

/**
 * Split walked parents + children into two user-facing buckets:
 *
 *   WILL need  — relationship-required. Master-detail or non-nillable
 *                lookups whose target must be seeded for the child to
 *                insert. Transitively closed: if A needs B, and B needs C,
 *                then C is also mustInclude.
 *
 *   MAYBE      — user-optional. Nillable lookups on the root or in the
 *                transitive parent chain, plus every 1-level child of the
 *                root. The user decides whether to include these.
 *
 * Standard-root objects (User, RecordType, Profile, …) never appear in
 * either list. They're referenced by External ID / DeveloperName at
 * insert time, never seeded.
 *
 * The seeding root itself is always implicitly included and does not
 * appear in either bucket.
 *
 * Noise filtering — on real enterprise orgs, a raw 1-hop walk surfaces
 * hundreds of objects the user almost never wants to seed:
 *
 *   - Managed-package objects (`APXTConga4__Contract__c`, `hed__Account__c`,
 *     `smagicinteract__*`). Detected by the `<namespace>__<name>` pattern.
 *     Hidden unless `includeManagedPackages: true`.
 *   - System-automation children (`FeedComment`, `AgentWork`,
 *     `FlowRecordRelation`, `ProcessInstance`, `NetworkActivity`,
 *     `EntitySubscription`, `*History`, `*ChangeEvent`, `*Share`, `*Feed`,
 *     `*Tag`, etc.). Detected by a curated pattern list. Hidden unless
 *     `includeSystemChildren: true`.
 *
 * Filtering is a UX decision; these objects remain in the underlying graph
 * so the user can still opt them in explicitly via `select` — the hidden
 * names are returned in `hiddenManagedParents` / `hiddenSystemChildren`
 * counts so the agent can surface "N managed-package parents hidden".
 */

/**
 * Per-object hint that the optional object will silently drop records at
 * run time unless the FK target is also included in the seed.
 *
 * Generated when an optional parent/child has a required (master-detail
 * OR non-nillable) FK whose target is not already in `mustIncludeParents`.
 * `requiresStatus` tells the caller whether the target is at least
 * reachable as an optional (the user can add it via `select`) or absent
 * from this analyze pass entirely (deeper walk required).
 */
export type OptionalParentWarning = {
  /** The optional object whose required FK is unresolved. */
  object: string;
  /** API name of the required reference field on `object`. */
  fkField: string;
  /**
   * Object that `fkField` points to. For a polymorphic FK this is a
   * *representative* target (an in-scope optional object when one exists,
   * else the first alphabetically) — the FK needs any ONE of its targets,
   * and `requiresAnyOfCount` reports how many it can choose from.
   */
  requiresObject: string;
  /** `optional` → user can add via `includeOptionalParents` on select. */
  requiresStatus: "optional" | "missing";
  /**
   * Present only when `fkField` is polymorphic (>1 possible target object).
   * The FK is satisfied by any single one of them, so this warning is
   * collapsed to one row regardless of how many objects the FK can address —
   * without this, a field like `Attachment.ParentId` (hundreds of targets)
   * would emit hundreds of warnings and blow the agent's context window.
   */
  requiresAnyOfCount?: number;
};

export type SeedClassification = {
  root: string;
  mustIncludeParents: string[];
  optionalParents: string[];
  optionalChildren: string[];
  /** Objects referenced by the graph but unseedable (standard roots). */
  standardRoots: string[];
  /** Counts of objects hidden by noise filters (surfaced in analyze guidance). */
  hiddenManagedParentCount: number;
  hiddenManagedChildCount: number;
  hiddenSystemChildCount: number;
  /** Present when the user explicitly opted in — the full name list. */
  hiddenManagedParentNames?: string[];
  hiddenManagedChildNames?: string[];
  hiddenSystemChildNames?: string[];
  /**
   * Per-object warnings: optional parents/children that carry a required
   * FK to an object the user hasn't necessarily picked. If left
   * unresolved, those records skip silently at run time. The agent (or
   * user) should add `requiresObject` to `includeOptionalParents` on
   * `select` when `requiresStatus === "optional"`, or rework the scope
   * when `requiresStatus === "missing"`.
   */
  optionalParentWarnings: OptionalParentWarning[];
};

export type ClassifyInput = {
  graph: DependencyGraph;
  rootObject: string;
  parentObjects: Set<string> | string[];
  childObjects: Set<string> | string[];
  /** Include managed-package parents/children in the output. Default false. */
  includeManagedPackages?: boolean;
  /** Include system-automation children (Feed*, *History, …). Default false. */
  includeSystemChildren?: boolean;
};

/**
 * Detect managed-package API names. Salesforce namespaces the API name as
 * `<namespace>__<object>` for managed objects. `<name>__c` on its own is a
 * local custom object; `<ns>__<name>` or `<ns>__<name>__c` is managed.
 */
export function isManagedPackageObject(name: string): boolean {
  const parts = name.split("__");
  if (parts.length >= 3) return true; // e.g. ns__Obj__c
  if (parts.length === 2 && parts[1] !== "c") return true; // e.g. ns__Obj
  return false;
}

/**
 * Curated system-automation pattern list. These are children that
 * Salesforce's automation engine populates implicitly — surfacing them
 * in the "what optional records do you want to copy?" picker is pure
 * noise 99% of the time.
 */
const SYSTEM_CHILD_PATTERNS: Array<RegExp> = [
  /Feed$/, // AccountFeed, CaseFeed
  /^FeedComment$/,
  /^FeedItem$/,
  /^FeedAttachment$/,
  /^FeedRevision$/,
  /^FeedPollChoice$/,
  /^FeedPollVote$/,
  /History$/, // AccountHistory, CaseHistory
  /History2$/,
  /ChangeEvent$/,
  /Share$/,
  /Tag$/,
  /OwnerSharingRule$/,
  /AccessRule$/,
  /^AgentWork/,
  /^FlowRecord/,
  /^FlowOrchestration/,
  /^FlowExecution/,
  /^FlowInterview/,
  /^ProcessInstance/,
  /^ProcessException/,
  /^RecordAction/,
  /^PendingServiceRouting/,
  /^NetworkActivity/,
  /^NetworkFeed/,
  /^NetworkUser/,
  /^EntitySubscription$/,
  /^CombinedAttachment$/,
  /^AIInsightValue$/,
  /^AIRecordInsight$/,
  /^OpenActivity$/,
  /^ActivityHistory$/,
  /^CollaborationGroupRecord$/,
  /^UserDefinedLabelAssignment$/,
  /^AttachedContentDocument$/,
  /^AttachedContentNote$/,
  /^LookedUpFromActivity$/,
];

export function isSystemChildObject(name: string): boolean {
  for (const p of SYSTEM_CHILD_PATTERNS) {
    if (p.test(name)) return true;
  }
  return false;
}

export function classifyForSeed(input: ClassifyInput): SeedClassification {
  const parentSet = toSet(input.parentObjects);
  const childSet = toSet(input.childObjects);
  const root = input.rootObject;
  const includeManaged = input.includeManagedPackages === true;
  const includeSystem = input.includeSystemChildren === true;

  // Build an index: source → Array<{target, fieldName, masterDetail, nillable}>
  // for the "parent" edge kind only (kind === "parent" means source
  // references target via an FK, so the target must exist first).
  const parentEdgesBySource = new Map<
    string,
    Array<{
      target: string;
      fieldName: string;
      masterDetail: boolean;
      nillable: boolean;
    }>
  >();
  for (const edge of input.graph.edges) {
    if (edge.kind !== "parent") continue;
    const list = parentEdgesBySource.get(edge.source) ?? [];
    list.push({
      target: edge.target,
      fieldName: edge.fieldName,
      masterDetail: edge.masterDetail,
      nillable: edge.nillable,
    });
    parentEdgesBySource.set(edge.source, list);
  }

  // BFS from root: mark every reachable target whose edge is required
  // (master-detail OR !nillable) as mustInclude. Closure stops expanding
  // at standard roots and at nodes we've already visited.
  const mustInclude = new Set<string>();
  const queue: string[] = [root];
  const visited = new Set<string>([root]);

  while (queue.length > 0) {
    const source = queue.shift()!;
    const outgoing = parentEdgesBySource.get(source) ?? [];
    for (const e of outgoing) {
      if (e.target === root) continue;
      if (isStandardRootObject(e.target)) continue;
      const required = e.masterDetail || !e.nillable;
      if (required) {
        if (!mustInclude.has(e.target)) {
          mustInclude.add(e.target);
          if (!visited.has(e.target)) {
            visited.add(e.target);
            queue.push(e.target);
          }
        } else if (!visited.has(e.target)) {
          visited.add(e.target);
          queue.push(e.target);
        }
      }
      // Optional edges are not followed transitively — the user decides
      // whether to pull those in via `select`.
    }
  }

  const standardRoots: string[] = [];
  const hiddenManagedParentNames: string[] = [];
  const optionalParents: string[] = [];
  for (const p of parentSet) {
    if (p === root) continue;
    if (isStandardRootObject(p)) {
      standardRoots.push(p);
      continue;
    }
    if (mustInclude.has(p)) {
      // mustInclude is non-negotiable — never hide it, even if it's a
      // managed-package object. The user opted in by virtue of seeding
      // the root, and the FK is required.
      continue;
    }
    if (!includeManaged && isManagedPackageObject(p)) {
      hiddenManagedParentNames.push(p);
      continue;
    }
    optionalParents.push(p);
  }

  const optionalChildren: string[] = [];
  const hiddenManagedChildNames: string[] = [];
  const hiddenSystemChildNames: string[] = [];
  for (const c of childSet) {
    if (c === root) continue;
    if (isStandardRootObject(c)) {
      // A standard-root object can't be a "child" in practice, but keep
      // defensive: if it shows up we surface it as such.
      if (!standardRoots.includes(c)) standardRoots.push(c);
      continue;
    }
    if (mustInclude.has(c)) {
      // A child that is also required by some FK is already mustInclude;
      // don't double-list it.
      continue;
    }
    if (!includeSystem && isSystemChildObject(c)) {
      hiddenSystemChildNames.push(c);
      continue;
    }
    if (!includeManaged && isManagedPackageObject(c)) {
      hiddenManagedChildNames.push(c);
      continue;
    }
    optionalChildren.push(c);
  }

  // Cross-walk: for each optional parent/child, check its OWN required
  // parent FKs. If the FK target isn't already in mustInclude, the user
  // is at risk of silent row skips at run time — the run-time loader
  // can't resolve a non-nillable FK whose target was never seeded.
  // Surface ONE warning per (optional object, unresolved FK) pair so
  // the caller can either add the target on `select` or rework scope.
  const optionalNameSet = new Set<string>([...optionalParents, ...optionalChildren]);
  const optionalParentWarnings: OptionalParentWarning[] = [];
  for (const obj of optionalNameSet) {
    const edges = parentEdgesBySource.get(obj) ?? [];
    // Group an object's required parent FKs BY FIELD. A polymorphic FK
    // (e.g. Attachment.ParentId, ContentDocumentLink.LinkedEntityId,
    // EventRelation.RelationId) surfaces here as one edge per `referenceTo`
    // target — hundreds of them on a managed-package-heavy org. Such an FK
    // is satisfied if ANY ONE target is in scope, so it must be evaluated
    // as a single unit. Emitting one warning per target would be both
    // WRONG (a polymorphic FK needs one parent, not all of them) and a
    // context-window bomb for the agent (3k+ rows seen in the wild).
    const byField = new Map<string, { targets: Set<string>; rootSatisfied: boolean }>();
    for (const e of edges) {
      const required = e.masterDetail || !e.nillable;
      if (!required) continue;
      const g = byField.get(e.fieldName) ?? { targets: new Set<string>(), rootSatisfied: false };
      if (e.target === root) g.rootSatisfied = true;
      else if (!isStandardRootObject(e.target)) g.targets.add(e.target);
      byField.set(e.fieldName, g);
    }
    for (const [fkField, g] of byField) {
      // Resolvable (no silent-skip risk) if the root is itself a target —
      // the root is always seeded — or any target is already a must-include.
      if (g.rootSatisfied) continue;
      const targets = [...g.targets];
      if (targets.length === 0) continue;
      if (targets.some((t) => mustInclude.has(t))) continue;
      // Prefer naming a target the user can act on (an optional object they
      // can add via `select`) over an arbitrary one.
      const optionalTargets = targets.filter((t) => optionalNameSet.has(t)).sort();
      const requiresObject = optionalTargets[0] ?? [...targets].sort()[0];
      optionalParentWarnings.push({
        object: obj,
        fkField,
        requiresObject,
        requiresStatus: optionalTargets.length > 0 ? "optional" : "missing",
        ...(targets.length > 1 && { requiresAnyOfCount: targets.length }),
      });
    }
  }
  // Stable sort so successive analyze calls don't churn the response.
  optionalParentWarnings.sort((a, b) =>
    a.object === b.object ? a.fkField.localeCompare(b.fkField) : a.object.localeCompare(b.object),
  );

  return {
    root,
    mustIncludeParents: [...mustInclude].sort(),
    optionalParents: optionalParents.sort(),
    optionalChildren: optionalChildren.sort(),
    standardRoots: standardRoots.sort(),
    hiddenManagedParentCount: hiddenManagedParentNames.length,
    hiddenManagedChildCount: hiddenManagedChildNames.length,
    hiddenSystemChildCount: hiddenSystemChildNames.length,
    // Names returned only when the caller opted in — so the LLM doesn't
    // get flooded with 191 managed-package object names by default.
    ...(includeManaged && { hiddenManagedParentNames: hiddenManagedParentNames.sort() }),
    ...(includeManaged && { hiddenManagedChildNames: hiddenManagedChildNames.sort() }),
    ...(includeSystem && { hiddenSystemChildNames: hiddenSystemChildNames.sort() }),
    optionalParentWarnings,
  };
}

function toSet(input: Set<string> | string[]): Set<string> {
  return input instanceof Set ? input : new Set(input);
}
