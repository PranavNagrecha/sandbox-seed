import { writeFile } from "node:fs/promises";
import { Command, Flags } from "@oclif/core";
import { resolveAuth } from "../auth/sf-auth.ts";
import { ExitCode, SeedError } from "../errors.ts";
import type { FieldFilterOptions } from "../graph/filters.ts";
import { runInspect } from "../inspect/run.ts";
import { renderDot } from "../render/dot.ts";
import { renderJson } from "../render/json.ts";
import { renderMermaid } from "../render/mermaid.ts";
import { renderTree } from "../render/tree.ts";
import type { Renderer } from "../render/types.ts";

export default class Inspect extends Command {
  static override description =
    "Inspect one Salesforce object's dependency neighborhood: transitive parents + 1-level children. Read-only — no SOQL (unless --include-counts), no writes.";

  static override examples = [
    "<%= config.bin %> <%= command.id %> --object Case",
    "<%= config.bin %> <%= command.id %> --object Case --target-org dev-sandbox --format mermaid",
    "<%= config.bin %> <%= command.id %> --object Account --record-type Partner --include-counts",
    "<%= config.bin %> <%= command.id %> --object Opportunity --no-children --parent-depth 3",
  ];

  static override flags = {
    "target-org": Flags.string({
      char: "o",
      description: "Org alias (from `sf org login`). Defaults to `sf` CLI's target-org.",
    }),
    object: Flags.string({
      char: "s",
      description: "Single root sObject API name to focus on (required).",
      required: true,
    }),
    "record-type": Flags.string({
      description: "Record-type developer name; scopes required-field analysis on the root.",
    }),
    "parent-depth": Flags.integer({
      description:
        "Max transitive parent walk depth. Stops at standard root objects regardless. Use 1 for the tightest view.",
      default: 2,
    }),
    children: Flags.boolean({
      description: "Walk 1 level of children from the root via childRelationships.",
      default: true,
      allowNo: true,
    }),
    "include-counts": Flags.boolean({
      description:
        "Run `SELECT COUNT()` per walked object (aggregate metadata only — no record data touched).",
      default: false,
    }),
    "include-formula": Flags.boolean({
      description: "Include formula/calculated/auto-number fields (excluded by default).",
      default: false,
    }),
    "include-audit": Flags.boolean({
      description: "Include audit fields (CreatedById/Date, LastModified, SystemModstamp, …).",
      default: false,
    }),
    "include-non-createable": Flags.boolean({
      description: "Include non-createable fields (read-only / system-managed).",
      default: false,
    }),
    format: Flags.string({
      description: "Output format.",
      options: ["tree", "mermaid", "dot", "json"],
      default: "tree",
    }),
    output: Flags.string({
      char: "f",
      description: "Write to file instead of stdout.",
    }),
    "no-cache": Flags.boolean({
      description: "Bypass describe cache; fetch everything fresh.",
      default: false,
    }),
    "cache-ttl": Flags.integer({
      description: "Describe cache TTL in seconds.",
      default: 86400,
    }),
    "api-version": Flags.string({
      description: "Salesforce API version.",
      default: "60.0",
    }),
    "max-nodes": Flags.integer({
      description: "Maximum nodes to render. 0 = no cap.",
      default: 100,
    }),
    focus: Flags.string({
      description: "Focus rendering on this object and its neighbors (subgraph view).",
    }),
    depth: Flags.integer({
      description: "With --focus: neighborhood depth (default 2).",
      default: 2,
    }),
    verbose: Flags.boolean({
      description: "Verbose logging: cache hits, API calls, timings.",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Inspect);

    const rootObject = flags.object.trim();
    if (rootObject.length === 0) {
      this.error("--object requires a non-empty sObject name", { exit: ExitCode.USER });
    }

    const fieldFilters: FieldFilterOptions = {
      includeFormula: flags["include-formula"],
      includeAudit: flags["include-audit"],
      includeNonCreateable: flags["include-non-createable"],
    };

    try {
      const started = Date.now();
      const auth = await resolveAuth(flags["target-org"], flags["api-version"]);
      if (flags.verbose) this.log(`[auth] resolved org ${auth.orgId} (${auth.username})`);

      const result = await runInspect({
        auth,
        rootObject,
        parentWalkDepth: flags["parent-depth"],
        includeChildren: flags.children,
        recordType: flags["record-type"],
        fieldFilters,
        includeCounts: flags["include-counts"],
        cacheTtlSeconds: flags["cache-ttl"],
        bypassCache: flags["no-cache"],
      });

      const elapsed = Date.now() - started;
      if (flags.verbose) {
        this.log(
          `[inspect] ${result.graph.nodes.size} nodes, ${result.graph.edges.length} edges, ${result.cycles.length} cycles in ${elapsed}ms`,
        );
      }

      const renderer = pickRenderer(flags.format);
      const output = renderer({
        ...result,
        meta: {
          orgId: auth.orgId,
          orgAlias: auth.alias,
          generatedAt: new Date().toISOString(),
          apiVersion: auth.apiVersion,
        },
        maxNodes: flags["max-nodes"] === 0 ? null : flags["max-nodes"],
        focus:
          flags.focus !== undefined
            ? { object: flags.focus, depth: flags.depth }
            : null,
      });

      if (flags.output !== undefined) {
        await writeFile(flags.output, output, "utf8");
        this.log(`Wrote ${output.length} bytes to ${flags.output}`);
      } else {
        this.log(output);
      }
    } catch (err) {
      if (err instanceof SeedError) {
        this.logToStderr(`Error: ${err.message}`);
        if (err.hint !== undefined) this.logToStderr(`Hint: ${err.hint}`);
        this.exit(err.exitCode);
      }
      throw err;
    }
  }
}

function pickRenderer(format: string): Renderer {
  switch (format) {
    case "mermaid":
      return renderMermaid;
    case "dot":
      return renderDot;
    case "json":
      return renderJson;
    default:
      return renderTree;
  }
}
