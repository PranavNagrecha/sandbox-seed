import { inspectObject } from "../tools/inspect-object.ts";

/**
 * `graph://<alias>/<object>` — full `inspect_object` result for the given
 * alias + root, using default parent-depth (2) and includeChildren=true.
 *
 * For custom depth or counts, callers use the `sandbox_seed_inspect_object`
 * tool directly. Resources are for the common cached-re-read case.
 */
export async function readGraphResource(
  _uri: URL,
  vars: Record<string, string | string[]>,
): Promise<string> {
  const alias = firstVar(vars, "alias");
  const object = firstVar(vars, "object");
  if (alias === undefined || object === undefined) {
    throw new Error("graph:// URI must include alias and object, e.g. graph://dev-sandbox/Case");
  }

  const result = await inspectObject({ org: alias, object });
  return JSON.stringify(result, null, 2);
}

function firstVar(vars: Record<string, string | string[]>, key: string): string | undefined {
  const v = vars[key];
  if (Array.isArray(v)) return v[0];
  return v;
}
