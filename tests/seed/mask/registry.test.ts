import { describe, expect, it } from "vitest";
import type { Field } from "../../../src/describe/types.ts";
import { createMasker, pickStrategy } from "../../../src/seed/mask/registry.ts";
import { type MaskSelection, type MaskStrategy, OMIT_ROW } from "../../../src/seed/mask/types.ts";

function field(name: string, type = "string", extra: Partial<Field> = {}): Field {
  return { name, type, nillable: true, custom: false, ...extra } as Field;
}
function refField(name: string, referenceTo: string[]): Field {
  return {
    name,
    type: "reference",
    referenceTo,
    relationshipName: null,
    nillable: true,
    custom: false,
  } as Field;
}
function sel(entries: Array<[string, Array<[string, MaskStrategy]>]>): MaskSelection {
  return new Map(entries.map(([o, fs]) => [o, new Map(fs)]));
}

describe("pickStrategy", () => {
  it("maps types and names to presets", () => {
    expect(pickStrategy(field("Email", "email"))).toBe("email");
    expect(pickStrategy(field("HomePhone", "phone"))).toBe("phone");
    expect(pickStrategy(field("MobilePhone__c", "string"))).toBe("phone");
    expect(pickStrategy(field("PersonEmail", "string"))).toBe("email");
    expect(pickStrategy(field("MailingStreet", "textarea"))).toBe("street-address");
    expect(pickStrategy(field("FirstName", "string"))).toBe("person-name");
    expect(pickStrategy(field("Description", "textarea"))).toBe("generic-text");
  });
});

describe("createMasker — selection & fail-closed", () => {
  const salt = "s";

  it("selects only configured fields", () => {
    const m = createMasker({ salt, selection: sel([["Contact", [["Email", "email"]]]]) });
    expect(m.selects("Contact", "Email")).toBe(true);
    expect(m.selects("Contact", "LastName")).toBe(false);
    expect(m.selects("Lead", "Email")).toBe(false);
  });

  it("masks a selected email field and changes the value", () => {
    const m = createMasker({ salt, selection: sel([["Contact", [["Email", "email"]]]]) });
    const out = m.apply({
      object: "Contact",
      field: field("Email", "email"),
      value: "jane@acme.com",
    });
    expect(out).toMatch(/@/);
    expect(out).not.toBe("jane@acme.com");
  });

  it("auto strategy resolves via pickStrategy", () => {
    const m = createMasker({ salt, selection: sel([["Contact", [["HomePhone", "auto"]]]]) });
    const out = m.apply({ object: "Contact", field: field("HomePhone", "phone"), value: "555" });
    expect(out).toMatch(/^\d{3}-\d{3}-\d{4}$/);
  });

  it("NEVER masks a reference field, even if selected (invariant #8, defensive)", () => {
    const m = createMasker({ salt, selection: sel([["Contact", [["AccountId", "auto"]]]]) });
    const out = m.apply({
      object: "Contact",
      field: refField("AccountId", ["Account"]),
      value: "001x000000000001",
    });
    expect(out).toBe(OMIT_ROW);
  });

  it("preserves null and empty string — no fabrication into empties (invariant #6)", () => {
    const m = createMasker({ salt, selection: sel([["C", [["E", "email"]]]]) });
    expect(m.apply({ object: "C", field: field("E", "email"), value: null })).toBeNull();
    expect(m.apply({ object: "C", field: field("E", "email"), value: "" })).toBe("");
  });

  it("fails closed on a non-string value (invariant #5)", () => {
    const m = createMasker({ salt, selection: sel([["C", [["N", "generic-text"]]]]) });
    expect(m.apply({ object: "C", field: field("N", "double"), value: 42 })).toBe(OMIT_ROW);
  });

  it("fails closed on an unselected field", () => {
    const m = createMasker({ salt, selection: sel([["C", [["E", "email"]]]]) });
    expect(m.apply({ object: "C", field: field("Other"), value: "x" })).toBe(OMIT_ROW);
  });
});
