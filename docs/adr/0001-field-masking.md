# ADR 0001 — Deterministic field masking (SF → SF)

**Status:** Accepted — code-complete; production blessing gated on the real-org acceptance smoke (T14).
**Date:** 2026-05-31
**Spec:** [phases/masking-spec.md](../../phases/masking-spec.md) · **Plan:** [phases/masking-plan.md](../../phases/masking-plan.md)

## Context

Copying real Salesforce data into a sandbox copies real PII. Regulated verticals — the HED/EDU orgs this tool is tested against carry FERPA-protected student data — can't do that. `REQUIREMENTS.md` #4 calls for in-flight masking; it was at 0%. Masking is also the foundation the eventual Fake → SF generation mode reuses (faker-js + per-field transforms + recipe field options).

## Decision

Add opt-in, deterministic, format-preserving field masking on the SF → SF copy path, applied at the single `rewriteRecordForTarget` hook, defaulting off the `sensitiveFields` the analyzer already computes. Locked choices (doubt-driven; spec §5):

- **Value-keyed seed.** `seed = HMAC-SHA256(salt, value)`; preset chosen per field. Keyed by the **value only** (not object/field) so the same value masks identically everywhere — value joins and external-id UPSERT survive. (Corrected from an early object.field sketch that would have broken this.)
- **Format-preserving presets** (email / phone / person-name / street-address / generic-text), length-capped, seeded by the keyed hash. faker-js v9.
- **Fail-closed.** Anything unmaskable returns `OMIT_ROW` → skip + log; never a clear value.
- **Mask-by-default for detected PII + explicit override.** Default selection = `sensitiveFields`; the user adds / pins / `copy`-opts-out via `maskFields`. The dry-run report surfaces the selection — detection under-flags (G1), so review is the safety control.
- **Persistent per-(source, target) salt** beside the project id-map (chmod 600) for cross-run idempotence; `isolateIdMap` ⇒ ephemeral per-session salt.
- **References never masked** — the id-map owns FK remapping.

## Consequences

- The boundary's "data on disk is real" caveat now has an opt-in, target-side remedy. AI_BOUNDARY gains a [Masking](../AI_BOUNDARY.md#masking) annex.
- Deterministic masking is set-membership-confirmable (known-plaintext) — a documented, accepted residual; ephemeral salt (`isolateIdMap`) is the escape hatch.
- Off by default; opt-in via `mask` / `maskFields`. Final production blessing is gated on the real-org acceptance smoke (T14, `Excelsior FULL → DevCaseInt`).
- Reversible / tokenized masking with a vault is explicitly out of scope.
