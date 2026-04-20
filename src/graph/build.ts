import type { SObjectDescribe } from "../describe/types.ts";
import { isReference } from "../describe/types.ts";
import {
  applyFieldFilters,
  DEFAULT_FIELD_FILTERS,
  type FieldFilterOptions,
  filterChildRelationships,
  isSensitiveField,
} from "./filters.ts";
import { classifyRequiredFields, type RequiredField } from "./required.ts";
import { isStandardRootObject } from "./standard-objects.ts";

export type NodeRole = "root" | "parent" | "child" | "standard-root";

export type SensitiveField = {
  name: string;
  label?: string;
  type: string;
};

export type NodeAttrs = {
  label: string;
  custom: boolean;
  isStandardRoot: boolean;
  /** Present when we have a full describe for this object. False if referenced-only. */
  described: boolean;
  /** Role relative to the focus root. Root is the `--object`, parents are walked up, children down. */
  role: NodeRole;
  /** Distance from the root in the walked graph. 0 = root itself. */
  distanceFromRoot: number;
  /** Required-field classification (only populated for described nodes). */
  requiredFields: RequiredField[];
  /** Sensitive-looking fields by name pattern (only populated for described nodes). */
  sensitiveFields: SensitiveField[];
  /** Count of fields filtered by the default filters; populated for described nodes. */
  droppedFieldCounts: { formula: number; audit: number; nonCreateable: number };
  /** Total field count (pre-filter), for reporting. */
  totalFieldCount: number;
  /** If --include-counts was passed, row count from SELECT COUNT(). null otherwise. */
  rowCount: number | null;
  /** Requested record-type developer name, if scoped. */
  recordType?: string;
};

export type EdgeKind = "parent" | "child" | "self";

export type EdgeAttrs = {
  /** Field name on `source` that references `target`. */
  fieldName: string;
  nillable: boolean;
  custom: boolean;
  /** True if source field's referenceTo[] has more than one entry. */
  polymorphic: boolean;
  /** True for master-detail (cascadeDelete). Master-detail edges are never breakable. */
  masterDetail: boolean;
  /** Relative to the focus root: "parent" = edge goes up the FK chain, "child" = down. */
  kind: EdgeKind;
};

export type DependencyGraph = {
  nodes: Map<string, NodeAttrs>;
  /**
   * Flat edge list. Multiple edges allowed between same node pair (different fields)
   * and from a single field to multiple targets (polymorphic).
   */
  edges: Array<{ source: string; target: string } & EdgeAttrs>;
};

export type BuildOptions = {
  /** The single object the user is focusing on. */
  rootObject: string;
  /**
   * Describes for the root AND any transitively-referenced parents AND any 1-level
   * children we fetched. Missing entries render as "referenced-only" nodes.
   */
  describes: Map<string, SObjectDescribe>;
  /** Which object names were walked as parents of the root (via reference fields). */
  parentObjects: Set<string>;
  /** Which object names were walked as 1-level children of the root (via childRelationships). */
  childObjects: Set<string>;
  /** Distance-from-root map (0 for root, 1+ for parents & children). */
  distances: Map<string, number>;
  /** Row counts keyed by object name, from the opt-in counts query. */
  rowCounts?: Map<string, number>;
  /** Record-type developer name, if scoped. */
  recordType?: string;
  /** Field filter options; defaults to {formula:false, audit:false, nonCreateable:false}. */
  fieldFilters?: FieldFilterOptions;
};

/**
 * Build a dependency graph focused on one root object.
 *
 * Contract:
 *  - Every object with a describe becomes a described node.
 *  - Referenced objects without describes become referenced-only nodes.
 *  - Each reference field emits one edge per target in referenceTo[].
 *  - Edges are tagged parent/child/self based on how they relate to the root.
 *  - Fields are filtered per opts before classification; dropped counts are recorded.
 */
