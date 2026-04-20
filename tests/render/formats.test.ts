import { describe, expect, it } from "vitest";
import type { SObjectDescribe } from "../../src/describe/types.ts";
import { stronglyConnectedComponents } from "../../src/graph/cycles.ts";
import { computeLoadOrder } from "../../src/graph/order.ts";
import { renderDot } from "../../src/render/dot.ts";
import { renderJson } from "../../src/render/json.ts";
import { renderMermaid } from "../../src/render/mermaid.ts";
import { ACCOUNT, ACCOUNT_WITH_CYCLE, CASE, CONTACT, OPPORTUNITY } from "../fixtures/describes.ts";
import { buildFromRoot, walkedNeighbors } from "../fixtures/helpers.ts";

function makeInput(root: string, describes: Map<string, SObjectDescribe>) {
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
  };
}

const FULL = new Map<string, SObjectDescribe>([
  ["Account", ACCOUNT],
  ["Contact", CONTACT],
  ["Opportunity", OPPORTUNITY],
  ["Case", CASE],
]);

describe("renderMermaid", () => {
  it("produces a valid-looking flowchart", () => {
    const out = renderMermaid(makeInput("Case", FULL));
    expect(out.startsWith("flowchart LR")).toBe(true);
    expect(out).toMatch(/Account\[/);
    expect(out).toMatch(/AccountId/);
  });

  it("highlights the root node with a style rule", () => {
    const out = renderMermaid(makeInput("Case", FULL));
    expect(out).toMatch(/style Case fill:#def/);
  });

  it("highlights cycle nodes with style", () => {
    const out = renderMermaid(
      makeInput(
        "Contact",
        new Map([
          ["Account", ACCOUNT_WITH_CYCLE],
          ["Contact", CONTACT],
        ]),
      ),
    );
    expect(out).toMatch(/style.*fill:#fee/);
  });
});

describe("renderDot", () => {
  it("produces graphviz digraph syntax", () => {
    const out = renderDot(makeInput("Contact", FULL));
    expect(out.startsWith("digraph dependencies {")).toBe(true);
    expect(out).toMatch(/"Contact" -> "Account"/);
    expect(out.trimEnd().endsWith("}")).toBe(true);
  });

  it("highlights the root node fill", () => {
    const out = renderDot(makeInput("Case", FULL));
    expect(out).toMatch(/"Case".*fillcolor="#def"/);
  });
});

describe("renderJson", () => {
  it("has a stable schema", () => {
    const out = renderJson(makeInput("Case", FULL));
    const parsed = JSON.parse(out);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.rootObject).toBe("Case");
    expect(parsed.meta.orgId).toBe("00D000000000000AAA");
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
    expect(Array.isArray(parsed.cycles)).toBe(true);
    expect(parsed.loadPlan.steps).toBeDefined();
  });

  it("includes requiredFields and sensitiveFields on nodes", () => {
    const out = renderJson(makeInput("Contact", new Map([["Contact", CONTACT]])));
    const parsed = JSON.parse(out);
    const contact = parsed.nodes.find((n: { name: string }) => n.name === "Contact");
    expect(contact.requiredFields.length).toBeGreaterThan(0);
    expect(contact.sensitiveFields.length).toBeGreaterThan(0);
  });

  it("includes the cycle and break edge in the output", () => {
    const out = renderJson(
      makeInput(
        "Contact",
        new Map([
          ["Account", ACCOUNT_WITH_CYCLE],
          ["Contact", CONTACT],
        ]),
      ),
    );
    const parsed = JSON.parse(out);
    const multiCycle = parsed.cycles.find((c: { nodes: string[] }) => c.nodes.length === 2);
    expect(multiCycle).toBeDefined();
    expect(multiCycle.breakEdge).not.toBeNull();
  });

  it("parity: nodes across mermaid/dot/json include the same core set", () => {
    const input = makeInput("Case", FULL);
    const json = JSON.parse(renderJson(input));
    const expectedNodes = new Set<string>(json.nodes.map((n: { name: string }) => n.name));
    const mer = renderMermaid(input);
    const dot = renderDot(input);
    for (const n of expectedNodes) {
      expect(mer).toContain(n);
      expect(dot).toContain(n);
    }
  });
});
