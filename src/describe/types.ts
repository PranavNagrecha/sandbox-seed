/**
 * Minimal describe types — we don't need jsforce's entire type surface.
 * These shapes match what the Salesforce REST describe endpoints return,
 * and are what our graph builder consumes.
 *
 * Intentionally a *subset* of the real Salesforce response. Extend here
 * when a new field is needed downstream, not speculatively.
 */

export type PicklistValue = {
  value: string;
  label?: string;
  active: boolean;
  defaultValue?: boolean;
};

export type BaseFieldShape = {
  name: string;
  label?: string;
  nillable: boolean;
  custom: boolean;
  /** True iff the field is an excel-like computed formula (Salesforce sets these, we can't insert). */
  calculated?: boolean;
  /** True iff Salesforce will assign a default server-side on insert (e.g. CreatedDate). */
  defaultedOnCreate?: boolean;
  /** Can this field be set on insert? false = read-only / system-managed. */
  createable?: boolean;
  /** Usually mirrors createable but explicitly separate in describe. */
  updateable?: boolean;
  /** Byte length for text-ish fields. */
  length?: number;
  picklistValues?: PicklistValue[];
  /**
   * Upsert-identity flags — used to decide whether this field can be the
   * external-id key for upsert. Captured from Salesforce's describe; not
   * derived locally. Absent = false (treat-as-missing).
   *
   *   externalId  — field has "External ID" attribute set in setup.
   *   unique      — Salesforce enforces a unique constraint on values.
   *   idLookup    — Salesforce's own "this field can appear in the URL of an
   *                 upsert call" flag. True for Id + all externalId fields +
   *                 a small set of standard fields (User.Username, etc.).
   *   autoNumber  — Salesforce auto-generates the value (CaseNumber). MUST
   *                 be excluded from upsert-key candidates — values are
   *                 per-org, so "matching" records would be pure luck.
   */
  externalId?: boolean;
  unique?: boolean;
  idLookup?: boolean;
  autoNumber?: boolean;
};

export type ReferenceField = BaseFieldShape & {
  type: "reference";
  referenceTo: string[];
  relationshipName: string | null;
  /** True for master-detail; false for plain lookup. Derived from describe's cascadeDelete. */
  cascadeDelete?: boolean;
};

export type OtherField = BaseFieldShape & {
  type: Exclude<string, "reference">;
};

export type Field = ReferenceField | OtherField;

export type ChildRelationship = {
  /** The child sObject's API name — the one whose field references us. */
  childSObject: string;
  /** FK field on the child pointing back to this object. */
  field: string;
  /** Relationship name (e.g. "Cases", "Contacts"). Null when the child uses a system relationship. */
  relationshipName: string | null;
  /** True iff the child gets deleted when the parent is deleted (master-detail). */
  cascadeDelete?: boolean;
  /** True iff the child is a read-only system object (History, Feed, Share, etc.). */
  restrictedDelete?: boolean;
};

export type RecordTypeInfo = {
  /** Record-type developer name (what you pass to --record-type). */
  developerName: string;
  name: string;
  recordTypeId?: string;
  active: boolean;
  master: boolean;
  available?: boolean;
};

export type SObjectDescribe = {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  fields: Field[];
  /** Child relationships — what objects point *back* at us. One-level child walk consumes these. */
  childRelationships?: ChildRelationship[];
  /** Record types (if any). Used by --record-type scoping. */
  recordTypeInfos?: RecordTypeInfo[];
  /** Echoed from Salesforce describe response; present on real describes, optional here for fixture ease. */
  urls?: Record<string, string>;
};

export type GlobalDescribeEntry = {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
};

export type GlobalDescribe = {
  sobjects: GlobalDescribeEntry[];
};

export function isReference(field: Field): field is ReferenceField {
  return field.type === "reference";
}

/** True iff the field is computed by Salesforce (formula / auto-number / rollup). */
export function isCalculated(field: Field): boolean {
  return field.calculated === true || field.type === "autonumber" || field.type === "calculated";
}
