import type { Field } from "../../describe/types.ts";

/**
 * Sentinel returned by a Masker when it cannot safely produce a masked value.
 * Fail-closed: the caller MUST treat this like an unresolved required FK —
 * skip the row and log it — never fall back to emitting the clear value.
 * (phases/masking-spec.md §3.5)
 */
export const OMIT_ROW: unique symbol = Symbol("sandbox-seed:OMIT_ROW");

/** A masked scalar, a preserved null/empty, or the fail-closed sentinel. */
export type MaskResult = string | null | typeof OMIT_ROW;

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
