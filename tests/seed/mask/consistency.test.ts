import { describe, expect, it } from "vitest";
import type { Field } from "../../../src/describe/types.ts";
import { createMasker } from "../../../src/seed/mask/registry.ts";
import type { MaskSelection, MaskStrategy } from "../../../src/seed/mask/types.ts";

function field(name: string, type = "string", extra: Partial<Field> = {}): Field {
  return { name, type, nillable: true, custom: false, ...extra } as Field;
}
function sel(entries: Array<[string, Array<[string, MaskStrategy]>]>): MaskSelection {
  return new Map(entries.map(([o, fs]) => [o, new Map(fs)]));
}

describe("masking — referential consistency (invariant #2)", () => {
  const salt = "shared-salt";

  it("masks the same value to the same output across repeated calls", () => {
    const m = createMasker({ salt, selection: sel([["Contact", [["Email", "email"]]]]) });
    const f = field("Email", "email");
    const a = m.apply({ object: "Contact", field: f, value: "jane@acme.com" });
    const b = m.apply({ object: "Contact", field: f, value: "jane@acme.com" });
    expect(a).toBe(b);
  });

  it("same value across DIFFERENT objects/fields masks identically — value-joins survive", () => {
    // The FK-preservation property: Contact.Email and Case.SuppliedEmail
    // holding the same address mask to the same fake address, so a value-keyed
    // join between them still matches after masking. Holds because the seed is
    // keyed by value only and both fields resolve to the email preset.
    const m = createMasker({
      salt,
      selection: sel([
        ["Contact", [["Email", "email"]]],
        ["Case", [["SuppliedEmail", "email"]]],
      ]),
    });
    const a = m.apply({ object: "Contact", field: field("Email", "email"), value: "shared@x.com" });
    const b = m.apply({
      object: "Case",
      field: field("SuppliedEmail", "email"),
      value: "shared@x.com",
    });
    expect(a).toBe(b);
  });

  it("a salt change reshuffles every mapping (re-run with a fresh salt is independent)", () => {
    const f = field("Email", "email");
    const m1 = createMasker({ salt: "salt-1", selection: sel([["C", [["Email", "email"]]]]) });
    const m2 = createMasker({ salt: "salt-2", selection: sel([["C", [["Email", "email"]]]]) });
    const a = m1.apply({ object: "C", field: f, value: "z@x.com" });
    const b = m2.apply({ object: "C", field: f, value: "z@x.com" });
    expect(a).not.toBe(b);
  });

  it("different values mask to different outputs", () => {
    const m = createMasker({ salt, selection: sel([["C", [["Email", "email"]]]]) });
    const f = field("Email", "email");
    expect(m.apply({ object: "C", field: f, value: "a@x.com" })).not.toBe(
      m.apply({ object: "C", field: f, value: "b@x.com" }),
    );
  });
});
