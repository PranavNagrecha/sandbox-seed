import type { Field } from "../../describe/types.ts";
import { isReference } from "../../describe/types.ts";
import { deriveSeed } from "./engine.ts";
import {
  emailPreset,
  genericTextPreset,
  personNamePreset,
  phonePreset,
  postalCodePreset,
  streetAddressPreset,
} from "./presets.ts";
import {
  MASKABLE_FIELD_TYPES,
  type MaskContext,
  type MaskResult,
  type MaskSelection,
  type MaskStrategy,
  type Masker,
  OMIT_ROW,
} from "./types.ts";

/** A strategy that maps directly to a preset (everything except "auto"). */
type ConcreteStrategy = Exclude<MaskStrategy, "auto">;

/**
 * Pick a concrete preset for a field from its Salesforce type and name/label.
 * Pure. Consulted only when a field's selection strategy is "auto" (the
 * default the detector hands us); an explicit strategy bypasses it.
 */
export function pickStrategy(field: Field): ConcreteStrategy {
  const t = field.type;
  const n = `${field.name} ${field.label ?? ""}`.toLowerCase();
  // Bare substrings (not \b-bounded): Salesforce field names concatenate words
  // without separators ("MobilePhone", "MailingStreet"), so word boundaries
  // would miss them. Mirrors the existing SENSITIVE_PATTERN in graph/filters.ts.
  // Order matters: email and phone are more specific than the broad name match.
  if (t === "email" || /email/.test(n)) return "email";
  if (t === "phone" || /phone|mobile|fax/.test(n)) return "phone";
  // Postal/zip BEFORE the broader address match: postal fields are short and
  // digit-shaped; a street address overflows + truncates on insert (T14).
  // Bare "zip" (no \b): underscores are word chars, so \bzip\b misses
  // Office_Zip_Code__c-style names.
  if (/postal|zip/.test(n)) return "postal-code";
  if (/street|address|mailing|billing|shipping/.test(n)) return "street-address";
  if (/name|patient/.test(n)) return "person-name";
  return "generic-text";
}

/**
 * Build a Masker over an explicit selection (object → field → strategy).
 * Fields not in the map are never masked.
 *
 * Fail-closed (spec §3.5): anything the masker cannot safely produce a value
 * for returns OMIT_ROW — never the clear value. The caller treats OMIT_ROW
 * like an unresolved required FK (skip + log the row).
 */
export function createMasker(opts: { salt: string; selection: MaskSelection }): Masker {
  const { salt, selection } = opts;
  return {
    selects(object, fieldName) {
      return selection.get(object)?.has(fieldName) ?? false;
    },
    apply({ object, field, value }: MaskContext): MaskResult {
      const strat = selection.get(object)?.get(field.name);
      if (strat === undefined) return OMIT_ROW; // not selected — must not be called
      // NEVER mask a reference field — the id-map owns FK remapping. The caller
      // already guards on isReference; this is defense in depth. (invariant #8)
      if (isReference(field)) return OMIT_ROW;
      // Preserve null/blank — do not fabricate PII into empty fields. (#6)
      if (value === null || value === undefined) return null;
      // v1 text-masks free-text only. Copy through anything it can't safely
      // text-mask — non-maskable field types (boolean, date, number, picklist,
      // …) and non-string values — instead of dropping the row (OMIT) or
      // emitting an invalid value. The default selection already excludes these
      // types; this guards explicit overrides. (T14: real Contacts carry
      // boolean/picklist fields whose NAMES match the PII detector, which used
      // to fail-closed and drop every row.)
      if (!MASKABLE_FIELD_TYPES.has(field.type) || typeof value !== "string") {
        return value as MaskResult;
      }
      if (value === "") return "";

      const resolved: ConcreteStrategy = strat === "auto" ? pickStrategy(field) : strat;
      try {
        const seed = deriveSeed(salt, value);
        switch (resolved) {
          case "email":
            return emailPreset(seed, field);
          case "phone":
            return phonePreset(seed, field);
          case "person-name":
            return personNamePreset(seed, field);
          case "street-address":
            return streetAddressPreset(seed, field);
          case "postal-code":
            return postalCodePreset(seed, field);
          case "generic-text":
            return genericTextPreset(seed, field);
          default:
            return OMIT_ROW; // unknown strategy → fail closed
        }
      } catch {
        // A preset threw — fail closed, never emit the clear value. (#5)
        return OMIT_ROW;
      }
    },
  };
}
