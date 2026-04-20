import { resolveAuth } from "../../auth/sf-auth.ts";
import { DEFAULT_FIELD_FILTERS, type FieldFilterOptions } from "../../graph/filters.ts";
import { runInspect, type InspectResult } from "../../inspect/run.ts";
import type { InspectObjectArgsT } from "../schemas.ts";
import type { ToolOverrides } from "./describe-global.ts";

/**
 * The headline tool. Single root → walk parents transitively → walk children
 * one level → classify required/sensitive → compute load plan.
 *
 * Returns the same shape `runInspect()` produces, serialized to plain JSON
 * (Map → array, Set → array) so MCP clients can consume it without adapters.
 *
 * AI-boundary note: the only network call that touches record data is the
 * opt-in `SELECT COUNT()` — which returns a single integer per object, not
 * rows. Everything else is describe metadata.
 */
export async function inspectObject(
  args: InspectObjectArgsT,
  overrides?: ToolOverrides & { skipGlobalValidate?: boolean },
): Promise<SerializedInspectResult> {
  const auth = overrides?.auth ?? (await resolveAuth(args.org, "60.0"));

  const filters: FieldFilterOptions = {
    includeFormula: args.fieldFilters?.includeFormula ?? DEFAULT_FIELD_FILTERS.includeFormula,
    includeAudit: args.fieldFilters?.includeAudit ?? DEFAULT_FIELD_FILTERS.includeAudit,
    includeNonCreateable:
      args.fieldFilters?.includeNonCreateable ?? DEFAULT_FIELD_FILTERS.includeNonCreateable,
  };

  const result = await runInspect({
    auth,
    rootObject: args.object,
    parentWalkDepth: args.parentDepth ?? 2,
    includeChildren: args.includeChildren ?? true,
    recordType: args.recordType,
    fieldFilters: filters,
    includeCounts: args.includeCounts ?? false,
    cacheTtlSeconds: 86400,
    bypassCache: args.bypassCache ?? false,
    cacheRoot: overrides?.cacheRoot,
    fetchFn: overrides?.fetchFn,
    skipGlobalValidate: overrides?.skipGlobalValidate,
  });

  return serialize(result, { orgId: auth.orgId, alias: auth.alias ?? null });
}

export type SerializedInspectResult = {
  orgId: string;
  alias: string | null;
  rootObject: string;
  parentObjects: string[];
  childObjects: string[];
  graph: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  cycles: Array<{
    nodes: string[];
    internalEdges: unknown[];
    breakEdge: unknown | null;
  }>;
  loadPlan: {
    steps: unknown[];
    excluded: string[];
  };
};

export function serialize(
  result: InspectResult,
  meta: { orgId: string; alias: string | null },
): SerializedInspectResult {
  const nodes = [...result.graph.nodes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, attrs]) => ({
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
    }));

  const edges = result.graph.edges.map((e) => ({
    source: e.source,
    target: e.target,
    fieldName: e.fieldName,
    nillable: e.nillable,
    custom: e.custom,
    polymorphic: e.polymorphic,
    masterDetail: e.masterDetail,
    kind: e.kind,
  }));

  return {
    orgId: meta.orgId,
    alias: meta.alias,
    rootObject: result.rootObject,
    parentObjects: result.parentObjects,
    childObjects: result.childObjects,
    graph: { nodes, edges },
    cycles: result.cycles.map((scc) => ({
      nodes: scc.nodes,
      internalEdges: scc.internalEdges,
      breakEdge: scc.breakEdge,
    })),
    loadPlan: {
      steps: result.plan.steps,
      excluded: result.plan.excluded,
    },
  };
}
