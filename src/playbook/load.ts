import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { UserError } from "../errors.ts";
import { type Playbook, PlaybookSchema } from "./types.ts";

/**
 * Load + validate a playbook from the user's playbook directory.
 *
 * Playbooks live at `~/.sandbox-seed/playbooks/<name>.yml` — user scope
 * only, never project/team scope (per
 * `feedback_playbooks_user_scope_only.md`). The filename stem is the
 * playbook's lookup name; the file's `name` field is informational and
 * does not need to match.
 */

export type PlaybookListing = {
  name: string;
  path: string;
  stepCount: number;
  description: string | null;
};

export function playbooksDir(rootDir?: string): string {
  const root = rootDir ?? join(homedir(), ".sandbox-seed");
  return join(root, "playbooks");
}

export async function listPlaybooks(rootDir?: string): Promise<PlaybookListing[]> {
  const dir = playbooksDir(rootDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: PlaybookListing[] = [];
  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const path = join(dir, entry);
    try {
      const pb = await parseAndValidate(path);
      out.push({
        name: entry.replace(/\.ya?ml$/i, ""),
        path,
        stepCount: pb.steps.length,
        description: pb.description ?? null,
      });
    } catch {
      // Malformed playbooks are silently skipped in `list`; the user sees
      // the full error only when they try to `dry_run` them.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Load a single playbook by name (no `.yml` extension) from the user's
 * playbook directory. Throws UserError with a clear message on missing
 * file or validation failure.
 */
export async function loadPlaybookByName(
  name: string,
  rootDir?: string,
): Promise<{ playbook: Playbook; path: string }> {
  const dir = playbooksDir(rootDir);
  // Support both `.yml` and `.yaml` extensions. `name` is user-provided,
  // so sanitize it to a single path segment.
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (safe.length === 0 || safe !== name) {
    throw new UserError(
      `Invalid playbook name "${name}".`,
      "Playbook names must contain only letters, digits, dot, underscore, and dash.",
    );
  }
  const candidates = [join(dir, `${safe}.yml`), join(dir, `${safe}.yaml`)];
  let path: string | null = null;
  for (const c of candidates) {
    try {
      await readFile(c, "utf8");
      path = c;
      break;
    } catch {
      // next candidate
    }
  }
  if (path === null) {
    throw new UserError(
      `Playbook "${name}" not found under ${dir}.`,
      `Create ${join(dir, `${safe}.yml`)} or list existing ones with action: "list".`,
    );
  }
  const playbook = await parseAndValidate(path);
  return { playbook, path };
}

async function parseAndValidate(path: string): Promise<Playbook> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new UserError(
      `Could not read playbook at ${path}.`,
      (err as Error).message,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new UserError(
      `Playbook at ${path} is not valid YAML.`,
      (err as Error).message,
    );
  }
  const result = PlaybookSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new UserError(
      `Playbook at ${path} failed schema validation.`,
      issues,
    );
  }
  // Step-name uniqueness — zod can't express this cleanly so we do it here.
  const seen = new Set<string>();
  for (const s of result.data.steps) {
    if (seen.has(s.name)) {
      throw new UserError(
        `Playbook at ${path} has duplicate step name "${s.name}".`,
        "Step names must be unique within a playbook.",
      );
    }
    seen.add(s.name);
  }
  return result.data;
}
