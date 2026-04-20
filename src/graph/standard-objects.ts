/**
 * Standard Salesforce objects that are part of the org's infrastructure, not
 * user data. These are excluded from the load order (you can't really "seed"
 * these — they're created by Salesforce or by setup operations).
 *
 * They remain nodes in the graph (edges referencing them are preserved and
 * rendered with an asterisk) so users understand the full dependency picture.
 */
export const STANDARD_ROOT_OBJECTS = new Set<string>([
  "User",
  "UserRole",
  "Profile",
  "PermissionSet",
  "PermissionSetGroup",
  "Group",
  "Organization",
  "RecordType",
  "RecordTypeLocalization",
  "CurrencyType",
  "BusinessHours",
  "Calendar",
  "Holiday",
  "Queue",
  "QueueSobject",
]);

/**
 * Regex patterns matching auto-generated Salesforce system objects that are
 * hidden by default in the tree view. Users can opt in with --include-system.
 */
const SYSTEM_SUFFIXES = [
  "ChangeEvent",
  "Feed",
  "History",
  "Share",
  "Tag",
  "OwnerSharingRule",
  "AccessRule",
  "__mdt", // custom metadata types
];

export function isStandardRootObject(name: string): boolean {
  return STANDARD_ROOT_OBJECTS.has(name);
}

export function isSystemObject(name: string): boolean {
  return SYSTEM_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
