import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Field } from "../../../src/describe/types.ts";
import {
  emailPreset,
  genericTextPreset,
  personNamePreset,
  phonePreset,
  postalCodePreset,
  streetAddressPreset,
} from "../../../src/seed/mask/presets.ts";

function field(name: string, type = "string", extra: Partial<Field> = {}): Field {
  return { name, type, nillable: true, custom: false, ...extra } as Field;
}

describe("mask presets — format & length preservation (invariant #3)", () => {
  it("email is email-shaped and length-capped", () => {
    const e = emailPreset(123, field("Email", "email", { length: 80 }));
    expect(e).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    expect(e.length).toBeLessThanOrEqual(80);
  });

  it("email respects a tiny length cap", () => {
    expect(emailPreset(123, field("Email", "email", { length: 6 })).length).toBeLessThanOrEqual(6);
  });

  it("phone is NNN-NNN-NNNN shaped", () => {
    expect(phonePreset(7, field("Phone", "phone"))).toMatch(/^\d{3}-\d{3}-\d{4}$/);
  });

  it("person name is non-empty and capped", () => {
    const n = personNamePreset(7, field("Name", "string", { length: 40 }));
    expect(n.length).toBeGreaterThan(0);
    expect(n.length).toBeLessThanOrEqual(40);
  });

  it("street address is non-empty and capped", () => {
    const a = streetAddressPreset(7, field("Street", "textarea", { length: 30 }));
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(30);
  });

  it("postal code is 5 digits and fits short postal fields", () => {
    // Street addresses overflowed 9-char postal fields and truncated on
    // insert — found by the T14 real-org gate on Postal_Code__c.
    const z = postalCodePreset(7, field("Postal_Code__c", "string", { length: 9 }));
    expect(z).toMatch(/^\d{5}$/);
    expect(
      postalCodePreset(7, field("Zip__c", "string", { length: 3 })).length,
    ).toBeLessThanOrEqual(3);
  });

  it("postal code is deterministic for a given seed", () => {
    expect(postalCodePreset(99, field("Zip__c"))).toBe(postalCodePreset(99, field("Zip__c")));
    expect(postalCodePreset(99, field("Zip__c"))).not.toBe(postalCodePreset(100, field("Zip__c")));
  });

  it("generic text respects a tiny length", () => {
    expect(
      genericTextPreset(7, field("Note__c", "string", { length: 4 })).length,
    ).toBeLessThanOrEqual(4);
  });

  it("presets are deterministic for a given seed", () => {
    expect(emailPreset(42, field("Email"))).toBe(emailPreset(42, field("Email")));
    expect(phonePreset(42, field("Phone"))).toBe(phonePreset(42, field("Phone")));
    expect(personNamePreset(42, field("Name"))).toBe(personNamePreset(42, field("Name")));
  });

  it("property: email always contains @ and respects length for any seed", () => {
    const f = field("Email", "email", { length: 80 });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const e = emailPreset(seed, f);
        return e.includes("@") && e.length <= 80;
      }),
    );
  });
});
