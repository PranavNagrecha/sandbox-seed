import { runInspect } from "../dist/inspect/run.js";
import { resolveAuth } from "../dist/auth/sf-auth.js";
import { collectChildObjects } from "../dist/graph/build.js";
import { DescribeClient } from "../dist/describe/client.js";
import { DescribeCache } from "../dist/describe/cache.js";

const alias = process.argv[2];
if (!alias) {
  console.error("usage: node scripts/probe-inspect.mjs <org-alias>");
  process.exit(2);
}
const auth = await resolveAuth(alias, "60.0");

// First, probe collectChildObjects directly on Case describe
const cache = new DescribeCache({ orgId: auth.orgId, ttlSeconds: 86400, bypass: true });
const client = new DescribeClient({ auth, cache });
const caseDesc = await client.describeObject("Case");
console.log("Case childRelationships count (raw):", caseDesc.childRelationships?.length ?? 0);
const kids = collectChildObjects(caseDesc);
console.log("collectChildObjects returned:", kids.size, "children");
console.log("  sample:", [...kids].slice(0, 15));
console.log("  has CaseComment?", kids.has("CaseComment"));
console.log("  has AccountNote__c?", kids.has("AccountNote__c"));

for (const bypass of [true, false]) {
  for (const depth of [1, 2, 3]) {
    const result = await runInspect({
      auth, rootObject: "Case", parentWalkDepth: depth, includeChildren: true,
      recordType: "Support", includeCounts: false,
      cacheTtlSeconds: 86400, bypassCache: bypass,
    });
    console.log(`depth=${depth} bypassCache=${bypass}: parents=${result.parentObjects.length} children=${result.childObjects.length} hasCaseComment=${result.childObjects.includes("CaseComment")}`);
  }
}
