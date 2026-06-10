import { describe, expect, it, vi } from "vitest";
import {
  type SeedFlowDeps,
  parseChildLookups,
  parseMaskFields,
  parseObjectList,
  parseUpsertKeys,
  runResumeFlow,
  runSeedFlow,
} from "../../src/cli/seed-flow.ts";
import { UserError } from "../../src/errors.ts";
import type { SeedArgsT, SeedResponse } from "../../src/mcp/tools/seed.ts";

/**
 * The CLI flow must drive the SAME engine actions in the same order the
 * MCP flow uses, with the same gates: select only after analyze, run only
 * after dry_run, run only with confirm:true, and never run when the user
 * declines. The engine itself is mocked — its own gates are covered by
 * tests/mcp/ and tests/seed/.
 */

function makeSeedFn(overrides: Partial<Record<string, Record<string, unknown>>> = {}) {
  const calls: SeedArgsT[] = [];
  const seedFn = vi.fn(async (args: SeedArgsT): Promise<SeedResponse> => {
    calls.push(args);
    const summaries: Record<string, Record<string, unknown>> = {
      start: { matchedCount: 42, scopeCount: 10, sampleApplied: true, ...overrides.start },
      analyze: {
        mustIncludeParents: ["Account"],
        optionalParents: ["Campaign"],
        optionalChildren: ["CaseComment"],
        cycleCount: 0,
        ...overrides.analyze,
      },
      select: { finalLoadOrder: ["Account", "Case"], ...overrides.select },
      dry_run: {
        totalRecords: 12,
        reportPath: "/tmp/report.md",
        upsertObjectCount: 1,
        insertObjectCount: 1,
        schemaWarningCount: 0,
        ...overrides.dry_run,
      },
      run: {
        totalInserted: 12,
        errorCount: 0,
        logPath: "/tmp/execute.log",
        ...overrides.run,
      },
      recover_validation_rules: { ...overrides.recover_validation_rules },
    };
    return {
      sessionId: "sess-1",
      step: "started",
      action: args.action,
      summary: summaries[args.action] ?? {},
      nextAction: null,
      guidance: "",
    };
  });
  return { seedFn, calls };
}

function makeDeps(seedFn: SeedFlowDeps["seedFn"], confirmResult = true) {
  const logs: string[] = [];
  const confirm = vi.fn(async () => confirmResult);
  const deps: SeedFlowDeps = { seedFn, log: (m) => logs.push(m), confirm };
  return { deps, logs, confirm };
}

const BASE_OPTS = {
  sourceOrg: "src",
  targetOrg: "tgt",
  object: "Case",
  where: "IsClosed = false",
  includeParents: ["Campaign"],
  includeChildren: ["CaseComment"],
  includeManagedPackages: false,
  includeSystemChildren: false,
  disableValidationRules: false,
  isolateIdMap: false,
  mask: false,
  dryRunOnly: false,
};

describe("runSeedFlow", () => {
  it("drives start → analyze → select → dry_run → run in order", async () => {
    const { seedFn, calls } = makeSeedFn();
    const { deps, confirm } = makeDeps(seedFn);

    const result = await runSeedFlow(BASE_OPTS, deps);

    expect(calls.map((c) => c.action)).toEqual(["start", "analyze", "select", "dry_run", "run"]);
    expect(result.outcome).toBe("ran");
    expect(confirm).toHaveBeenCalledOnce();
    // run is gated on confirm:true — exactly what the MCP flow requires.
    const runCall = calls.find((c) => c.action === "run");
    expect(runCall?.confirm).toBe(true);
    expect(runCall?.sessionId).toBe("sess-1");
  });

  it("threads selection + start options through to the engine", async () => {
    const { seedFn, calls } = makeSeedFn();
    const { deps } = makeDeps(seedFn);

    await runSeedFlow(
      {
        ...BASE_OPTS,
        limit: 500,
        sampleSize: 10,
        childLookups: { Contact: ["ReportsToId"] },
        disableValidationRules: true,
        isolateIdMap: true,
        upsertKeyOverrides: { Account: "Ext__c" },
        mask: true,
        maskFields: { Contact: ["Email"] },
      },
      deps,
    );

    const start = calls.find((c) => c.action === "start")!;
    expect(start.sourceOrg).toBe("src");
    expect(start.targetOrg).toBe("tgt");
    expect(start.object).toBe("Case");
    expect(start.whereClause).toBe("IsClosed = false");
    expect(start.limit).toBe(500);
    expect(start.sampleSize).toBe(10);
    expect(start.childLookups).toEqual({ Contact: ["ReportsToId"] });
    expect(start.disableValidationRulesOnRun).toBe(true);
    expect(start.isolateIdMap).toBe(true);
    expect(start.upsertKeyOverrides).toEqual({ Account: "Ext__c" });
    expect(start.mask).toBe(true);
    expect(start.maskFields).toEqual({ Contact: ["Email"] });

    const select = calls.find((c) => c.action === "select")!;
    expect(select.includeOptionalParents).toEqual(["Campaign"]);
    expect(select.includeOptionalChildren).toEqual(["CaseComment"]);
  });

  it("stops after dry_run with --dry-run-only and never confirms or runs", async () => {
    const { seedFn, calls } = makeSeedFn();
    const { deps, confirm, logs } = makeDeps(seedFn);

    const result = await runSeedFlow({ ...BASE_OPTS, dryRunOnly: true }, deps);

    expect(calls.map((c) => c.action)).toEqual(["start", "analyze", "select", "dry_run"]);
    expect(result.outcome).toBe("dry-run-only");
    expect(confirm).not.toHaveBeenCalled();
    // The resume hint must carry the real session id.
    expect(logs.join("\n")).toContain("seed resume sess-1");
  });

  it("does not run when the user declines confirmation", async () => {
    const { seedFn, calls } = makeSeedFn();
    const { deps } = makeDeps(seedFn, false);

    const result = await runSeedFlow(BASE_OPTS, deps);

    expect(calls.map((c) => c.action)).toEqual(["start", "analyze", "select", "dry_run"]);
    expect(result.outcome).toBe("declined");
  });

  it("propagates engine errors (e.g. production-target refusal) unchanged", async () => {
    const seedFn = vi.fn(async (args: SeedArgsT): Promise<SeedResponse> => {
      if (args.action === "start") {
        throw new UserError('Target org "tgt" is not a sandbox.');
      }
      throw new Error("unreachable");
    });
    const { deps } = makeDeps(seedFn);

    await expect(runSeedFlow(BASE_OPTS, deps)).rejects.toThrow("not a sandbox");
  });

  it("surfaces masking and owner-default info from the dry run in the log", async () => {
    const { seedFn } = makeSeedFn({
      dry_run: { maskedFieldCount: 7, defaultedOwnerRefCount: 3 },
    });
    const { deps, logs } = makeDeps(seedFn);

    await runSeedFlow(BASE_OPTS, deps);

    const all = logs.join("\n");
    expect(all).toContain("7 field(s) will mask");
    expect(all).toContain("3 record(s) reference User/Group/Queue");
  });
});

