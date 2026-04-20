import { resolveAuth } from "../../auth/sf-auth.ts";
import { fetchRowCounts } from "../../query/counts.ts";
import type { CheckRowCountsArgsT } from "../schemas.ts";
import type { ToolOverrides } from "./describe-global.ts";

/**
 * Standalone row counts for a user-supplied list of objects.
 *
 * AI-boundary note: `SELECT COUNT()` returns one integer per object.
 * No field values, no record IDs. Aggregate metadata only.
 *
 * Objects the caller lacks query permission on come back as `null` — we do
 * not surface the underlying 403/401 to the AI (it's not actionable from
 * the agent's side and it's confusing).
 */
export async function checkRowCounts(
  args: CheckRowCountsArgsT,
  overrides?: ToolOverrides,
): Promise<{
  orgId: string;
  alias: string | null;
  counts: Record<string, number | null>;
}> {
  const auth = overrides?.auth ?? (await resolveAuth(args.org, "60.0"));
  const counts = await fetchRowCounts({ auth, objects: args.objects, fetchFn: overrides?.fetchFn });

  const out: Record<string, number | null> = {};
  for (const name of args.objects) {
    out[name] = counts.has(name) ? (counts.get(name) as number) : null;
  }

  return { orgId: auth.orgId, alias: auth.alias ?? null, counts: out };
}
