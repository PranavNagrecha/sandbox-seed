import type { DependencyGraph } from "../graph/build.ts";
import type { SCC } from "../graph/cycles.ts";
import type { LoadPlan } from "../graph/order.ts";

export type RenderInput = {
  graph: DependencyGraph;
  plan: LoadPlan;
  cycles: SCC[];
  /** The single object the user focused on. */
  rootObject: string;
  /** Names walked as parents of the root (described or referenced-only). */
  parentObjects: string[];
  /** Names walked as 1-level children of the root. */
  childObjects: string[];
  meta: {
    orgId: string;
    orgAlias?: string;
    generatedAt: string;
    apiVersion: string;
  };
  /** Max nodes to render; `null` means no cap. */
  maxNodes: number | null;
  /** If set, only render this object + neighbors within depth. */
  focus: { object: string; depth: number } | null;
};

export type Renderer = (input: RenderInput) => string;
