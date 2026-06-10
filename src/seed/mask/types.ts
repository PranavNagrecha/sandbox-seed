import type { Field } from "../../describe/types.ts";

/**
 * Sentinel returned by a Masker when it cannot safely produce a masked value.
 * Fail-closed: the caller MUST treat this like an unresolved required FK —
 * skip the row and log it — never fall back to emitting the clear value.
 * (phases/masking-spec.md §3.5)
 */
export const OMIT_ROW: unique symbol = Symbol("sandbox-seed:OMIT_ROW");

/**
 * What a masker hands back for one field: a masked string, a value copied
 * through unchanged (types/values v1 can't safely text-mask), a preserved
 * null, or the fail-closed sentinel.
 */
export type MaskResult = string | number | boolean | null | typeof OMIT_ROW;

/**
 * Salesforce field types v1 masking can safely transform — free text only.
 * Other types (boolean, date/datetime, number/currency, picklist, reference,
 * id, …) are copied through unchanged: a text preset would produce an invalid
 * value (bad picklist, non-date, …) and fail the insert. Number/date presets
 * are a documented fast-follow. `encryptedstring` (e.g. SSN) IS maskable — the
 * value is string-shaped and the target re-encrypts on insert.
 */
export const MASKABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "string",
  "textarea",
  "email",
  "phone",
  "url",
  "encryptedstring",
]);

/**
 * How to mask a selected field. `auto` defers to `pickStrategy` (type/name
 * heuristic). Opt-out ("copy") is modelled as *absence* from the selection —
 * a field the user chose to copy is simply not in the map.
 */
export type MaskStrategy =
  | "email"
  | "phone"
  | "person-name"
  | "street-address"
  | "postal-code"
  | "generic-text"
  | "auto";

export type MaskContext = {
  object: string;
  field: Field;
  value: unknown;
};

/**
 * object → fieldName → strategy. Fields absent from the map are never masked.
 * The resolver (later task) builds this from `sensitiveFields` defaults plus
 * the user's `start`-time overrides.
 */
export type MaskSelection = Map<string, Map<string, MaskStrategy>>;

export interface Masker {
  /** Is this (object, field) selected for masking? */
  selects(object: string, fieldName: string): boolean;
  /**
   * Produce the masked value. Precondition: `selects()` is true and the field
   * is NOT a reference (the caller guards both). Pure and synchronous.
   */
  apply(ctx: MaskContext): MaskResult;
}
