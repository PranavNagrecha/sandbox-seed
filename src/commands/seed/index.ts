import { createInterface } from "node:readline/promises";
import { Command, Flags } from "@oclif/core";
import {
  type ConfirmRequest,
  parseChildLookups,
  parseMaskFields,
  parseObjectList,
  parseUpsertKeys,
  runSeedFlow,
} from "../../cli/seed-flow.ts";
import { ExitCode, SeedError, UserError } from "../../errors.ts";

export default class Seed extends Command {
  static override description =
    "Seed a sandbox from another org: SOQL-scoped root records + their dependency graph, " +
    "with cross-org FK remapping. Same engine and safety gates as the MCP `seed` tool — " +
    "target must be a sandbox, a dry run always precedes the run, and the run only " +
    "executes after explicit confirmation (interactive prompt, or --yes for CI).";

  static override examples = [
    `<%= config.bin %> <%= command.id %> --source-org prod --target-org dev-full --object Case --where "IsClosed = false AND CreatedDate = THIS_YEAR" --sample-size 100`,
    `<%= config.bin %> <%= command.id %> --source-org prod --target-org dev-full --object Account --where "Industry = 'Education'" --include-parents Campaign --include-children Contact,Opportunity`,
    `<%= config.bin %> <%= command.id %> --source-org full --target-org dev-sandbox --object Contact --where "CreatedDate = THIS_MONTH" --mask --dry-run-only`,
    `<%= config.bin %> <%= command.id %> --source-org prod --target-org qa --object Case --where "Id IN ('500…','500…')" --disable-validation-rules --yes`,
  ];

  static override flags = {
    "source-org": Flags.string({
      description: "Source org alias (from `sf org login`).",
      required: true,
    }),
    "target-org": Flags.string({
      description: "Target SANDBOX org alias. Production targets are refused.",
      required: true,
    }),
    object: Flags.string({
      description: "Root sObject API name to seed.",
      required: true,
    }),
    where: Flags.string({
      description: "SOQL WHERE clause (predicate only, no SELECT/LIMIT) scoping the root records.",
      required: true,
    }),
    limit: Flags.integer({
      description: "Safety cap on the root-scope count — refuses if WHERE matches more.",
    }),
    "sample-size": Flags.integer({
      description: "Take the first N matching root records (ORDER BY Id) instead of refusing.",
    }),
    "include-parents": Flags.string({
      description: "Optional parent objects to include (comma-separated, repeatable).",
      multiple: true,
    }),
    "include-children": Flags.string({
      description: "Optional child objects to include (comma-separated, repeatable).",
      multiple: true,
    }),
    "include-managed-packages": Flags.boolean({
      description: "Surface managed-package objects in the optional lists.",
      default: false,
    }),
    "include-system-children": Flags.boolean({
      description: "Surface system-automation children (Feed*, *History, …) in the optional list.",
      default: false,
    }),
    "child-lookup": Flags.string({
      description:
        "Walk lookup fields on a direct child one hop: ChildObject:Field1[,Field2]. Repeatable.",
      multiple: true,
    }),
    "disable-validation-rules": Flags.boolean({
      description:
        "Snapshot + deactivate target-org validation rules on seeded objects around the insert, then restore.",
      default: false,
    }),
    "isolate-id-map": Flags.boolean({
      description:
        "Ignore the persistent project id-map for this run (re-insert, no cross-run stitching).",
      default: false,
    }),
    "upsert-key": Flags.string({
      description: "Force an upsert key: Object=ExternalIdField. Repeatable.",
      multiple: true,
    }),
    mask: Flags.boolean({
      description:
        "Mask detected sensitive fields with deterministic, format-preserving fakes before insert.",
      default: false,
    }),
    "mask-field": Flags.string({
      description:
        "Masking override: Object.Field[:strategy] (strategy: email|phone|person-name|street-address|generic-text|auto|copy). Implies --mask. Repeatable.",
      multiple: true,
    }),
    "dry-run-only": Flags.boolean({
      description: "Stop after the dry run. Execute later with `seed resume <sessionId>`.",
      default: false,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Skip the interactive confirmation (for CI). Ignored with --dry-run-only.",
      default: false,
    }),
  };

  static override enableJsonFlag = true;

  async run(): Promise<unknown> {
    const { flags } = await this.parse(Seed);

    try {
      const maskFields = parseMaskFields(flags["mask-field"]);
      const result = await runSeedFlow(
        {
          sourceOrg: flags["source-org"],
          targetOrg: flags["target-org"],
          object: flags.object,
          where: flags.where,
          limit: flags.limit,
          sampleSize: flags["sample-size"],
          includeParents: parseObjectList(flags["include-parents"]),
          includeChildren: parseObjectList(flags["include-children"]),
          includeManagedPackages: flags["include-managed-packages"],
          includeSystemChildren: flags["include-system-children"],
          childLookups: parseChildLookups(flags["child-lookup"]),
          disableValidationRules: flags["disable-validation-rules"],
          isolateIdMap: flags["isolate-id-map"],
          upsertKeyOverrides: parseUpsertKeys(flags["upsert-key"]),
          mask: flags.mask || maskFields !== undefined,
          maskFields,
          dryRunOnly: flags["dry-run-only"],
        },
        {
          log: (m) => this.log(m),
          confirm: (req) => confirmOnTty(req, flags.yes),
        },
      );
      if (result.outcome === "declined") this.exit(ExitCode.USER);
      return result;
    } catch (err) {
      this.handleSeedError(err);
    }
  }

  private handleSeedError(err: unknown): never {
    if (err instanceof SeedError) {
      this.logToStderr(`Error: ${err.message}`);
      if (err.hint !== undefined) this.logToStderr(`Hint: ${err.hint}`);
      this.exit(err.exitCode);
    }
    throw err;
  }
}

/**
 * Interactive confirmation between dry run and run. Prompts on stderr
 * (stdout stays clean for --json). Without a TTY, --yes is mandatory —
 * a CI pipeline must opt into inserts explicitly.
 */
export async function confirmOnTty(req: ConfirmRequest, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new UserError(
      "Refusing to run without confirmation: no TTY and no --yes.",
      "Pass --yes to confirm the insert non-interactively, or --dry-run-only to stop at the report.",
    );
  }
  const counted = req.totalRecords >= 0 ? `${req.totalRecords} record(s)` : "the dry-run scope";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `Insert ${counted} into sandbox "${req.targetOrg}"? Review ${req.reportPath} first. [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
