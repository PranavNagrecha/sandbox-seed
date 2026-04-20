import { describe, expect, it } from "vitest";
import {
  classifyForSeed,
  isManagedPackageObject,
  isSystemChildObject,
} from "../../src/seed/classify.ts";
import type { DependencyGraph, EdgeAttrs, NodeAttrs } from "../../src/graph/build.ts";

/**
 * classifyForSeed splits the walked graph into:
 *   - mustIncludeParents  (relationship-required: master-detail or !nillable)
 *   - optionalParents     (nillable lookups)
 *   - optionalChildren    (every 1-level child of root)
 *   - standardRoots       (User, RecordType, … — never seeded)
 *
 * These tests exercise the rules on synthetic graphs — no Salesforce
 * describes needed.
 */

type Edge = { source: string; target: string } & EdgeAttrs;

function blankNode(name: string): NodeAttrs {
  return {
    label: name,
    custom: name.endsWith("__c"),
    isStandardRoot: false,
    described: true,
    role: "parent",
    distanceFromRoot: 1,
    requiredFields: [],
    sensitiveFields: [],
    droppedFieldCounts: { formula: 0, audit: 0, nonCreateable: 0 },
    totalFieldCount: 0,
    rowCount: null,
  };
}

function graph(nodeNames: string[], edges: Edge[]): DependencyGraph {
  const nodes = new Map<string, NodeAttrs>();
  for (const n of nodeNames) nodes.set(n, blankNode(n));
  return { nodes, edges };
}

function parentEdge(
  source: string,
  target: string,
  fieldName: string,
  opts: { masterDetail?: boolean; nillable?: boolean } = {},
): Edge {
  return {
    source,
    target,
    fieldName,
    nillable: opts.nillable ?? true,
    custom: false,
    polymorphic: false,
    masterDetail: opts.masterDetail ?? false,
    kind: "parent",
  };
}

