import { Args, Command } from "@oclif/core";
import { ExitCode, SeedError } from "../../errors.ts";
import { seed } from "../../mcp/tools/seed.ts";

export default class SeedRecover extends Command {
  static override description =
    "Reactivate target-org validation rules a crashed seed run left deactivated. " +
    "The seed engine refuses all new work while a recovery is pending — this clears it.";

  static override examples = ["<%= config.bin %> <%= command.id %> 8f2c1a-…"];

  static override args = {
    sessionId: Args.string({
      description: "The session whose validation-rule snapshot should be restored.",
      required: true,
    }),
  };

  static override enableJsonFlag = true;

  async run(): Promise<unknown> {
    const { args } = await this.parse(SeedRecover);
    try {
      const result = await seed({
        action: "recover_validation_rules",
        sessionId: args.sessionId,
      });
      this.log(result.guidance);
      if ((result.summary.failedCount as number) > 0) this.exit(ExitCode.API);
      return result.summary;
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
