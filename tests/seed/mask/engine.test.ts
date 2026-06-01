import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveSeed } from "../../../src/seed/mask/engine.ts";

const SALT = "test-salt-0123456789";

describe("deriveSeed — keyed determinism", () => {
  it("is deterministic for identical inputs", () => {
    const a = deriveSeed(SALT, "jane@acme.com");
    const b = deriveSeed(SALT, "jane@acme.com");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });

  it("changes with the salt (keyed — not a plain hash)", () => {
    // invariant #10: without the salt the mapping is not reproducible.
    const a = deriveSeed("salt-A", "jane@acme.com");
    const b = deriveSeed("salt-B", "jane@acme.com");
    expect(a).not.toBe(b);
  });

  it("changes with the value", () => {
    expect(deriveSeed(SALT, "a@x.com")).not.toBe(deriveSeed(SALT, "b@x.com"));
  });

  it("does NOT depend on object/field — keyed by value only (invariant #2)", () => {
    // The whole point: the same value seeds identically regardless of where it
    // appears, so a value reused across objects/fields masks the same.
    const fromContact = deriveSeed(SALT, "shared@x.com");
    const fromCase = deriveSeed(SALT, "shared@x.com");
    expect(fromContact).toBe(fromCase);
  });

  it("property: stable across repeated calls for any value", () => {
    fc.assert(
      fc.property(fc.string(), (v) => {
        // Two independent calls — determinism means they must agree.
        const first = deriveSeed(SALT, v);
        const second = deriveSeed(SALT, v);
        return first === second;
      }),
    );
  });
});