describe("classifyForSeed", () => {
  it("puts master-detail parents into mustInclude", () => {
    // Contact has a required FK to Account via master-detail.
    const g = graph(
      ["Contact", "Account"],
      [parentEdge("Contact", "Account", "AccountId", { masterDetail: true, nillable: false })],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Contact",
      parentObjects: new Set(["Account"]),
      childObjects: new Set(),
    });
    expect(r.mustIncludeParents).toEqual(["Account"]);
    expect(r.optionalParents).toEqual([]);
  });

  it("puts non-nillable lookups into mustInclude", () => {
    const g = graph(
      ["Opportunity", "Account"],
      [parentEdge("Opportunity", "Account", "AccountId", { nillable: false })],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Opportunity",
      parentObjects: new Set(["Account"]),
      childObjects: new Set(),
    });
    expect(r.mustIncludeParents).toEqual(["Account"]);
    expect(r.optionalParents).toEqual([]);
  });

  it("puts nillable lookups into optionalParents", () => {
    const g = graph(
      ["Opportunity", "Campaign"],
      [parentEdge("Opportunity", "Campaign", "CampaignId", { nillable: true })],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Opportunity",
      parentObjects: new Set(["Campaign"]),
      childObjects: new Set(),
    });
    expect(r.mustIncludeParents).toEqual([]);
    expect(r.optionalParents).toEqual(["Campaign"]);
  });

  it("excludes standard-root objects (User) from every bucket", () => {
    const g = graph(
      ["Account", "User"],
      [parentEdge("Account", "User", "OwnerId", { nillable: false })],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Account",
      parentObjects: new Set(["User"]),
      childObjects: new Set(),
    });
    expect(r.mustIncludeParents).toEqual([]);
    expect(r.optionalParents).toEqual([]);
    expect(r.standardRoots).toEqual(["User"]);
  });

  it("transitively closes mustInclude through required chains", () => {
    // Opportunity --(required)--> Account --(required)--> ParentAccount
    // ParentAccount must also be mustInclude.
    const g = graph(
      ["Opportunity", "Account", "ParentAccount"],
      [
        parentEdge("Opportunity", "Account", "AccountId", { nillable: false }),
        parentEdge("Account", "ParentAccount", "ParentId", {
          masterDetail: true,
          nillable: false,
        }),
      ],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Opportunity",
      parentObjects: new Set(["Account", "ParentAccount"]),
      childObjects: new Set(),
    });
    expect(r.mustIncludeParents.sort()).toEqual(["Account", "ParentAccount"]);
    expect(r.optionalParents).toEqual([]);
  });

  it("does not transitively close through optional edges", () => {
    // Opportunity --(optional)--> Campaign --(required)--> CampaignType
    // Campaign is optional; the chain below it is only considered if the
    // user picks Campaign in `select`. `classifyForSeed` itself leaves
    // CampaignType out.
    const g = graph(
      ["Opportunity", "Campaign", "CampaignType"],
      [
        parentEdge("Opportunity", "Campaign", "CampaignId", { nillable: true }),
        parentEdge("Campaign", "CampaignType", "TypeId", { nillable: false }),
      ],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Opportunity",
      parentObjects: new Set(["Campaign", "CampaignType"]),
      childObjects: new Set(),
    });
    expect(r.mustIncludeParents).toEqual([]);
    // CampaignType is walked but we don't infer its necessity unless the
    // user accepts Campaign in select.
    expect(r.optionalParents.sort()).toEqual(["Campaign", "CampaignType"]);
  });

  it("puts children in optionalChildren and never in mustInclude", () => {
    const g = graph(
      ["Opportunity", "OpportunityLineItem"],
      // Child-direction edge: kind "child". Required-ness on children doesn't
      // trigger mustInclude (children are never required for the parent to insert).
      [
        {
          source: "OpportunityLineItem",
          target: "Opportunity",
          fieldName: "OpportunityId",
          nillable: false,
          custom: false,
          polymorphic: false,
          masterDetail: true,
          kind: "child",
        },
      ],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Opportunity",
      parentObjects: new Set(),
      childObjects: new Set(["OpportunityLineItem"]),
    });
    expect(r.mustIncludeParents).toEqual([]);
    expect(r.optionalChildren).toEqual(["OpportunityLineItem"]);
  });

  it("de-duplicates children that are also required parents", () => {
    // Pathological case: object appears in both parentObjects and
    // childObjects. If it's mustInclude via a parent edge, it should NOT
    // be double-listed in optionalChildren.
    const g = graph(
      ["A", "B"],
      [parentEdge("A", "B", "BId", { nillable: false })],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "A",
      parentObjects: new Set(["B"]),
      childObjects: new Set(["B"]),
    });
    expect(r.mustIncludeParents).toEqual(["B"]);
    expect(r.optionalChildren).toEqual([]);
  });

  it("never includes the root in any bucket", () => {
    const g = graph(
      ["Account", "Other"],
      [parentEdge("Account", "Other", "OtherId", { nillable: false })],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Account",
      // Self-references via parent walk can end up with root in the set.
      parentObjects: new Set(["Account", "Other"]),
      childObjects: new Set(["Account"]),
    });
    expect(r.mustIncludeParents).not.toContain("Account");
    expect(r.optionalParents).not.toContain("Account");
    expect(r.optionalChildren).not.toContain("Account");
  });

  it("hides managed-package parents by default, reveals them with includeManagedPackages:true", () => {
    const g = graph(
      ["Opportunity", "Campaign", "APXTConga4__Contract__c", "hed__Department__c"],
      [
        parentEdge("Opportunity", "Campaign", "CampaignId", { nillable: true }),
        parentEdge("Opportunity", "APXTConga4__Contract__c", "APXTConga4__ContractId__c", { nillable: true }),
        parentEdge("Opportunity", "hed__Department__c", "hed__DepartmentId__c", { nillable: true }),
      ],
    );
    const hidden = classifyForSeed({
      graph: g,
      rootObject: "Opportunity",
      parentObjects: new Set(["Campaign", "APXTConga4__Contract__c", "hed__Department__c"]),
      childObjects: new Set(),
    });
    expect(hidden.optionalParents).toEqual(["Campaign"]);
    expect(hidden.hiddenManagedParentCount).toBe(2);
    expect(hidden.hiddenManagedParentNames).toBeUndefined();

    const shown = classifyForSeed({
      graph: g,
      rootObject: "Opportunity",
      parentObjects: new Set(["Campaign", "APXTConga4__Contract__c", "hed__Department__c"]),
      childObjects: new Set(),
      includeManagedPackages: true,
    });
    expect(shown.optionalParents.sort()).toEqual([
      "APXTConga4__Contract__c",
      "Campaign",
      "hed__Department__c",
    ]);
    expect(shown.hiddenManagedParentCount).toBe(0);
  });

  it("hides system-automation children by default", () => {
    const g = graph(
      ["Case", "CaseComment", "FeedComment", "CaseHistory", "AgentWork", "ProcessInstance"],
      [],
    );
    const hidden = classifyForSeed({
      graph: g,
      rootObject: "Case",
      parentObjects: new Set(),
      childObjects: new Set([
        "CaseComment",
        "FeedComment",
        "CaseHistory",
        "AgentWork",
        "ProcessInstance",
      ]),
    });
    expect(hidden.optionalChildren).toEqual(["CaseComment"]);
    expect(hidden.hiddenSystemChildCount).toBe(4);

    const shown = classifyForSeed({
      graph: g,
      rootObject: "Case",
      parentObjects: new Set(),
      childObjects: new Set([
        "CaseComment",
        "FeedComment",
        "CaseHistory",
        "AgentWork",
        "ProcessInstance",
      ]),
      includeSystemChildren: true,
    });
    expect(shown.optionalChildren.sort()).toEqual([
      "AgentWork",
      "CaseComment",
      "CaseHistory",
      "FeedComment",
      "ProcessInstance",
    ]);
    expect(shown.hiddenSystemChildCount).toBe(0);
  });

  it("still includes managed-package objects in mustIncludeParents (required FK wins)", () => {
    // A required FK to a managed-package object cannot be hidden — the
    // root can't insert without it. Noise filtering applies only to
    // optional parents/children.
    const g = graph(
      ["Opportunity", "hed__Program__c"],
      [parentEdge("Opportunity", "hed__Program__c", "hed__ProgramId__c", { nillable: false })],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "Opportunity",
      parentObjects: new Set(["hed__Program__c"]),
      childObjects: new Set(),
    });
    expect(r.mustIncludeParents).toEqual(["hed__Program__c"]);
    expect(r.hiddenManagedParentCount).toBe(0);
  });

  it("isManagedPackageObject detects the <ns>__<name>[__c] pattern", () => {
    expect(isManagedPackageObject("Account")).toBe(false);
    expect(isManagedPackageObject("MyCustom__c")).toBe(false);
    expect(isManagedPackageObject("APXTConga4__Contract__c")).toBe(true);
    expect(isManagedPackageObject("hed__Department__c")).toBe(true);
    expect(isManagedPackageObject("APXTConga4__Contract")).toBe(true); // standard-looking but namespaced
  });

  it("isSystemChildObject recognizes common automation noise", () => {
    expect(isSystemChildObject("CaseComment")).toBe(false);
    expect(isSystemChildObject("FeedComment")).toBe(true);
    expect(isSystemChildObject("AccountFeed")).toBe(true);
    expect(isSystemChildObject("CaseHistory")).toBe(true);
    expect(isSystemChildObject("AccountChangeEvent")).toBe(true);
    expect(isSystemChildObject("ProcessInstance")).toBe(true);
    expect(isSystemChildObject("FlowRecordRelation")).toBe(true);
    expect(isSystemChildObject("EntitySubscription")).toBe(true);
    expect(isSystemChildObject("AccountShare")).toBe(true);
  });

  it("returns sorted arrays for stable agent output", () => {
    const g = graph(
      ["R", "B", "A", "C"],
      [
        parentEdge("R", "B", "BId", { nillable: true }),
        parentEdge("R", "A", "AId", { nillable: true }),
        parentEdge("R", "C", "CId", { nillable: true }),
      ],
    );
    const r = classifyForSeed({
      graph: g,
      rootObject: "R",
      parentObjects: new Set(["A", "B", "C"]),
      childObjects: new Set(),
    });
    expect(r.optionalParents).toEqual(["A", "B", "C"]);
  });
});
