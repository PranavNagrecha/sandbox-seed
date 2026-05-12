import { describe, expect, it } from "vitest";
import { _composeScopeSoqls } from "../../src/seed/execute.ts";
import { ROOT_ID_CHUNK, type ScopePath } from "../../src/seed/extract.ts";

/**
 * Locks in the fix for issue #1 (414 URI Too Long on `run` with large
 * sampleSize).
 *
 * The bug: `composeScopeSoql` used to splat the full rootIds set into a
 * single `IN (...)` clause. With ~200+ rootIds the resulting GET /query
 * URL exceeded Salesforce's ~16 KB URI cap.
 *
 * The fix: chunk rootIds into `ROOT_ID_CHUNK` (200) per query and let the
 * caller union the per-chunk record sets.
 *
 * These tests verify the composition layer; the executor's union-then-dedup
 * loop is covered by the broader execute tests.
 */

function ids(count: number, prefix = "00Q"): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${prefix}${String(i).padStart(15, "0")}`);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const ix = haystack.indexOf(needle, from);
    if (ix === -1) return n;
    n++;
    from = ix + needle.length;
  }
}

describe("composeScopeSoqls — root scope", () => {
  it("emits a single query carrying the user WHERE clause verbatim", () => {
    const scope: ScopePath = { object: "Account", kind: "root" };
    const soqls = _composeScopeSoqls({
      scope,
      object: "Account",
      fields: ["Id", "Name"],
      rootObject: "Account",
      whereClause: "Industry = 'Education'",
      rootIds: [],
    });
    expect(soqls).toEqual(["SELECT Id, Name FROM Account WHERE Industry = 'Education'"]);
  });
});

describe("composeScopeSoqls — direct-parent", () => {
  const scope: ScopePath = {
    object: "Account",
    kind: "direct-parent",
    rootFk: "AccountId",
  };

  it("returns [] when rootIds is empty", () => {
    expect(
      _composeScopeSoqls({
        scope,
        object: "Account",
        fields: ["Id", "Name"],
        rootObject: "Contact",
        whereClause: "",
        rootIds: [],
      }),
    ).toEqual([]);
  });

  it("returns one query when rootIds fits in a single chunk", () => {
    const rootIds = ids(50);
    const soqls = _composeScopeSoqls({
      scope,
      object: "Account",
      fields: ["Id", "Name"],
      rootObject: "Contact",
      whereClause: "",
      rootIds,
    });
    expect(soqls).toHaveLength(1);
    expect(soqls[0]).toContain("SELECT Id, Name FROM Account");
    expect(soqls[0]).toContain("SELECT AccountId FROM Contact WHERE Id IN (");
    // Every rootId appears in the one query.
    for (const id of rootIds) {
      expect(soqls[0]).toContain(`'${id}'`);
    }
  });

  it("splits rootIds into chunks of ROOT_ID_CHUNK when oversized", () => {
    const rootIds = ids(ROOT_ID_CHUNK * 2 + 37); // 437 IDs → 3 chunks
    const soqls = _composeScopeSoqls({
      scope,
      object: "Account",
      fields: ["Id", "Name"],
      rootObject: "Contact",
      whereClause: "",
      rootIds,
    });
    expect(soqls).toHaveLength(3);
    // Across all chunks, every rootId appears exactly once.
    const combined = soqls.join("\n");
    for (const id of rootIds) {
      expect(countOccurrences(combined, `'${id}'`)).toBe(1);
    }
    // Each emitted query is structurally a `SELECT ... WHERE Id IN (SELECT ...)`.
    for (const s of soqls) {
      expect(s).toMatch(
        /^SELECT Id, Name FROM Account WHERE Id IN \(SELECT AccountId FROM Contact WHERE Id IN \(.+\)\)$/,
      );
    }
  });
});

describe("composeScopeSoqls — direct-child", () => {
  const scope: ScopePath = {
    object: "Contact",
    kind: "direct-child",
    childFk: "AccountId",
  };

  it("returns [] when rootIds is empty", () => {
    expect(
      _composeScopeSoqls({
        scope,
        object: "Contact",
        fields: ["Id", "Name"],
        rootObject: "Account",
        whereClause: "",
        rootIds: [],
      }),
    ).toEqual([]);
  });

  it("chunks the IN list at sampleSize=500 (the bug-report case)", () => {
    const rootIds = ids(500);
    const soqls = _composeScopeSoqls({
      scope,
      object: "Contact",
      fields: ["Id", "Name"],
      rootObject: "Account",
      whereClause: "",
      rootIds,
    });
    // 500 / 200 = 3 chunks (200, 200, 100).
    expect(soqls).toHaveLength(3);
    for (const s of soqls) {
      // The longest URL in any chunk should stay under the conservative
      // 12 KB threshold even with full URL encoding overhead (~1.5x).
      const urlEstimate = encodeURIComponent(s).length;
      expect(urlEstimate).toBeLessThan(12_000);
    }
  });

  it("falls back to subquery form (no IDs in URL) above 2000 rootIds", () => {
    const rootIds = ids(2500);
    const soqls = _composeScopeSoqls({
      scope,
      object: "Contact",
      fields: ["Id", "Name"],
      rootObject: "Account",
      whereClause: "Industry = 'Education'",
      rootIds,
    });
    expect(soqls).toHaveLength(1);
    expect(soqls[0]).toBe(
      "SELECT Id, Name FROM Contact " +
        "WHERE AccountId IN (SELECT Id FROM Account WHERE Industry = 'Education')",
    );
    // No materialized IDs leak into the URL.
    expect(soqls[0]).not.toContain("'00Q");
  });

  it("forces chunked IN-list (not subquery) when sampleApplied=true, even above 2000 IDs", () => {
    // The subquery shortcut would re-evaluate `WHERE whereClause` server
    // -side and pull in records beyond the sampled subset. With sample
    // applied at start we must instead embed the literal sampled IDs.
    const rootIds = ids(2500);
    const soqls = _composeScopeSoqls({
      scope,
      object: "Contact",
      fields: ["Id", "Name"],
      rootObject: "Account",
      whereClause: "Industry = 'Education'",
      rootIds,
      sampleApplied: true,
    });
    // 2500 / 200 = 13 chunks.
    expect(soqls).toHaveLength(13);
    for (const s of soqls) {
      // Each chunk uses the literal IN list, never the subquery form.
      expect(s).not.toContain("SELECT Id FROM Account WHERE");
      expect(s).toMatch(/^SELECT Id, Name FROM Contact WHERE AccountId IN \('00Q[^)]+\)$/);
    }
    // Union of chunks covers all rootIds exactly once.
    const combined = soqls.join("\n");
    for (const id of rootIds) {
      expect(countOccurrences(combined, `'${id}'`)).toBe(1);
    }
  });
});

describe("composeScopeSoqls — child-lookup", () => {
  const scope: ScopePath = {
    object: "Account",
    kind: "child-lookup",
    childObject: "hed__Application__c",
    lookupField: "hed__Applying_To__c",
    childFkToRoot: "Contact__c",
  };

  it("chunks rootIds and preserves the nested semi-join shape", () => {
    const rootIds = ids(450);
    const soqls = _composeScopeSoqls({
      scope,
      object: "Account",
      fields: ["Id", "Name"],
      rootObject: "Contact",
      whereClause: "",
      rootIds,
    });
    expect(soqls).toHaveLength(3); // 200, 200, 50
    for (const s of soqls) {
      expect(s).toMatch(
        /^SELECT Id, Name FROM Account WHERE Id IN \(SELECT hed__Applying_To__c FROM hed__Application__c WHERE Contact__c IN \(.+\)\)$/,
      );
    }
    // Union of chunks covers all rootIds exactly once.
    const combined = soqls.join("\n");
    for (const id of rootIds) {
      expect(countOccurrences(combined, `'${id}'`)).toBe(1);
    }
  });
});

describe("composeScopeSoqls — unresolvable paths return []", () => {
  it("missing rootFk on direct-parent", () => {
    const scope: ScopePath = { object: "Account", kind: "direct-parent" };
    expect(
      _composeScopeSoqls({
        scope,
        object: "Account",
        fields: ["Id"],
        rootObject: "Contact",
        whereClause: "",
        rootIds: ids(10),
      }),
    ).toEqual([]);
  });

  it("missing childObject on child-lookup", () => {
    const scope: ScopePath = {
      object: "Account",
      kind: "child-lookup",
      lookupField: "hed__Applying_To__c",
      childFkToRoot: "Contact__c",
    };
    expect(
      _composeScopeSoqls({
        scope,
        object: "Account",
        fields: ["Id"],
        rootObject: "Contact",
        whereClause: "",
        rootIds: ids(10),
      }),
    ).toEqual([]);
  });

  it("unknown path kind", () => {
    const scope: ScopePath = { object: "Account", kind: "unknown" };
    expect(
      _composeScopeSoqls({
        scope,
        object: "Account",
        fields: ["Id"],
        rootObject: "Contact",
        whereClause: "",
        rootIds: ids(10),
      }),
    ).toEqual([]);
  });
});
