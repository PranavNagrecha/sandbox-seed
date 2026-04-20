import { z } from "zod";

/**
 * Shared Zod schemas for MCP tool arguments.
 *
 * Everything an AI agent calls has to route through one of these. The schemas
 * are deliberately narrow — we accept the minimum set of knobs the existing
 * engine exposes, nothing more. If a new option is added here, the engine
 * must already support it.
 */

/** Org alias or username. Optional — if omitted, server resolves `sf` default target-org. */
export const OrgRef = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Salesforce org alias (from `sf org login`) or username. Omit to use the sf CLI's default target-org.",
  );

export const FieldFiltersSchema = z
  .object({
    includeFormula: z
      .boolean()
      .optional()
      .describe("Include formula / calculated / auto-number fields. Default: false."),
    includeAudit: z
      .boolean()
      .optional()
      .describe("Include audit fields (CreatedById/Date, LastModified*, SystemModstamp). Default: false."),
    includeNonCreateable: z
      .boolean()
      .optional()
      .describe("Include non-createable fields (read-only / system-managed). Default: false."),
  })
  .optional()
  .describe("Per-category field filters applied to describe results.");

export const ListOrgsArgs = z.object({});

export const DescribeGlobalArgs = z.object({
  org: OrgRef,
  bypassCache: z
    .boolean()
    .optional()
    .describe("Bypass the 24h describe cache and force a fresh fetch."),
});

export const DescribeObjectArgs = z.object({
  org: OrgRef,
  object: z
    .string()
    .min(1)
    .describe("sObject API name (e.g. 'Case', 'Account', 'MyThing__c')."),
  fieldFilters: FieldFiltersSchema,
  bypassCache: z.boolean().optional(),
});

export const InspectObjectArgs = z.object({
  org: OrgRef,
  object: z
    .string()
    .min(1)
    .describe("Root sObject API name. The dependency graph is computed around this object."),
  recordType: z
    .string()
    .optional()
    .describe(
      "Record-type developer name. Scopes required-field classification on the root to that record type.",
    ),
  parentDepth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "How many levels up to walk transitive parents. Stops at standard root objects regardless. Default: 2.",
    ),
  includeChildren: z
    .boolean()
    .optional()
    .describe("Walk one level of children via childRelationships. Default: true."),
  includeCounts: z
    .boolean()
    .optional()
    .describe(
      "Run SELECT COUNT() per walked object. Returns aggregate scalars only — no record data. Default: false.",
    ),
  fieldFilters: FieldFiltersSchema,
  bypassCache: z.boolean().optional(),
});

export const CheckRowCountsArgs = z.object({
  org: OrgRef,
  objects: z
    .array(z.string().min(1))
    .min(1)
    .describe("sObject API names to count. Returns null for objects the user lacks query permission on."),
});

export const CheckAiBoundaryArgs = z.object({});

export type InspectObjectArgsT = z.infer<typeof InspectObjectArgs>;
export type DescribeObjectArgsT = z.infer<typeof DescribeObjectArgs>;
export type DescribeGlobalArgsT = z.infer<typeof DescribeGlobalArgs>;
export type CheckRowCountsArgsT = z.infer<typeof CheckRowCountsArgs>;
