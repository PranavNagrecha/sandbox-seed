import { focusSubgraph } from "./focus.ts";
import type { Renderer } from "./types.ts";

export const renderMermaid: Renderer = (input) => {
  const { graph, cycles, rootObject, focus, maxNodes } = input;

  const visible =
    focus !== null ? focusSubgraph(graph, focus.object, focus.depth) : new Set(graph.nodes.keys());

  const cappedNodes = capNodes(visible, maxNodes);
  const lines: string[] = ["flowchart LR"];

  for (const node of cappedNodes) {
    const attrs = graph.nodes.get(node);
    if (attrs === undefined) continue;
    const id = sanitize(node);
    const markers = attrs.isStandardRoot ? "*" : "";
    lines.push(`  ${id}["${node}${markers}"]`);
  }

  const cycleNodes = new Set<string>();
  for (const scc of cycles) for (const n of scc.nodes) cycleNodes.add(n);

  for (const edge of graph.edges) {
    if (!cappedNodes.has(edge.source) || !cappedNodes.has(edge.target)) continue;
    const from = sanitize(edge.source);
    const to = sanitize(edge.target);
    const markers: string[] = [edge.fieldName];
    if (edge.polymorphic) markers.push("*");
    if (edge.masterDetail) markers.push("MD");
    const label = markers.join(" ");
    const arrow =
      cycleNodes.has(edge.source) && cycleNodes.has(edge.target)
        ? "==>"
        : edge.masterDetail
          ? "==>"
          : "-->";
    lines.push(`  ${from} ${arrow}|${label}| ${to}`);
  }

  lines.push("");
  lines.push(`  style ${sanitize(rootObject)} fill:#def,stroke:#059,stroke-width:3px`);
  if (cycleNodes.size > 0) {
    for (const node of cycleNodes) {
      if (cappedNodes.has(node) && node !== rootObject) {
        lines.push(`  style ${sanitize(node)} fill:#fee,stroke:#c33,stroke-width:2px`);
      }
    }
  }

  return lines.join("\n");
};

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "_");
}

function capNodes(visible: Set<string>, maxNodes: number | null): Set<string> {
  if (maxNodes === null || visible.size <= maxNodes) return visible;
  return new Set([...visible].slice(0, maxNodes));
}
