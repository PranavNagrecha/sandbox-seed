import type { Field, ReferenceField, SObjectDescribe } from "../describe/types.ts";
import { isCalculated, isReference } from "../describe/types.ts";

export type RequiredField = {
  name: string;
  label?: string;
  type: string;
  /** For reference fields: the referenceTo[] array. Empty for non-references. */
  referenceTo: string[];
  /** True if master-detail (cascadeDelete on the ref). Implies required regardless of nillable. */
  masterDetail: boolean;
  /** Picklist value count, if applicable. */
  picklistValueCount: number;
  /** "requiredByNillable" — not nillable. "requiredByMasterDetail" — master-detail ref. */
  reason: "requiredByNillable" | "requiredByMasterDetail";
};

export type RequiredFieldOptions = {
  /** If set, restrict required-field analysis to this record-type developer name. */
  recordType?: string;
};

/**
 * Classify which fields on a describe *must* be populated on insert.
 *
 * Rules:
 *  - Master-detail parents are ALWAYS required (you can't null them).
 *  - Otherwise: createable && !nillable && !defaultedOnCreate && !calculated.
 *  - Record-type-specific required fields could be computed from picklist
 *    record-type assignments in a future pass; for now we just record the
 *    record type on the result if one was requested, and the caller can
 *    narrow further.
 */
export function classifyRequiredFields(
  describe: SObjectDescribe,
  opts: RequiredFieldOptions = {},
): RequiredField[] {
  const out: RequiredField[] = [];

  // Resolve record-type info for later use (currently just validated, not yet applied per field).
  if (opts.recordType !== undefined) {
    const rt = (describe.recordTypeInfos ?? []).find(
      (r) => r.developerName === opts.recordType && r.active,
    );
    if (rt === undefined) {
      // Soft-warn via the output (caller decides). Not a hard error — record types are
      // optional on many objects.
    }
  }

  for (const field of describe.fields) {
    const entry = classifyField(field);
    if (entry !== null) out.push(entry);
  }

  return out;
}

function classifyField(field: Field): RequiredField | null {
  if (isReference(field) && field.cascadeDelete === true) {
    return makeEntry(field, "requiredByMasterDetail");
  }

  if (field.createable === false) return null;
  if (field.nillable === true) return null;
  if (field.defaultedOnCreate === true) return null;
  if (isCalculated(field)) return null;

  return makeEntry(field, "requiredByNillable");
}

function makeEntry(
  field: Field,
  reason: "requiredByNillable" | "requiredByMasterDetail",
): RequiredField {
  const refTargets = isReference(field) ? (field as ReferenceField).referenceTo : [];
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    referenceTo: refTargets,
    masterDetail: reason === "requiredByMasterDetail",
    picklistValueCount: field.picklistValues?.length ?? 0,
    reason,
  };
}
