import { writeFile } from "node:fs/promises";
import type { Playbook } from "./types.ts";

/**
 * Render the aggregated dry-run report consumed by the user between
 * `playbook action: "dry_run"` and `action: "run"`. Writes to the
 * playbook run dir. AI-boundary: the response only references this
 * path; the file itself lives on disk.
 */
export type AggregateStepInput = {
  stepName: string;
  sessionId: string;
  perObjectCounts: Record<string, number>;
  totalRecords: number;
  alreadySeededCounts?: Record<string, number>;
  schemaIssueCount: number;
  reportPath: string;
  projectIdMapPath?: string;
  projectIdMapInvalidated?: {
    reason: "org-refresh" | "org-mismatch" | "meta-corrupt";
    archivedTo: string;
  };
};

export async function writeAggregatedDryRun(args: {
  outputPath: string;
  playbook: Playbook;
  runId: string;
  completedAt: string;
  steps: AggregateStepInput[];
}): Promise<void> {
  const { playbook, runId, completedAt, steps } = args;
  const totalAcross = steps.reduce((a, s) => a + s.totalRecords, 0);
  const totalAlready = steps.reduce(
    (a, s) =>
      a + Object.values(s.alreadySeededCounts ?? {}).reduce((x, y) => x + y, 0),
    0,
  );

  const lines: string[] = [];
  lines.push(`# Playbook dry run: ${playbook.name}`);
  lines.push("");
  lines.push(`Run id: \`${runId}\``);
  lines.push(`Generated: ${completedAt}`);
  if (playbook.description !== undefined) {
    lines.push("");
    lines.push(playbook.description);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Steps: ${steps.length}`);
  lines.push(`- Total records across all steps: **${totalAcross}**`);
  if (totalAlready > 0) {
    lines.push(
      `- Already-seeded records (would be skipped by project id-map): **${totalAlready}**`,
    );
  }
  lines.push("");
  lines.push("## Per-step counts");
  lines.push("");
  lines.push("| # | Step | Records | Already-seeded | Schema issues | Report |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const already = Object.values(s.alreadySeededCounts ?? {}).reduce(
      (a, b) => a + b,
      0,
    );
    lines.push(
      `| ${i + 1} | \`${s.stepName}\` | ${s.totalRecords} | ${already} | ` +
        `${s.schemaIssueCount} | ${s.reportPath} |`,
    );
  }
  lines.push("");

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const step = playbook.steps[i];
    lines.push(`## Step ${i + 1}: ${s.stepName}`);
    lines.push("");
    lines.push(`- Root object: \`${step.object}\``);
    lines.push(`- WHERE: \`${step.whereClause}\``);
    lines.push(`- Session: \`${s.sessionId}\``);
    lines.push(`- Per-step report: ${s.reportPath}`);
    if (s.projectIdMapPath !== undefined) {
      lines.push(`- Project id-map: ${s.projectIdMapPath}`);
    }
    if (s.projectIdMapInvalidated !== undefined) {
      lines.push(
        `- ⚠ Project id-map invalidated (${s.projectIdMapInvalidated.reason}); ` +
          `archived to ${s.projectIdMapInvalidated.archivedTo}`,
      );
    }
    lines.push("");
    lines.push("| Object | Records | Already-seeded |");
    lines.push("| --- | --- | --- |");
    for (const obj of Object.keys(s.perObjectCounts)) {
      const n = s.perObjectCounts[obj] ?? 0;
      const already = s.alreadySeededCounts?.[obj] ?? 0;
      lines.push(`| \`${obj}\` | ${n} | ${already} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `To execute the playbook, call \`playbook\` with ` +
      `\`{action: "run", playbookRunId: "${runId}", confirm: true}\` within 24 hours.`,
  );

  await writeFile(args.outputPath, lines.join("\n"), "utf8");
}
