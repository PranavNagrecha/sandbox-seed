import type { NodeAttrs } from "../graph/build.ts";
import { focusSubgraph } from "./focus.ts";
import type { Renderer } from "./types.ts";

export const renderTree: Renderer = (input) => {
  const { graph, plan, cycles, rootObject, parentObjects, childObjects, meta, maxNodes } = input;

  const visibleNodes = resolveVisibleNodes(input);
  const lines: string[] = [];
  const rootAttrs = graph.nodes.get(rootObject);

  // ── Focus header ────────────────────────────────────────────────
  lines.push(`Focus: ${rootObject}${rootAttrs?.custom === true ? " (custom)" : ""}`);
  lines.push(`  org: ${meta.orgAlias ?? meta.orgId} · API v${meta.apiVersion}`);
  if (rootAttrs?.recordType !== undefined) {
    lines.push(`  record type: ${rootAttrs.recordType}`);
  }
  if (rootAttrs !== undefined) {
    const rc = rootAttrs.rowCount === null ? "—" : rootAttrs.rowCount.toLocaleString();
    lines.push(
      `  row count: ${rc}   required: ${rootAttrs.requiredFields.length}   sensitive: ${rootAttrs.sensitiveFields.length}   fields total: ${rootAttrs.totalFieldCount}`,
    );
    const dropped = rootAttrs.droppedFieldCounts;
    const dropParts: string[] = [];
    if (dropped.formula > 0) dropParts.push(`${dropped.formula} formula`);
    if (dropped.audit > 0) dropParts.push(`${dropped.audit} audit`);
    if (dropped.nonCreateable > 0) dropParts.push(`${dropped.nonCreateable} non-createable`);
    if (dropParts.length > 0) lines.push(`  filtered: ${dropParts.join(", ")}`);
  }
  lines.push(`  generated: ${meta.generatedAt}`);
  lines.push("");

  // ── Required fields ────────────────────────────────────────────
  if (rootAttrs !== undefined && rootAttrs.requiredFields.length > 0) {
    lines.push(`Required fields on ${rootObject}:`);
    for (const rf of rootAttrs.requiredFields) {
      const tag = rf.reason === "requiredByMasterDetail" ? " [master-detail]" : "";
      const refTag = rf.referenceTo.length > 0 ? `  → ${rf.referenceTo.join("|")}` : "";
      const pl =
        rf.picklistValueCount > 0 ? `  (${rf.picklistValueCount} picklist values)` : "";
      lines.push(`  - ${rf.name}: ${rf.type}${tag}${refTag}${pl}`);
    }
    lines.push("");
  }

  // ── Sensitive fields ───────────────────────────────────────────
  if (rootAttrs !== undefined && rootAttrs.sensitiveFields.length > 0) {
    lines.push(`Sensitive-looking fields on ${rootObject} (verify before seeding):`);
    for (const sf of rootAttrs.sensitiveFields) {
      lines.push(`  ! ${sf.name}: ${sf.type}${sf.label !== undefined ? ` — ${sf.label}` : ""}`);
    }
    lines.push("");
  }

  // ── Parents (transitive) ───────────────────────────────────────
  const visibleParents = parentObjects.filter((n) => visibleNodes.has(n));
  if (visibleParents.length > 0) {
    lines.push(`Parents (transitive, max ${maxDistance(visibleParents, graph)} levels up):`);
    const sorted = visibleParents.sort((a, b) => {
      const da = graph.nodes.get(a)?.distanceFromRoot ?? Number.POSITIVE_INFINITY;
      const db = graph.nodes.get(b)?.distanceFromRoot ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    let shown = 0;
    for (const name of sorted) {
      if (maxNodes !== null && shown >= maxNodes) {
        lines.push(`  … ${sorted.length - shown} more parent(s) not shown (raise --max-nodes)`);
        break;
      }
      const attrs = graph.nodes.get(name);
      if (attrs === undefined) continue;
      lines.push(`  ${indent(attrs.distanceFromRoot)}${formatNodeLine(name, attrs)}`);
      const edgesFromRoot = graph.edges.filter(
        (e) => e.source === rootObject && e.target === name,
      );
      for (const edge of edgesFromRoot) {
        lines.push(`    via ${edge.fieldName}${edgeSuffix(edge)}`);
      }
      shown++;
    }
    lines.push("");
  }

  // ── Children (1 level) ─────────────────────────────────────────
  const visibleChildren = childObjects.filter((n) => visibleNodes.has(n));
  if (visibleChildren.length > 0) {
    lines.push(`Children (1 level down from ${rootObject}):`);
    const sorted = visibleChildren.sort();
    let shown = 0;
    for (const name of sorted) {
      if (maxNodes !== null && shown >= maxNodes) {
        lines.push(`  … ${sorted.length - shown} more child(ren) not shown`);
        break;
      }
      const attrs = graph.nodes.get(name);
      if (attrs === undefined) continue;
      lines.push(`  ${formatNodeLine(name, attrs)}`);
      const edgesToRoot = graph.edges.filter(
        (e) => e.source === name && e.target === rootObject && e.kind === "child",
      );
      for (const edge of edgesToRoot) {
        lines.push(`    ${name}.${edge.fieldName} → ${rootObject}${edgeSuffix(edge)}`);
      }
      shown++;
    }
    lines.push("");
  }

  // ── Cycles ─────────────────────────────────────────────────────
  if (cycles.length > 0) {
    lines.push(`Cycles (${cycles.length}):`);
    cycles.forEach((scc, i) => {
      lines.push(`  SCC-${i + 1}: ${scc.nodes.join(" ↔ ")}`);
      for (const edge of scc.internalEdges) {
        lines.push(`    (${edge.source}.${edge.fieldName} → ${edge.target})`);
      }
      if (scc.breakEdge !== null) {
        lines.push(
          `    Strategy: two-phase insert. Break edge: ${scc.breakEdge.source}.${scc.breakEdge.fieldName} (nulled during pass 1).`,
        );
      } else {
        lines.push(
          `    WARNING: no nillable edge in this cycle. Two-phase insert requires an external-ID strategy.`,
        );
      }
    });
    lines.push("");
  }

  // ── Load order ─────────────────────────────────────────────────
  lines.push("Load order (topological, cycles broken):");
  if (plan.steps.length === 0) {
    lines.push("  (nothing loadable — root may be a standard root object)");
  } else {
    plan.steps.forEach((step, i) => {
      if (step.kind === "single") {
        lines.push(`  ${i + 1}. ${step.object}`);
      } else {
        const breakNote =
          step.breakEdge !== null
            ? ` [break: ${step.breakEdge.source}.${step.breakEdge.fieldName}]`
            : "";
        lines.push(`  ${i + 1}. CYCLE ${step.objects.join(" + ")}${breakNote}`);
      }
    });
  }

  const relevant = new Set<string>([...parentObjects, ...childObjects]);
  const shownExcluded = plan.excluded.filter((n) => {
    const attrs = graph.nodes.get(n);
    return attrs?.isStandardRoot === true || relevant.has(n);
  });
  const hiddenExcludedCount = plan.excluded.length - shownExcluded.length;
  if (shownExcluded.length > 0) {
    lines.push("");
    lines.push(
      `Excluded from load order (${shownExcluded.length} walked): ${shownExcluded.sort().join(", ")}`,
    );
    if (hiddenExcludedCount > 0) {
      lines.push(
        `  (+ ${hiddenExcludedCount} referenced-only node(s) pulled in via parent ref fields — not walked)`,
      );
    }
    lines.push("  * = standard root (Salesforce infrastructure; not seedable)");
  }

  return lines.join("\n");
};

function formatNodeLine(name: string, attrs: NodeAttrs): string {
  const markers: string[] = [];
  if (attrs.isStandardRoot) markers.push("*standard-root");
  if (!attrs.described) markers.push("referenced-only");
  if (attrs.custom) markers.push("custom");
  const tag = markers.length > 0 ? ` (${markers.join(", ")})` : "";
  const count = attrs.rowCount === null ? "" : `  · ${attrs.rowCount.toLocaleString()} rows`;
  const req = attrs.described && attrs.requiredFields.length > 0
    ? `  · ${attrs.requiredFields.length} req`
    : "";
  const sens = attrs.described && attrs.sensitiveFields.length > 0
    ? `  · ${attrs.sensitiveFields.length} sensitive`
    : "";
  return `${name}${tag}${count}${req}${sens}`;
}

function edgeSuffix(edge: {
  nillable: boolean;
  polymorphic: boolean;
  masterDetail: boolean;
  custom: boolean;
}): string {
  const parts: string[] = [];
  if (edge.masterDetail) parts.push("master-detail");
  else if (!edge.nillable) parts.push("required");
  if (edge.polymorphic) parts.push("polymorphic");
  if (edge.custom) parts.push("custom");
  return parts.length > 0 ? `  [${parts.join(", ")}]` : "";
}

function indent(distance: number): string {
  if (!Number.isFinite(distance) || distance <= 1) return "";
  return "  ".repeat(distance - 1);
}

function maxDistance(
  names: string[],
  graph: { nodes: Map<string, NodeAttrs> },
): number {
  let max = 0;
  for (const n of names) {
    const d = graph.nodes.get(n)?.distanceFromRoot ?? 0;
    if (Number.isFinite(d) && d > max) max = d;
  }
  return max;
}

function resolveVisibleNodes(input: Parameters<Renderer>[0]): Set<string> {
  if (input.focus !== null) {
    return focusSubgraph(input.graph, input.focus.object, input.focus.depth);
  }
  return new Set(input.graph.nodes.keys());
}
