import type { OrgAuth } from "../../auth/sf-auth.ts";
import { resolveAuth } from "../../auth/sf-auth.ts";
import { DescribeCache } from "../../describe/cache.ts";
import { DescribeClient } from "../../describe/client.ts";
import type { DescribeGlobalArgsT } from "../schemas.ts";

/**
 * Lightweight list of every sObject in the target org. No record data.
 * Wraps `DescribeClient.describeGlobal()` — same cache the CLI uses.
 */
export type GlobalObjectSummary = {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
};

export type ToolOverrides = {
  auth?: OrgAuth;
  fetchFn?: typeof fetch;
  cacheRoot?: string;
};

export async function describeGlobal(
  args: DescribeGlobalArgsT,
  overrides?: ToolOverrides,
): Promise<{
  orgId: string;
  alias: string | null;
  objects: GlobalObjectSummary[];
}> {
  const auth = overrides?.auth ?? (await resolveAuth(args.org, "60.0"));
  const cache = new DescribeCache({
    orgId: auth.orgId,
    ttlSeconds: 86400,
    bypass: args.bypassCache ?? false,
    cacheRoot: overrides?.cacheRoot,
  });
  const client = new DescribeClient({ auth, cache, fetchFn: overrides?.fetchFn });
  const global = await client.describeGlobal();

  return {
    orgId: auth.orgId,
    alias: auth.alias ?? null,
    objects: global.sobjects.map((s) => ({
      name: s.name,
      label: s.label,
      custom: s.custom,
      queryable: s.queryable,
      createable: s.createable,
    })),
  };
}
