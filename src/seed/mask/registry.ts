import type { Field } from "../../describe/types.ts";
import { isReference } from "../../describe/types.ts";
import { deriveSeed } from "./engine.ts";
import {
  emailPreset,
  genericTextPreset,
  personNamePreset,
  phonePreset,
  streetAddressPreset,
} from "./presets.ts";
import {
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
  if (/street|address|mailing|billing|shipping|postal|\bzip\b/.test(n)) return "street-address";
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
      if (typeof value !== "string") return OMIT_ROW; // non-text → fail closed
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
