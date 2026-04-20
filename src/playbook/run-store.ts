import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { UserError } from "../errors.ts";
import type { PlaybookRunManifest } from "./types.ts";

/**
 * Persistent store for playbook runs. A playbook run is the bundle of
 * per-step sessions created by `action: "dry_run"` and consumed by
 * `action: "run"`. Layout:
 *
 *   ~/.sandbox-seed/playbook-runs/<run-id>/
 *     manifest.json            # PlaybookRunManifest
 *     aggregated-dry-run.md    # rolled-up human report (written by aggregate-dry-run.ts)
 *
 * Per-step sessions still live at ~/.sandbox-seed/sessions/<session-id>/
 * as usual — they're owned by the `SessionStore`, we just reference them
 * here by id.
 */
export type PlaybookRunStoreOptions = {
  /** Defaults to `~/.sandbox-seed`. */
  rootDir?: string;
};

export class PlaybookRunStore {
  private readonly rootDir: string;

  constructor(opts: PlaybookRunStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? join(homedir(), ".sandbox-seed");
  }

  runDir(runId: string): string {
    return join(this.rootDir, "playbook-runs", sanitize(runId));
  }

  aggregatedDryRunPath(runId: string): string {
    return join(this.runDir(runId), "aggregated-dry-run.md");
  }

  private manifestPath(runId: string): string {
    return join(this.runDir(runId), "manifest.json");
  }

  async create(manifest: PlaybookRunManifest): Promise<void> {
    await mkdir(this.runDir(manifest.playbookRunId), { recursive: true });
    await this.save(manifest);
  }

  async load(runId: string): Promise<PlaybookRunManifest> {
    let raw: string;
    try {
      raw = await readFile(this.manifestPath(runId), "utf8");
    } catch {
      throw new UserError(
        `Playbook run "${runId}" not found.`,
        `Call playbook with action: "dry_run" to create a new run.`,
      );
    }
    try {
      return JSON.parse(raw) as PlaybookRunManifest;
    } catch {
      throw new UserError(
        `Playbook run "${runId}" manifest is corrupt.`,
        `Delete ${this.runDir(runId)} and re-create the run.`,
      );
    }
  }

  async save(manifest: PlaybookRunManifest): Promise<void> {
    await mkdir(this.runDir(manifest.playbookRunId), { recursive: true });
    await writeFile(
      this.manifestPath(manifest.playbookRunId),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }
}

export function newPlaybookRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = randomBytes(5).toString("hex");
  return `${date}-${suffix}`;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
