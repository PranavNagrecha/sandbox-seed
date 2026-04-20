import type { DependencyGraph } from "./build.ts";

export type SCC = {
  /** Set of node names in this SCC. Self-loops count — a single node with a self-edge IS an SCC. */
  nodes: string[];
  /**
   * Edges entirely inside this SCC. Used to propose a break edge for the two-phase load.
   */
  internalEdges: Array<{ source: string; target: string; fieldName: string; nillable: boolean }>;
  /**
   * A recommended break edge — a nillable edge whose field will be set to null during the
   * first insert pass and back-filled in the second pass. Null if no nillable edge exists
   * in the SCC (which means the cycle cannot be safely broken without further intervention).
   */
  breakEdge: { source: string; target: string; fieldName: string } | null;
};

/**
 * Tarjan's strongly-connected components.
 * Iterative (explicit stack) so we don't blow the call stack on deep graphs.
 *
 * Only returns SCCs that are "real cycles":
 *   - size > 1, OR
 *   - size === 1 AND the node has a self-edge
 * Single nodes without self-edges are not cycles and are omitted from the result.
 */
export function stronglyConnectedComponents(graph: DependencyGraph): SCC[] {
  const adj = buildAdjacency(graph);

  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;

  type Frame = {
    node: string;
    neighbors: string[];
    i: number;
  };

  const allNodes = [...graph.nodes.keys()];

  for (const start of allNodes) {
    if (indices.has(start)) continue;

    const callStack: Frame[] = [];

    const strongConnect = (v: string) => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      callStack.push({ node: v, neighbors: adj.get(v) ?? [], i: 0 });
    };

    strongConnect(start);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i];
        frame.i++;
        if (!indices.has(w)) {
          strongConnect(w);
        } else if (onStack.has(w)) {
          const current = lowlinks.get(frame.node)!;
          const wIndex = indices.get(w)!;
          if (wIndex < current) {
            lowlinks.set(frame.node, wIndex);
          }
        }
      } else {
        const v = frame.node;
        const vLow = lowlinks.get(v)!;
        const vIdx = indices.get(v)!;
        if (vLow === vIdx) {
          const component: string[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
            if (w === v) break;
          }
          sccs.push(component);
        }
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          const parentLow = lowlinks.get(parent.node)!;
          const vLowAfter = lowlinks.get(v)!;
          if (vLowAfter < parentLow) {
            lowlinks.set(parent.node, vLowAfter);
          }
        }
      }
    }
  }

  return sccs
    .filter((comp) => comp.length > 1 || hasSelfEdge(graph, comp[0]))
    .map((comp) => toSCC(comp, graph));
}

function buildAdjacency(graph: DependencyGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const name of graph.nodes.keys()) {
    adj.set(name, []);
  }
  for (const edge of graph.edges) {
    const list = adj.get(edge.source);
    if (list !== undefined) list.push(edge.target);
  }
  return adj;
}

function hasSelfEdge(graph: DependencyGraph, node: string): boolean {
  return graph.edges.some((e) => e.source === node && e.target === node);
}

function toSCC(nodes: string[], graph: DependencyGraph): SCC {
  const nodeSet = new Set(nodes);
  const internalEdges = graph.edges
    .filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      fieldName: e.fieldName,
      nillable: e.nillable,
    }));

  // Prefer breaking on a nillable custom edge (safest to null temporarily).
  // Within nillable edges, prefer NOT breaking a self-edge (they're cheap to resolve anyway).
  const breakable = internalEdges
    .filter((e) => e.nillable)
    .sort((a, b) => {
      const aSelf = a.source === a.target ? 1 : 0;
      const bSelf = b.source === b.target ? 1 : 0;
      return aSelf - bSelf;
    });

  const breakEdge =
    breakable.length > 0
      ? {
          source: breakable[0].source,
          target: breakable[0].target,
          fieldName: breakable[0].fieldName,
        }
      : null;

  return {
    nodes: [...nodes].sort(),
    internalEdges,
    breakEdge,
  };
}