describe("runResumeFlow", () => {
  it("runs the session directly when not refreshing", async () => {
    const { seedFn, calls } = makeSeedFn();
    const { deps } = makeDeps(seedFn);

    const result = await runResumeFlow({ sessionId: "sess-9", refreshDryRun: false }, deps);

    expect(calls.map((c) => c.action)).toEqual(["run"]);
    expect(calls[0]?.sessionId).toBe("sess-9");
    expect(calls[0]?.confirm).toBe(true);
    expect(result.outcome).toBe("ran");
  });

  it("refreshes the dry run first with --refresh-dry-run", async () => {
    const { seedFn, calls } = makeSeedFn();
    const { deps } = makeDeps(seedFn);

    await runResumeFlow({ sessionId: "sess-9", refreshDryRun: true }, deps);

    expect(calls.map((c) => c.action)).toEqual(["dry_run", "run"]);
  });

  it("does not run when declined", async () => {
    const { seedFn, calls } = makeSeedFn();
    const { deps } = makeDeps(seedFn, false);

    const result = await runResumeFlow({ sessionId: "sess-9", refreshDryRun: false }, deps);

    expect(calls.map((c) => c.action)).toEqual([]);
    expect(result.outcome).toBe("declined");
  });
});

describe("flag parsers", () => {
  it("parseChildLookups handles repeats and multi-field lists", () => {
    expect(
      parseChildLookups(["Contact:ReportsToId", "Contact:OtherId", "Task:WhoId,WhatId"]),
    ).toEqual({
      Contact: ["ReportsToId", "OtherId"],
      Task: ["WhoId", "WhatId"],
    });
    expect(parseChildLookups(undefined)).toBeUndefined();
    expect(() => parseChildLookups(["Contact"])).toThrow(UserError);
    expect(() => parseChildLookups([":Field"])).toThrow(UserError);
  });

  it("parseUpsertKeys handles Object=Field", () => {
    expect(parseUpsertKeys(["Account=Ext__c", "Contact=Email"])).toEqual({
      Account: "Ext__c",
      Contact: "Email",
    });
    expect(() => parseUpsertKeys(["Account"])).toThrow(UserError);
    expect(() => parseUpsertKeys(["=Field"])).toThrow(UserError);
  });

  it("parseMaskFields handles bare names, strategies, and copy opt-outs", () => {
    expect(
      parseMaskFields(["Contact.Email", "Contact.SSN__c:generic-text", "Account.Notes__c:copy"]),
    ).toEqual({
      Contact: ["Email", { field: "SSN__c", strategy: "generic-text" }],
      Account: [{ field: "Notes__c", strategy: "copy" }],
    });
    expect(() => parseMaskFields(["NoDotHere"])).toThrow(UserError);
    expect(() => parseMaskFields(["Contact.Email:not-a-strategy"])).toThrow(UserError);
  });

  it("parseObjectList flattens commas and repeats", () => {
    expect(parseObjectList(["Account,Contact", "Opportunity", " , "])).toEqual([
      "Account",
      "Contact",
      "Opportunity",
    ]);
    expect(parseObjectList(undefined)).toEqual([]);
  });
});
