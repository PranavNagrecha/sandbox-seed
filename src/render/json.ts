import { focusSubgraph } from "./focus.ts";
import type { Renderer } from "./types.ts";

export const renderJson: Renderer = (input) => {
  const { graph, plan, cycles, rootObject, parentObjects, childObjects, meta, focus, maxNodes } =
    input;

  const visible =
    focus !== null ? focusSubgraph(graph, focus.object, focus.depth) : new Set(graph.nodes.keys());

  const cappedNodes = capNodes(visible, maxNodes);

  const nodes = [...cappedNodes]
    .sort()
    .map((name) => {
      const attrs = graph.nodes.get(name);
      if (attrs === undefined) return null;
      return {
        name,
        label: attrs.label,
        custom: attrs.custom,
        standardRoot: attrs.isStandardRoot,
        described: attrs.described,
        role: attrs.role,
        distanceFromRoot: Number.isFinite(attrs.distanceFromRoot) ? attrs.distanceFromRoot : null,
        rowCount: attrs.rowCount,
        totalFieldCount: attrs.totalFieldCount,
        droppedFieldCounts: attrs.droppedFieldCounts,
        requiredFields: attrs.requiredFields,
        sensitiveFields: attrs.sensitiveFields,
        recordType: attrs.recordType ?? null,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);

  const edges = graph.edges
    .filter((e) => cappedNodes.has(e.source) && cappedNodes.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      fieldName: e.fieldName,
      nillable: e.nillable,
      custom: e.custom,
      polymorphic: e.polymorphic,
      masterDetail: e.masterDetail,
      kind: e.kind,
    }));

  return JSON.stringify(
    {
      schemaVersion: 2,
      meta,
      rootObject,
      parentObjects,
      childObjects,
      focus,
      truncated: visible.size > cappedNodes.size,
      nodes,
      edges,
      cycles: cycles.map((scc) => ({
        nodes: scc.nodes,
        internalEdges: scc.internalEdges,
        breakEdge: scc.breakEdge,
      })),
      loadPlan: {
        steps: plan.steps,
        excluded: plan.excluded,
      },
    },
    null,
    2,
  );
};

function capNodes(visible: Set<string>, maxNodes: number | null): Set<string> {
  if (maxNodes === null || visible.size <= maxNodes) return visible;
  return new Set([...visible].slice(0, maxNodes));
}
