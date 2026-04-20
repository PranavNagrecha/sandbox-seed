import { describe, expect, it } from "vitest";
import { stronglyConnectedComponents } from "../../src/graph/cycles.ts";
import { ACCOUNT, ACCOUNT_WITH_CYCLE, CONTACT, OPPORTUNITY } from "../fixtures/describes.ts";
import { buildFromRoot } from "../fixtures/helpers.ts";

describe("stronglyConnectedComponents", () => {
  it("finds no cycles in an acyclic graph", () => {
    const graph = buildFromRoot(
      "Opportunity",
      new Map([
        ["Opportunity", OPPORTUNITY],
        ["Contact", CONTACT],
      ]),
    );
    const sccs = stronglyConnectedComponents(graph);
    expect(sccs).toHaveLength(0);
  });

  it("detects a self-loop as a single-node SCC", () => {
    const graph = buildFromRoot("Account", new Map([["Account", ACCOUNT]]));
    const sccs = stronglyConnectedComponents(graph);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].nodes).toEqual(["Account"]);
    expect(sccs[0].breakEdge).toEqual({
      source: "Account",
      target: "Account",
      fieldName: "ParentId",
    });
  });

  it("detects a two-node cycle (Account ↔ Contact) and proposes a nillable break edge", () => {
    const graph = buildFromRoot(
      "Contact",
      new Map([
        ["Account", ACCOUNT_WITH_CYCLE],
        ["Contact", CONTACT],
      ]),
    );
    const sccs = stronglyConnectedComponents(graph);
    const twoNode = sccs.find((s) => s.nodes.length === 2);
    expect(twoNode).toBeDefined();
    expect(new Set(twoNode!.nodes)).toEqual(new Set(["Account", "Contact"]));
    expect(twoNode!.breakEdge).not.toBeNull();
    expect(twoNode!.breakEdge!.fieldName).toMatch(/PrimaryContact__c|AccountId/);
  });

  it("prefers a non-self break edge over a self-edge", () => {
    const graph = buildFromRoot(
      "Contact",
      new Map([
        ["Account", ACCOUNT_WITH_CYCLE],
        ["Contact", CONTACT],
      ]),
    );
    const sccs = stronglyConnectedComponents(graph);
    const twoNode = sccs.find((s) => s.nodes.length === 2)!;
    expect(twoNode.breakEdge!.source).not.toBe(twoNode.breakEdge!.target);
  });

  it("is deterministic on large graphs (no stack overflow on deep chains)", () => {
    const describes = new Map();
    for (let i = 0; i < 500; i++) {
      const next = i + 1 < 500 ? `A${i + 1}` : null;
      describes.set(`A${i}`, {
        name: `A${i}`,
        label: `A${i}`,
        custom: true,
        queryable: true,
        createable: true,
        fields: [
          { name: "Id", type: "id", nillable: false, custom: false, createable: false },
          ...(next !== null
            ? [
                {
                  name: "NextId__c",
                  type: "reference",
                  referenceTo: [next],
                  relationshipName: null,
                  nillable: true,
                  custom: true,
                  createable: true,
                },
              ]
            : []),
        ],
      });
    }
    const graph = buildFromRoot("A0", describes);
    const sccs = stronglyConnectedComponents(graph);
    expect(sccs).toHaveLength(0);
  });
});
