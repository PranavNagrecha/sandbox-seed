import { describeObject } from "../tools/describe-object.ts";

/**
 * `describe://<alias>/<object>` — cached describe for one object, run
 * through the default field filters. Resource reads use the same code path
 * the tool call does; no divergent logic.
 */
export async function readDescribeResource(
  _uri: URL,
  vars: Record<string, string | string[]>,
): Promise<string> {
  const alias = firstVar(vars, "alias");
  const object = firstVar(vars, "object");
  if (alias === undefined || object === undefined) {
    throw new Error("describe:// URI must include alias and object, e.g. describe://dev-sandbox/Case");
  }

  const result = await describeObject({ org: alias, object });
  return JSON.stringify(result, null, 2);
}

function firstVar(vars: Record<string, string | string[]>, key: string): string | undefined {
  const v = vars[key];
  if (Array.isArray(v)) return v[0];
  return v;
}
