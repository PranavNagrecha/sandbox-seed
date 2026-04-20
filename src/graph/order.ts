import type { DependencyGraph } from "./build.ts";
import { type SCC, stronglyConnectedComponents } from "./cycles.ts";

export type LoadStep =
  | { kind: "single"; object: string }
  | {
      kind: "cycle";
      objects: string[];
      breakEdge: { source: string; target: string; fieldName: string } | null;
      internalEdges: SCC["internalEdges"];
    };

export type LoadPlan = {
  /**
   * Ordered steps. A `single` step inserts one object. A `cycle` step inserts
   * the whole SCC in a two-phase pattern (insert with break-edge nulled, then update).
   */
  steps: LoadStep[];
  /**
   * Objects deliberately excluded from the load — standard root objects, and objects
   * the user did not request (we don't create records in parents).
   */
  excluded: string[];
  cycles: SCC[];
};

export type OrderOptions = {
  /** Only these objects will appear in the load plan. Others are "excluded". */
  requestedObjects: string[];
  /** Standard root objects (e.g. User, RecordType) are always excluded. */
  includeStandardRoots?: boolean;
};

/**
 * Compute a load plan: topological order of the condensation (SCCs collapsed to single nodes).
 *
 * Algorithm:
 *   1. Run Tarjan's SCC to find cycles.
 *   2. Build the condensation DAG: one node per SCC (or singleton), edges between SCCs.
 *   3. Kahn's topological sort on the condensation. Ties broken alphabetically for determinism.
 *   4. Filter the result to only objects the user requested (or everything if includeStandardRoots).
 */
export function computeLoadOrder(graph: DependencyGraph, opts: OrderOptions): LoadPlan {
  const includeRoots = opts.includeStandardRoots ?? false;
  const requested = new Set(opts.requestedObjects);

  const sccs = stronglyConnectedComponents(graph);

  // Map each node to its SCC index (or -1 if singleton).
  const nodeToScc = new Map<string, number>();
  sccs.forEach((scc, i) => {
    for (const n of scc.nodes) nodeToScc.set(n, i);
  });

  // Condensation: every node becomes a "component" — SCCs use their SCC id (negative),
  // singletons use the node name directly.
  type ComponentId = string;
  const componentOf = (node: string): ComponentId => {
    const sccIdx = nodeToScc.get(node);
    if (sccIdx !== undefined) return `scc:${sccIdx}`;
    return `node:${node}`;
  };

  const components = new Set<ComponentId>();
  for (const n of graph.nodes.keys()) components.add(componentOf(n));

  // Build condensation edges (dedup).
  const condEdges = new Map<ComponentId, Set<ComponentId>>();
  for (const c of components) condEdges.set(c, new Set());
  for (const edge of graph.edges) {
    const s = componentOf(edge.source);
    const t = componentOf(edge.target);
    if (s !== t) {
      condEdges.get(s)!.add(t);
    }
  }

  // Kahn's over the REVERSED condensation.
  //
  // Edge semantics: source references target; target must exist before source
  // can be inserted. So topo order is: components with no outgoing edges first.
  // Equivalent formulation — reverse the edges (target → source), then Kahn's:
  // in-degree of `src` in the reversed graph = its out-degree in the original
  // = number of distinct components it depends on.
  const revInDeg = new Map<ComponentId, number>();
  for (const c of components) revInDeg.set(c, 0);
  for (const [src, targets] of condEdges) {
    revInDeg.set(src, (revInDeg.get(src) ?? 0) + targets.size);
  }

  // Build reversed adjacency for Kahn.
  const revAdj = new Map<ComponentId, Set<ComponentId>>();
  for (const c of components) revAdj.set(c, new Set());
  for (const [src, targets] of condEdges) {
    for (const t of targets) {
      revAdj.get(t)!.add(src);
    }
  }

  const queue: ComponentId[] = [];
  for (const [c, d] of revInDeg) {
    if (d === 0) queue.push(c);
  }
  queue.sort(compIdCompare);

  const ordered: ComponentId[] = [];
  while (queue.length > 0) {
    const c = queue.shift()!;
    ordered.push(c);
    const batch: ComponentId[] = [];
    for (const n of revAdj.get(c) ?? []) {
      const d = (revInDeg.get(n) ?? 0) - 1;
      revInDeg.set(n, d);
      if (d === 0) batch.push(n);
    }
    batch.sort(compIdCompare);
    queue.push(...batch);
  }

  // Build the steps, filtering to requested (and optionally roots).
  const steps: LoadStep[] = [];
  const excluded: string[] = [];

  const includeInLoad = (name: string): boolean => {
    if (!requested.has(name)) return false;
    const attrs = graph.nodes.get(name);
    if (attrs === undefined) return false;
    if (attrs.isStandardRoot && !includeRoots) return false;
    return true;
  };

  for (const comp of ordered) {
    if (comp.startsWith("scc:")) {
      const idx = Number(comp.slice(4));
      const scc = sccs[idx];
      const keep = scc.nodes.filter(includeInLoad);
      if (keep.length === 0) {
        for (const n of scc.nodes) {
          if (!excluded.includes(n)) excluded.push(n);
        }
        continue;
      }
      steps.push({
        kind: "cycle",
        objects: keep,
        breakEdge: scc.breakEdge,
        internalEdges: scc.internalEdges,
      });
    } else {
      const node = comp.slice(5);
      if (includeInLoad(node)) {
        steps.push({ kind: "single", object: node });
      } else {
        if (!excluded.includes(node)) excluded.push(node);
      }
    }
  }

  return { steps, excluded, cycles: sccs };
}

function compIdCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
