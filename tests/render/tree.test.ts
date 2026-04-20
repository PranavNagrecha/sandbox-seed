import { describe, expect, it } from "vitest";
import type { SObjectDescribe } from "../../src/describe/types.ts";
import { stronglyConnectedComponents } from "../../src/graph/cycles.ts";
import { computeLoadOrder } from "../../src/graph/order.ts";
import { renderTree } from "../../src/render/tree.ts";
import {
  ACCOUNT,
  ACCOUNT_WITH_CYCLE,
  CASE,
  CASE_COMMENT,
  CONTACT,
  TASK,
} from "../fixtures/describes.ts";
import { buildFromRoot, walkedNeighbors } from "../fixtures/helpers.ts";

function makeInput(
  root: string,
  describes: Map<string, SObjectDescribe>,
  overrides: Partial<Parameters<typeof renderTree>[0]> = {},
) {
  const graph = buildFromRoot(root, describes);
  const { parents, children } = walkedNeighbors(root, describes);
  const loadable = [...graph.nodes.keys()].filter((n) => {
    const a = graph.nodes.get(n);
    return a !== undefined && a.described && !a.isStandardRoot;
  });
  const plan = computeLoadOrder(graph, { requestedObjects: loadable });
  const cycles = stronglyConnectedComponents(graph);
  return {
    graph,
    cycles,
    plan,
    rootObject: root,
    parentObjects: parents,
    childObjects: children,
    meta: {
      orgId: "00D000000000000AAA",
      orgAlias: "test-org",
      generatedAt: "2026-04-19T00:00:00.000Z",
      apiVersion: "60.0",
    },
    maxNodes: 100,
    focus: null,
    ...overrides,
  };
}

describe("renderTree", () => {
  it("opens with a Focus header naming the root", () => {
    const out = renderTree(makeInput("Contact", new Map([["Contact", CONTACT]])));
    expect(out).toMatch(/^Focus: Contact/);
    expect(out).toMatch(/Load order/);
  });

  it("lists parents with their distance from the root", () => {
    const out = renderTree(
      makeInput(
        "Case",
        new Map([
          ["Case", CASE],
          ["Account", ACCOUNT],
          ["Contact", CONTACT],
        ]),
      ),
    );
    expect(out).toMatch(/Parents/);
    expect(out).toMatch(/Account/);
    expect(out).toMatch(/Contact/);
  });

  it("lists children walked 1 level down (filtered read-only suffixes)", () => {
    const out = renderTree(
      makeInput(
        "Case",
        new Map([
          ["Case", CASE],
          ["CaseComment", CASE_COMMENT],
        ]),
      ),
    );
    expect(out).toMatch(/Children \(1 level down from Case\)/);
    expect(out).toMatch(/CaseComment/);
    expect(out).not.toMatch(/CaseHistory/);
  });

  it("marks master-detail edges with [master-detail]", () => {
    const out = renderTree(
      makeInput(
        "CaseComment",
        new Map([
          ["CaseComment", CASE_COMMENT],
          ["Case", CASE],
        ]),
      ),
    );
    expect(out).toMatch(/master-detail/);
  });

  it("marks standard root nodes", () => {
    const out = renderTree(makeInput("Contact", new Map([["Contact", CONTACT]])));
    expect(out).toMatch(/User.*standard-root/);
  });

  it("renders polymorphic parents for Task", () => {
    const out = renderTree(makeInput("Task", new Map([["Task", TASK]])));
    expect(out).toMatch(/polymorphic/);
  });

  it("reports cycles when present", () => {
    const out = renderTree(
      makeInput(
        "Contact",
        new Map([
          ["Account", ACCOUNT_WITH_CYCLE],
          ["Contact", CONTACT],
        ]),
      ),
    );
    expect(out).toMatch(/Cycles \(/);
    expect(out).toMatch(/SCC-/);
    expect(out).toMatch(/Strategy: two-phase insert/);
  });

  it("surfaces sensitive fields on the root under their own heading", () => {
    const out = renderTree(makeInput("Contact", new Map([["Contact", CONTACT]])));
    expect(out).toMatch(/Sensitive-looking fields/);
    expect(out).toMatch(/! Email/);
    expect(out).toMatch(/! Phone/);
  });

  it("surfaces required fields on the root", () => {
    const out = renderTree(makeInput("Contact", new Map([["Contact", CONTACT]])));
    expect(out).toMatch(/Required fields on Contact/);
    expect(out).toMatch(/LastName/);
    expect(out).toMatch(/OwnerId/);
  });
});
