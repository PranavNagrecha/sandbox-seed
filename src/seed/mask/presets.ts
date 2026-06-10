import { faker } from "@faker-js/faker";
import type { Field } from "../../describe/types.ts";

/**
 * Format-preserving mask presets. Each takes the keyed seed from engine.ts and
 * returns a fake-but-plausible value of the right shape, capped to the target
 * field's byte length so the insert cannot be rejected for being too long.
 *
 * Determinism: we re-seed the shared faker instance immediately before every
 * draw. Seeding resets faker's PRNG, so each call is fully deterministic and
 * independent of call order even though faker holds mutable internal state.
 * Presets are synchronous and JS is single-threaded, so nothing can interleave
 * between seed() and the draw within a call. This is the standard faker
 * determinism pattern (faker.seed + a fixed sequence of draws).
 */

function capLen(s: string, field: Field): string {
  const max = typeof field.length === "number" && field.length > 0 ? field.length : undefined;
  return max !== undefined && s.length > max ? s.slice(0, max) : s;
}

export function emailPreset(seed: number, field: Field): string {
  faker.seed(seed);
  // Stable, obviously-fake domain; the local part varies by seed. Lowercased
  // so the same value compares equal across orgs.
  const email = faker.internet.email({ provider: "example.com" }).toLowerCase();
  return capLen(email, field);
}

export function phonePreset(seed: number, field: Field): string {
  faker.seed(seed);
  // Built from raw digits rather than faker.phone.number() so the shape is
  // locale-independent and length-predictable: NNN-NNN-NNNN.
  const d = faker.string.numeric(10);
  return capLen(`${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`, field);
}

export function personNamePreset(seed: number, field: Field): string {
  faker.seed(seed);
  return capLen(faker.person.fullName(), field);
}

export function streetAddressPreset(seed: number, field: Field): string {
  faker.seed(seed);
  return capLen(faker.location.streetAddress(), field);
}

export function postalCodePreset(seed: number, field: Field): string {
  faker.seed(seed);
  // 5-digit US-style zip: postal fields are often short (5–10 chars) and
  // validated as digit-only; a street address here overflows and truncates
  // on insert (found by the T14 real-org gate on Postal_Code__c).
  return capLen(faker.string.numeric({ length: 5, allowLeadingZeros: false }), field);
}

export function genericTextPreset(seed: number, field: Field): string {
  faker.seed(seed);
  return capLen(faker.lorem.words(2), field);
}
