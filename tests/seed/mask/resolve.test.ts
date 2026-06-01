import { describe, expect, it } from "vitest";
import type { DependencyGraph, NodeAttrs, SensitiveField } from "../../../src/graph/build.ts";
import { maskedFieldNames, resolveMaskSelection } from "../../../src/seed/mask/resolve.ts";
import type { MaskSelection, MaskStrategy } from "../../../src/seed/mask/types.ts";

function node(sensitive: SensitiveField[]): NodeAttrs {
  return {
    label: "X",
    custom: false,
    isStandardRoot: false,
    described: true,
    role: "root",
    distanceFromRoot: 0,
    requiredFields: [],
    sensitiveFields: sensitive,
    droppedFieldCounts: { formula: 0, audit: 0, nonCreateable: 0 },
    totalFieldCount: sensitive.length,
    rowCount: null,
  } as NodeAttrs;
}
function graph(nodes: Record<string, SensitiveField[]>): DependencyGraph {
  return {
    nodes: new Map(Object.entries(nodes).map(([o, s]) => [o, node(s)])),
    edges: [],
  };
}
const sf = (name: string, type = "string"): SensitiveField => ({ name, type });

describe("resolveMaskSelection — T8 simple defaults + overrides", () => {
  it("defaults to the detector's sensitiveFields (strategy auto)", () => {
    const sel = resolveMaskSelection(
      graph({ Contact: [sf("Email", "email"), sf("Phone", "phone")] }),
    );
    expect(sel.get("Contact")?.get("Email")).toBe("auto");
    expect(sel.get("Contact")?.get("Phone")).toBe("auto");
  });

  it("user can ADD a field the detector missed (the G1 under-flag case)", () => {
    const sel = resolveMaskSelection(graph({ Contact: [sf("Email")] }), {
      Contact: ["FirstName"],
    });
    expect(sel.get("Contact")?.get("FirstName")).toBe("auto");
    expect(sel.get("Contact")?.get("Email")).toBe("auto");
  });

  it("user can PIN a strategy, overriding auto", () => {
    const sel = resolveMaskSelection(graph({ Contact: [sf("Email", "email")] }), {
      Contact: [{ field: "Email", strategy: "email" }],
    });
    expect(sel.get("Contact")?.get("Email")).toBe("email");
  });

  it("user can OPT OUT a default with copy", () => {
    const sel = resolveMaskSelection(graph({ Contact: [sf("Email"), sf("Phone")] }), {
      Contact: [{ field: "Email", strategy: "copy" }],
    });
    expect(sel.get("Contact")?.has("Email")).toBe(false);
    expect(sel.get("Contact")?.get("Phone")).toBe("auto");
  });

  it("user can mask fields on an object with NO detected sensitives (e.g. a traa_ object)", () => {
    const sel = resolveMaskSelection(graph({ traa_Employment_History__c: [] }), {
      traa_Employment_History__c: ["Employer__c", "Supervisor_Name__c"],
    });
    expect(sel.get("traa_Employment_History__c")?.get("Employer__c")).toBe("auto");
    expect(sel.get("traa_Employment_History__c")?.get("Supervisor_Name__c")).toBe("auto");
  });

  it("an object with every default opted out is dropped entirely", () => {
    const sel = resolveMaskSelection(graph({ Contact: [sf("Email")] }), {
      Contact: [{ field: "Email", strategy: "copy" }],
    });
    expect(sel.has("Contact")).toBe(false);
  });

  it("no sensitives and no overrides → empty selection", () => {
    expect(resolveMaskSelection(graph({ Account: [] })).size).toBe(0);
  });
});

describe("maskedFieldNames — T9 report/response projection", () => {
  it("flattens a selection to sorted field names per object", () => {
    const sel = resolveMaskSelection(
      graph({ Contact: [sf("Phone", "phone"), sf("Email", "email")] }),
    );
    expect(maskedFieldNames(sel)).toEqual({ Contact: ["Email", "Phone"] });
  });

  it("omits objects that have no fields", () => {
    const sel: MaskSelection = new Map([
      ["Contact", new Map<string, MaskStrategy>()],
      ["Account", new Map<string, MaskStrategy>([["Phone", "auto"]])],
    ]);
    expect(maskedFieldNames(sel)).toEqual({ Account: ["Phone"] });
  });
});