export function buildGraph(opts: BuildOptions): DependencyGraph {
  const nodes = new Map<string, NodeAttrs>();
  const edges: Array<{ source: string; target: string } & EdgeAttrs> = [];
  const filters = opts.fieldFilters ?? DEFAULT_FIELD_FILTERS;
  const rowCounts = opts.rowCounts ?? new Map<string, number>();

  const resolveRole = (name: string): NodeRole => {
    if (name === opts.rootObject) return "root";
    if (isStandardRootObject(name)) return "standard-root";
    if (opts.parentObjects.has(name)) return "parent";
    if (opts.childObjects.has(name)) return "child";
    return "parent"; // transitively-referenced node, treat as a parent-ish placeholder
  };

  const addNode = (name: string, described: boolean, label?: string, custom?: boolean) => {
    const existing = nodes.get(name);
    if (existing !== undefined) {
      if (described && !existing.described) {
        nodes.set(name, {
          ...existing,
          described: true,
          label: label ?? existing.label,
          custom: custom ?? existing.custom,
        });
      }
      return;
    }
    nodes.set(name, {
      label: label ?? name,
      custom: custom ?? name.endsWith("__c"),
      isStandardRoot: isStandardRootObject(name),
      described,
      role: resolveRole(name),
      distanceFromRoot: opts.distances.get(name) ?? Number.POSITIVE_INFINITY,
      requiredFields: [],
      sensitiveFields: [],
      droppedFieldCounts: { formula: 0, audit: 0, nonCreateable: 0 },
      totalFieldCount: 0,
      rowCount: rowCounts.get(name) ?? null,
      recordType: name === opts.rootObject ? opts.recordType : undefined,
    });
  };

  addNode(opts.rootObject, opts.describes.has(opts.rootObject));
  for (const [name, describe] of opts.describes) {
    addNode(name, true, describe.label, describe.custom);
  }

  // Annotate described nodes with required-fields / sensitive-fields / drop counts.
  for (const [name, describe] of opts.describes) {
    const node = nodes.get(name);
    if (node === undefined) continue;
    const { kept, dropped } = applyFieldFilters(describe.fields, filters);
    const required = classifyRequiredFields(
      { ...describe, fields: kept },
      { recordType: name === opts.rootObject ? opts.recordType : undefined },
    );
    const sensitive: SensitiveField[] = kept
      .filter(isSensitiveField)
      .map((f) => ({ name: f.name, label: f.label, type: f.type }));

    node.requiredFields = required;
    node.sensitiveFields = sensitive;
    node.droppedFieldCounts = dropped;
    node.totalFieldCount = describe.fields.length;
  }

  // Parent-direction edges: fields on described nodes that reference another object.
  for (const [name, describe] of opts.describes) {
    const { kept } = applyFieldFilters(describe.fields, filters);
    for (const field of kept) {
      if (!isReference(field)) continue;
      if (field.referenceTo.length === 0) continue;

      const polymorphic = field.referenceTo.length > 1;
      const masterDetail = field.cascadeDelete === true;
      for (const target of field.referenceTo) {
        addNode(target, opts.describes.has(target));
        const kind: EdgeKind =
          name === target ? "self" : name === opts.rootObject ? "parent" : "parent";
        edges.push({
          source: name,
          target,
          fieldName: field.name,
          nillable: masterDetail ? false : field.nillable,
          custom: field.custom,
          polymorphic,
          masterDetail,
          kind,
        });
      }
    }
  }

  // Child-direction edges: on the ROOT describe only, surface 1-level children via
  // childRelationships. The child object's own describe (if fetched) will already have
  // contributed its outbound reference edges above.
  const rootDescribe = opts.describes.get(opts.rootObject);
  if (rootDescribe !== undefined) {
    const rawChildren = rootDescribe.childRelationships ?? [];
    const { kept } = filterChildRelationships(rawChildren);
    for (const child of kept) {
      if (!opts.childObjects.has(child.childSObject)) continue;
      addNode(child.childSObject, opts.describes.has(child.childSObject));
      edges.push({
        source: child.childSObject,
        target: opts.rootObject,
        fieldName: child.field,
        nillable: child.cascadeDelete === true ? false : true,
        custom: child.field.endsWith("__c"),
        polymorphic: false,
        masterDetail: child.cascadeDelete === true,
        kind: "child",
      });
    }
  }

  return { nodes, edges };
}

/**
 * Collect the set of referenced parent object names from a describe,
 * respecting the same field filters used by the graph build so we don't walk
 * up through formula/audit/non-createable edges.
 */
export function collectReferencedObjects(
  describe: SObjectDescribe,
  filters: FieldFilterOptions = DEFAULT_FIELD_FILTERS,
): Set<string> {
  const refs = new Set<string>();
  const { kept } = applyFieldFilters(describe.fields, filters);
  for (const field of kept) {
    if (!isReference(field)) continue;
    for (const target of field.referenceTo) {
      refs.add(target);
    }
  }
  return refs;
}

/** Collect 1-level children from childRelationships, dropping read-only system tables. */
export function collectChildObjects(describe: SObjectDescribe): Set<string> {
  const children = new Set<string>();
  const { kept } = filterChildRelationships(describe.childRelationships ?? []);
  for (const c of kept) children.add(c.childSObject);
  return children;
}
