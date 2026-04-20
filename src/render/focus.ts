import type { DependencyGraph } from "../graph/build.ts";

/**
 * Return the subset of node names within `depth` hops of `root` in the UNDIRECTED
 * projection of the graph. Depth 0 = just the root, depth 1 = root + immediate
 * neighbors, etc.
 */
export function focusSubgraph(
  graph: DependencyGraph,
  root: string,
  depth: number,
): Set<string> {
  if (!graph.nodes.has(root)) return new Set();

  const adj = new Map<string, Set<string>>();
  for (const n of graph.nodes.keys()) adj.set(n, new Set());
  for (const e of graph.edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }

  const visited = new Set<string>([root]);
  let frontier = new Set<string>([root]);
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const node of frontier) {
      for (const n of adj.get(node) ?? new Set<string>()) {
        if (!visited.has(n)) {
          visited.add(n);
          next.add(n);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  return visited;
}
