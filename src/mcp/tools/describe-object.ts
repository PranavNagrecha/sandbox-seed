import { resolveAuth } from "../../auth/sf-auth.ts";
import { DescribeCache } from "../../describe/cache.ts";
import { DescribeClient } from "../../describe/client.ts";
import type { SObjectDescribe } from "../../describe/types.ts";
import { applyFieldFilters, DEFAULT_FIELD_FILTERS, type FieldFilterOptions } from "../../graph/filters.ts";
import type { DescribeObjectArgsT } from "../schemas.ts";
import type { ToolOverrides } from "./describe-global.ts";

/**
 * One-object describe, run through our field filters. No record data.
 */
export async function describeObject(
  args: DescribeObjectArgsT,
  overrides?: ToolOverrides,
): Promise<{
  orgId: string;
  alias: string | null;
  describe: SObjectDescribe;
  droppedFieldCounts: { formula: number; audit: number; nonCreateable: number };
}> {
  const auth = overrides?.auth ?? (await resolveAuth(args.org, "60.0"));
  const cache = new DescribeCache({
    orgId: auth.orgId,
    ttlSeconds: 86400,
    bypass: args.bypassCache ?? false,
    cacheRoot: overrides?.cacheRoot,
  });
  const client = new DescribeClient({ auth, cache, fetchFn: overrides?.fetchFn });

  const filters: FieldFilterOptions = {
    includeFormula: args.fieldFilters?.includeFormula ?? DEFAULT_FIELD_FILTERS.includeFormula,
    includeAudit: args.fieldFilters?.includeAudit ?? DEFAULT_FIELD_FILTERS.includeAudit,
    includeNonCreateable:
      args.fieldFilters?.includeNonCreateable ?? DEFAULT_FIELD_FILTERS.includeNonCreateable,
  };

  const raw = await client.describeObject(args.object);
  const { kept, dropped } = applyFieldFilters(raw.fields, filters);

  return {
    orgId: auth.orgId,
    alias: auth.alias ?? null,
    describe: { ...raw, fields: kept },
    droppedFieldCounts: dropped,
  };
}
