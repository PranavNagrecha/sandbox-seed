import { listOrgs } from "../tools/list-orgs.ts";

/**
 * `org://<alias>` — resolves to a single org summary from `list_orgs`.
 * If the alias isn't found, we throw — the SDK serializes that into a
 * proper resource-read error for the client.
 */
export async function readOrgResource(
  _uri: URL,
  vars: Record<string, string | string[]>,
): Promise<string> {
  const alias = firstVar(vars, "alias");
  if (alias === undefined || alias.length === 0) {
    throw new Error("org:// URI requires an alias, e.g. org://dev-sandbox");
  }

  const { orgs } = await listOrgs();
  const hit =
    orgs.find((o) => o.alias === alias) ??
    orgs.find((o) => o.username === alias) ??
    orgs.find((o) => o.orgId === alias);

  if (hit === undefined) {
    throw new Error(
      `Unknown org "${alias}". Run sandbox_seed_list_orgs to see authenticated orgs.`,
    );
  }
  return JSON.stringify(hit, null, 2);
}

function firstVar(vars: Record<string, string | string[]>, key: string): string | undefined {
  const v = vars[key];
  if (Array.isArray(v)) return v[0];
  return v;
}
