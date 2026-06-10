import { Args, Command, Flags } from "@oclif/core";
import { runResumeFlow } from "../../cli/seed-flow.ts";
import { ExitCode, SeedError } from "../../errors.ts";
import { confirmOnTty } from "./index.ts";

export default class SeedResume extends Command {
  static override description =
    "Execute a session that already has a dry run (e.g. one created with `seed --dry-run-only`). " +
    "The engine enforces dry-run freshness and the plan hash — if the plan drifted since the " +
    "report you reviewed, the run refuses and tells you to refresh.";

  static override examples = [
    "<%= config.bin %> <%= command.id %> 8f2c1a-…",
    "<%= config.bin %> <%= command.id %> 8f2c1a-… --refresh-dry-run",
    "<%= config.bin %> <%= command.id %> 8f2c1a-… --yes",
  ];

  static override args = {
    sessionId: Args.string({
      description:
        "Session id printed by `seed` (also the directory name under ~/.sandbox-seed/sessions/).",
      required: true,
    }),
  };

  static override flags = {
    "refresh-dry-run": Flags.boolean({
      description:
        "Re-run the dry run first (required when the previous one expired or the plan drifted).",
      default: false,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Skip the interactive confirmation (for CI).",
      default: false,
    }),
  };

  static override enableJsonFlag = true;

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SeedResume);
    try {
      const result = await runResumeFlow(
        { sessionId: args.sessionId, refreshDryRun: flags["refresh-dry-run"] },
        {
          log: (m) => this.log(m),
          confirm: (req) => confirmOnTty(req, flags.yes),
        },
      );
      if (result.outcome === "declined") this.exit(ExitCode.USER);
      return result;
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
