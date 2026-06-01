export { deriveSeed } from "./engine.ts";
export { createMasker, pickStrategy } from "./registry.ts";
export {
  maskedFieldNames,
  resolveMaskSelection,
  type MaskFieldSpec,
  type UserMaskFields,
} from "./resolve.ts";
export { loadOrCreateSalt, saltPath } from "./salt.ts";
export {
  OMIT_ROW,
  type Masker,
  type MaskContext,
  type MaskResult,
  type MaskSelection,
  type MaskStrategy,
} from "./types.ts";
