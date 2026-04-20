import { focusSubgraph } from "./focus.ts";
import type { Renderer } from "./types.ts";

export const renderDot: Renderer = (input) => {
  const { graph, cycles, rootObject, focus, maxNodes } = input;

  const visible =
    focus !== null ? focusSubgraph(graph, focus.object, focus.depth) : new Set(graph.nodes.keys());

  const cappedNodes = capNodes(visible, maxNodes);
  const cycleNodes = new Set<string>();
  for (const scc of cycles) for (const n of scc.nodes) cycleNodes.add(n);

  const lines: string[] = [
    "digraph dependencies {",
    "  rankdir=LR;",
    '  node [shape=box, fontname="Helvetica", fontsize=10];',
    '  edge [fontname="Helvetica", fontsize=9];',
    "",
  ];

  for (const node of cappedNodes) {
    const attrs = graph.nodes.get(node);
    if (attrs === undefined) continue;
    const label = attrs.isStandardRoot ? `${node}*` : node;
    const fill =
      node === rootObject
        ? ' style="filled" fillcolor="#def" penwidth=2'
        : cycleNodes.has(node)
          ? ' style="filled" fillcolor="#fee"'
          : "";
    lines.push(`  "${node}" [label="${label}"${fill}];`);
  }
  lines.push("");

  for (const edge of graph.edges) {
    if (!cappedNodes.has(edge.source) || !cappedNodes.has(edge.target)) continue;
    const markers: string[] = [edge.fieldName];
    if (edge.polymorphic) markers.push("*");
    if (edge.masterDetail) markers.push("MD");
    const label = markers.join(" ");
    const color =
      cycleNodes.has(edge.source) && cycleNodes.has(edge.target) ? ' color="#c33"' : "";
    const style = edge.masterDetail ? ' style="bold"' : "";
    lines.push(`  "${edge.source}" -> "${edge.target}" [label="${label}"${color}${style}];`);
  }

  lines.push("}");
  return lines.join("\n");
};

function capNodes(visible: Set<string>, maxNodes: number | null): Set<string> {
  if (maxNodes === null || visible.size <= maxNodes) return visible;
  return new Set([...visible].slice(0, maxNodes));
}
