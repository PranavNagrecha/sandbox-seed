import { spawn } from "node:child_process";

/**
 * Enumerate authenticated Salesforce orgs.
 *
 * Strategy: shell out to `sf org list --json`. Same approach `resolveAuth`
 * uses — keeps us out of the `@salesforce/core` dependency. If `sf` isn't
 * on PATH we return an empty list; the AI can still call other tools with
 * an explicit `org` arg if the user has a plaintext `~/.sfdx/*.json`.
 *
 * AI-boundary note: this tool returns org metadata (alias, username,
 * orgId, instanceUrl, isSandbox). No record data, no access tokens.
 */
export type OrgSummary = {
  alias: string | null;
  username: string;
  orgId: string;
  instanceUrl: string;
  isSandbox: boolean;
  isDefault: boolean;
  connectedStatus: string;
};

export type ListOrgsResult = {
  orgs: OrgSummary[];
  count: number;
};

/**
 * MCP structuredContent must be a JSON object, not a bare array. Wrapping in
 * `{orgs, count}` keeps the shape valid across every host (Claude Code,
 * Claude Desktop, Cursor). Caught by end-to-end smoke testing — the SDK's
 * result-schema validator rejected the bare-array return with
 * `Invalid input: expected record, received array`.
 */
export async function listOrgs(): Promise<ListOrgsResult> {
  const raw = await runSfOrgList();
  if (raw === null) return { orgs: [], count: 0 };

  const result = (raw.result ?? raw) as Record<string, unknown>;
  const nonScratchOrgs = asArray(result.nonScratchOrgs);
  const scratchOrgs = asArray(result.scratchOrgs);
  const sandboxes = asArray(result.sandboxes);
  const other = asArray(result.other);

  const combined: OrgSummary[] = [];
  for (const o of nonScratchOrgs) combined.push(toSummary(o, false));
  for (const o of scratchOrgs) combined.push(toSummary(o, false));
  for (const o of sandboxes) combined.push(toSummary(o, true));
  for (const o of other) combined.push(toSummary(o, false));

  const byKey = new Map<string, OrgSummary>();
  for (const o of combined) {
    const key = `${o.orgId}:${o.username}`;
    if (!byKey.has(key)) byKey.set(key, o);
    else if (byKey.get(key)!.isSandbox === false && o.isSandbox === true) {
      byKey.set(key, o);
    }
  }
  const orgs = [...byKey.values()];
  return { orgs, count: orgs.length };
}

function toSummary(entry: Record<string, unknown>, isSandbox: boolean): OrgSummary {
  return {
    alias: typeof entry.alias === "string" ? entry.alias : null,
    username: String(entry.username ?? ""),
    orgId: String(entry.orgId ?? entry.id ?? ""),
    instanceUrl: String(entry.instanceUrl ?? ""),
    isSandbox: isSandbox || entry.isSandbox === true,
    isDefault: entry.isDefaultUsername === true || entry.isDefaultDevHubUsername === true,
    connectedStatus:
      typeof entry.connectedStatus === "string" ? (entry.connectedStatus as string) : "Unknown",
  };
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
}

async function runSfOrgList(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const proc = spawn("sf", ["org", "list", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}
