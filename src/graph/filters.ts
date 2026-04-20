import type { ChildRelationship, Field } from "../describe/types.ts";
import { isCalculated } from "../describe/types.ts";

/** Audit fields Salesforce sets automatically on insert — you can't override them. */
const AUDIT_FIELDS = new Set([
  "CreatedById",
  "CreatedDate",
  "LastModifiedById",
  "LastModifiedDate",
  "SystemModstamp",
  "LastActivityDate",
  "LastViewedDate",
  "LastReferencedDate",
]);

/** Suffixes on childRelationships.childSObject that indicate a read-only system object. */
const READONLY_CHILD_SUFFIXES = ["History", "Feed", "Share", "ChangeEvent", "__History"];

export type FieldFilterOptions = {
  includeFormula: boolean;
  includeAudit: boolean;
  includeNonCreateable: boolean;
};

export const DEFAULT_FIELD_FILTERS: FieldFilterOptions = {
  includeFormula: false,
  includeAudit: false,
  includeNonCreateable: false,
};

export type FieldFilterResult = {
  kept: Field[];
  dropped: {
    formula: number;
    audit: number;
    nonCreateable: number;
  };
};

/**
 * Apply default-on field filters. Caller decides which categories to keep via `opts`.
 * Returns both the kept list and per-category drop counts so the renderer can report them.
 */
export function applyFieldFilters(fields: Field[], opts: FieldFilterOptions): FieldFilterResult {
  const kept: Field[] = [];
  let formula = 0;
  let audit = 0;
  let nonCreateable = 0;

  for (const f of fields) {
    if (!opts.includeFormula && isCalculated(f)) {
      formula++;
      continue;
    }
    if (!opts.includeAudit && AUDIT_FIELDS.has(f.name)) {
      audit++;
      continue;
    }
    if (!opts.includeNonCreateable && f.createable === false) {
      nonCreateable++;
      continue;
    }
    kept.push(f);
  }

  return { kept, dropped: { formula, audit, nonCreateable } };
}

/** Heuristic: matches common PII / sensitive field-name patterns. Case-insensitive. */
const SENSITIVE_PATTERN =
  /(?:ssn|social[_ ]?sec|tax[_ ]?id|\bdob\b|birth[_ ]?date|date[_ ]?of[_ ]?birth|passport|license|credit[_ ]?card|\bcard[_ ]?num|account[_ ]?num|routing[_ ]?num|iban\b|\bcvv\b|email|phone|mobile|address|postal|zip|patient|diagnosis|medical)/i;

export function isSensitiveField(field: Field): boolean {
  if (SENSITIVE_PATTERN.test(field.name)) return true;
  if (field.label !== undefined && SENSITIVE_PATTERN.test(field.label)) return true;
  return false;
}

/**
 * Drop child relationships that represent Salesforce system tables (History, Feed, Share).
 * These are never seedable — Salesforce populates them automatically.
 */
export function filterChildRelationships(children: ChildRelationship[]): {
  kept: ChildRelationship[];
  droppedReadOnly: number;
} {
  const kept: ChildRelationship[] = [];
  let droppedReadOnly = 0;
  for (const c of children) {
    if (isReadOnlyChildObject(c.childSObject) || c.restrictedDelete === true) {
      droppedReadOnly++;
      continue;
    }
    kept.push(c);
  }
  return { kept, droppedReadOnly };
}

function isReadOnlyChildObject(name: string): boolean {
  return READONLY_CHILD_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
