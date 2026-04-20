import { describe, expect, it } from "vitest";
import { collectReferencedObjects } from "../../src/graph/build.ts";
import { ACCOUNT, CASE, CASE_COMMENT, CONTACT, OPPORTUNITY, TASK } from "../fixtures/describes.ts";
import { buildFromRoot } from "../fixtures/helpers.ts";

describe("buildGraph", () => {
  it("creates a node for the root and for every described parent", () => {
    const { nodes } = buildFromRoot(
      "Contact",
      new Map([
        ["Contact", CONTACT],
        ["Account", ACCOUNT],
      ]),
    );
    expect(nodes.has("Contact")).toBe(true);
    expect(nodes.has("Account")).toBe(true);
    expect(nodes.get("Contact")?.role).toBe("root");
    expect(nodes.get("Account")?.role).toBe("parent");
  });

  it("creates referenced-only nodes for unreachable parents", () => {
    const { nodes } = buildFromRoot("Contact", new Map([["Contact", CONTACT]]));
    const account = nodes.get("Account");
    const user = nodes.get("User");
    expect(account?.described).toBe(false);
    expect(user?.described).toBe(false);
  });

  it("marks standard root objects (User)", () => {
    const { nodes } = buildFromRoot("Contact", new Map([["Contact", CONTACT]]));
    expect(nodes.get("User")?.isStandardRoot).toBe(true);
    expect(nodes.get("Account")?.isStandardRoot).toBe(false);
  });

  it("emits one edge per (field × referenceTo target)", () => {
    const { edges } = buildFromRoot("Task", new Map([["Task", TASK]]));
    const whatEdges = edges.filter((e) => e.fieldName === "WhatId");
    expect(whatEdges).toHaveLength(3);
    expect(new Set(whatEdges.map((e) => e.target))).toEqual(
      new Set(["Account", "Opportunity", "Case"]),
    );
    for (const e of whatEdges) expect(e.polymorphic).toBe(true);

    const whoEdges = edges.filter((e) => e.fieldName === "WhoId");
    expect(whoEdges).toHaveLength(2);
    for (const e of whoEdges) expect(e.polymorphic).toBe(true);

    const ownerEdges = edges.filter((e) => e.fieldName === "OwnerId");
    expect(ownerEdges).toHaveLength(1);
    expect(ownerEdges[0].polymorphic).toBe(false);
  });

  it("preserves self-reference edges", () => {
    const { edges } = buildFromRoot("Account", new Map([["Account", ACCOUNT]]));
    const self = edges.find((e) => e.source === "Account" && e.target === "Account");
    expect(self).toBeDefined();
    expect(self?.fieldName).toBe("ParentId");
    expect(self?.nillable).toBe(true);
  });

  it("captures nillable metadata on edges", () => {
    const { edges } = buildFromRoot("Opportunity", new Map([["Opportunity", OPPORTUNITY]]));
    const accountEdge = edges.find((e) => e.fieldName === "AccountId");
    const ownerEdge = edges.find((e) => e.fieldName === "OwnerId");
    expect(accountEdge?.nillable).toBe(true);
    expect(ownerEdge?.nillable).toBe(false);
  });

  it("drops formula/audit fields by default", () => {
    const { nodes } = buildFromRoot("Account", new Map([["Account", ACCOUNT]]));
    const acct = nodes.get("Account");
    expect(acct?.droppedFieldCounts.formula).toBeGreaterThanOrEqual(1);
    expect(acct?.droppedFieldCounts.audit).toBeGreaterThanOrEqual(1);
    // FormulaField__c must not appear as required
    const names = acct?.requiredFields.map((r) => r.name) ?? [];
    expect(names).not.toContain("FormulaField__c");
  });

  it("classifies master-detail edges as non-nillable and marks masterDetail=true", () => {
    const graph = buildFromRoot(
      "CaseComment",
      new Map([
        ["CaseComment", CASE_COMMENT],
        ["Case", CASE],
      ]),
    );
    const mdEdge = graph.edges.find(
      (e) => e.source === "CaseComment" && e.fieldName === "ParentId",
    );
    expect(mdEdge?.masterDetail).toBe(true);
    expect(mdEdge?.nillable).toBe(false);
  });

  it("walks 1-level children via childRelationships", () => {
    const graph = buildFromRoot(
      "Contact",
      new Map([
        ["Contact", CONTACT],
        ["Case", CASE],
      ]),
    );
    const caseNode = graph.nodes.get("Case");
    expect(caseNode?.role).toBe("child");
    const childEdge = graph.edges.find(
      (e) => e.source === "Case" && e.target === "Contact" && e.kind === "child",
    );
    expect(childEdge).toBeDefined();
  });

  it("flags sensitive-looking fields on Contact (Email, Phone)", () => {
    const { nodes } = buildFromRoot("Contact", new Map([["Contact", CONTACT]]));
    const names = new Set(nodes.get("Contact")?.sensitiveFields.map((s) => s.name) ?? []);
    expect(names.has("Email")).toBe(true);
    expect(names.has("Phone")).toBe(true);
  });

  it("computes row counts when provided", () => {
    const { nodes } = buildFromRoot(
      "Account",
      new Map([["Account", ACCOUNT]]),
      { rowCounts: new Map([["Account", 1234]]) },
    );
    expect(nodes.get("Account")?.rowCount).toBe(1234);
  });
});

describe("collectReferencedObjects", () => {
  it("returns all referenceTo targets, deduped", () => {
    const refs = collectReferencedObjects(TASK);
    expect(refs).toEqual(new Set(["Account", "Opportunity", "Case", "Contact", "Lead", "User"]));
  });

  it("returns empty for objects with no reference fields", () => {
    const noRefs = collectReferencedObjects({
      name: "X",
      label: "X",
      custom: true,
      queryable: true,
      createable: true,
      fields: [{ name: "Name", type: "string", nillable: false, custom: false, createable: true }],
    });
    expect(noRefs.size).toBe(0);
  });
});
