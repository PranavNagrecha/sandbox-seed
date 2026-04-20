import { describe, expect, it } from "vitest";
import { computeLoadOrder } from "../../src/graph/order.ts";
import {
  ACCOUNT,
  ACCOUNT_WITH_CYCLE,
  CASE,
  CONTACT,
  OPPORTUNITY,
} from "../fixtures/describes.ts";
import { buildFromRoot } from "../fixtures/helpers.ts";

describe("computeLoadOrder", () => {
  it("produces parents-before-children order on an acyclic graph", () => {
    const graph = buildFromRoot(
      "Case",
      new Map([
        ["Account", ACCOUNT],
        ["Contact", CONTACT],
        ["Case", CASE],
      ]),
    );
    // Load plan should include every described, non-standard-root object
    const loadable = [...graph.nodes.keys()].filter((n) => {
      const a = graph.nodes.get(n);
      return a !== undefined && a.described && !a.isStandardRoot;
    });
    const plan = computeLoadOrder(graph, { requestedObjects: loadable });
    const order = plan.steps.map((s) => (s.kind === "single" ? s.object : s.objects.join("+")));

    const accountIdx = order.findIndex((o) => o.includes("Account"));
    const contactIdx = order.findIndex((o) => o.includes("Contact"));
    const caseIdx = order.findIndex((o) => o.includes("Case"));

    expect(accountIdx).toBeGreaterThanOrEqual(0);
    expect(contactIdx).toBeGreaterThan(accountIdx);
    expect(caseIdx).toBeGreaterThan(accountIdx);
    expect(caseIdx).toBeGreaterThan(contactIdx);
  });

  it("excludes User (standard root) from the load plan", () => {
    const graph = buildFromRoot(
      "Opportunity",
      new Map([
        ["Opportunity", OPPORTUNITY],
        ["Account", ACCOUNT],
        ["Contact", CONTACT],
      ]),
    );
    const loadable = [...graph.nodes.keys()].filter((n) => {
      const a = graph.nodes.get(n);
      return a !== undefined && a.described && !a.isStandardRoot;
    });
    const plan = computeLoadOrder(graph, { requestedObjects: loadable });
    expect(plan.excluded).toContain("User");
    const inLoad = plan.steps.flatMap((s) => (s.kind === "single" ? [s.object] : s.objects));
    expect(inLoad).not.toContain("User");
  });

  it("emits a cycle step when an SCC contains loadable objects", () => {
    const graph = buildFromRoot(
      "Contact",
      new Map([
        ["Account", ACCOUNT_WITH_CYCLE],
        ["Contact", CONTACT],
      ]),
    );
    const loadable = [...graph.nodes.keys()].filter((n) => {
      const a = graph.nodes.get(n);
      return a !== undefined && a.described && !a.isStandardRoot;
    });
    const plan = computeLoadOrder(graph, { requestedObjects: loadable });
    const cycleStep = plan.steps.find((s) => s.kind === "cycle");
    expect(cycleStep).toBeDefined();
    if (cycleStep?.kind === "cycle") {
      expect(new Set(cycleStep.objects)).toEqual(new Set(["Account", "Contact"]));
      expect(cycleStep.breakEdge).not.toBeNull();
    }
  });

  it("puts referenced-only nodes (Account, User) into excluded when root-only plan", () => {
    const graph = buildFromRoot("Contact", new Map([["Contact", CONTACT]]));
    const plan = computeLoadOrder(graph, { requestedObjects: ["Contact"] });
    const inLoad = plan.steps.flatMap((s) => (s.kind === "single" ? [s.object] : s.objects));
    expect(inLoad).toEqual(["Contact"]);
    expect(plan.excluded).toContain("Account");
    expect(plan.excluded).toContain("User");
  });
});
