import { createHmac } from "node:crypto";

/**
 * Keyed, deterministic 32-bit seed derived from (salt, value).
 *
 * HMAC-SHA256 makes value → seed a *keyed* pseudo-random function: without the
 * salt the mapping is not derivable, so low-entropy PII (SSN, phone, DOB live
 * in tiny value domains) cannot be brute-forced back out of a leaked masked
 * value the way an unsalted hash could be rainbow-tabled. (spec §3, §8)
 *
 * Keyed by the VALUE ONLY — deliberately NOT by object/field. That is the
 * property that makes masking referentially consistent: the same source value
 * masks to the same output *everywhere it appears* — `Contact.Email` and
 * `Case.SuppliedEmail`, or an external-id reused across runs — so value-keyed
 * joins and UPSERT matching survive masking. The preset (email vs phone vs …)
 * is chosen per field; the seed itself is a pure function of the value.
 * (spec invariants #2, #7. This refines the spec §4.3 sketch, which keyed by
 * object.field and would have broken the cross-object join case.)
 */
export function deriveSeed(salt: string, value: string): number {
  return createHmac("sha256", salt).update(value).digest().readUInt32BE(0);
}
