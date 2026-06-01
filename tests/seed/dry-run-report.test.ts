import { describe, expect, it } from "vitest";
import { _renderReport } from "../../src/seed/dry-run.ts";

/**
 * T9: the dry-run report's "Masking" section — the safety control that lets a
 * human review the masking plan at the mandatory gate (G1 showed auto-detection
 * under-flags, so this review is how missed PII gets caught before any write).
 *
 * `_renderReport` is the report renderer, exported for unit testing alongside
 * the existing `_chunkIds` / `_soqlIdList` test-only exports.
 */

type RenderArgs = Parameters<typeof _renderReport>[0];

function baseArgs(over: Partial<RenderArgs> = {}): RenderArgs {
  return {
    rootObject: "Contact",
    whereClause: "Id != null",
    rootIds: ["003x00000000001"],
    finalObjectList: ["Contact", "Account"],
    perObjectCounts: { Contact: 2, Account: 1 },
    perObjectSoql: { Contact: "SELECT Id FROM Contact", Account: "SELECT Id FROM Account" },
    perObjectKind: { Contact: "root", Account: "parent" },
    schemaIssues: [],
    upsertDecisions: {},
    completedAt: "2026-05-31T00:00:00.000Z",
    sourceAlias: "src",
    targetAlias: "tgt",
    planHash: "abc123",
    defaultedOwnerRefByObject: {},
    totalDefaultedOwnerRefs: 0,
    ...over,
  };
}

describe("dry-run report — Masking section (T9)", () => {
  it("omits the Masking section when masking is off", () => {
    expect(_renderReport(baseArgs())).not.toContain("## Masking");
  });

  it("renders masked field names per object with a review warning", () => {
    const md = _renderReport(baseArgs({ maskedFieldsByObject: { Contact: ["Email", "Phone"] } }));
    expect(md).toContain("## Masking");
    expect(md).toContain("`Email`");
    expect(md).toContain("`Phone`");
    // The safety nudge — auto-detection misses PII; review and add.
    expect(md).toMatch(/Review carefully/i);
  });

  it("omits the section when the masking map is empty", () => {
    expect(_renderReport(baseArgs({ maskedFieldsByObject: {} }))).not.toContain("## Masking");
  });
});
