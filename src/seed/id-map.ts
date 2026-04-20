import { readFile, writeFile } from "node:fs/promises";

/**
 * Source→target ID map used during `run`. Keyed by `<object>:<sourceId>`
 * so an Account with ID 001xxx can only ever resolve to the target
 * Account row it was inserted as.
 *
 * Persisted as JSON alongside the session so partial runs are resumable
 * (and so a user can inspect the mapping after a failed run).
 *
 * Not exposed to the LLM. The tool response references the file path;
 * the contents never enter prompt context.
 */
export class IdMap {
  private readonly map = new Map<string, string>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.length > 0) this.map.set(k, v);
      }
    } catch {
      // No file yet (or corrupted) — start empty. The next save() will
      // create it.
    }
  }

  async save(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.map) obj[k] = v;
    await writeFile(this.filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  set(object: string, sourceId: string, targetId: string): void {
    this.map.set(keyOf(object, sourceId), targetId);
  }

  get(object: string, sourceId: string): string | undefined {
    return this.map.get(keyOf(object, sourceId));
  }

  has(object: string, sourceId: string): boolean {
    return this.map.has(keyOf(object, sourceId));
  }

  size(): number {
    return this.map.size;
  }

  /** For tests. */
  entries(): Array<[string, string]> {
    return [...this.map.entries()];
  }
}

function keyOf(object: string, sourceId: string): string {
  return `${object}:${sourceId}`;
}
