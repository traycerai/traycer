import { z } from "zod";

export const providerIdSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
  "amp",
  "devin",
  "pi",
  "hermes",
  "omp",
  "huggingface",
]);
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * Frozen provider id set as shipped in protocol v1.0. Used only by the frozen
 * v1.0 `providers.list` response so a v1.0 client never receives the ACP GUI
 * harness providers; the v2.0 line adds them with a v2→v1 downgrade bridge. Do
 * not add new providers here.
 */
export const providerIdSchemaV10 = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
]);
export type ProviderIdV10 = z.infer<typeof providerIdSchemaV10>;

/**
 * Frozen provider id set as shipped in protocol v2.0 (before Amp). Used only
 * by the frozen v2.0 `providers.list` response so an already-shipped v2.0
 * client never receives the Amp provider. Do not add new providers here -
 * extend the latest `providerIdSchema` and use the existing version bridges.
 */
export const providerIdSchemaV20 = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
]);
export type ProviderIdV20 = z.infer<typeof providerIdSchemaV20>;

/**
 * The provider id set `providers.list@7.0` carries.
 *
 * A copy rather than a pointer at the live enum: a line pointing at live ids
 * stays correct only until the next id lands there, and nothing marks the
 * moment that stops being safe. A provider added to `providerIdSchema` after
 * v7.0 is released reaches v7.0 clients only through the bridge the next major
 * carries - and this enum is what that bridge drops against.
 *
 * Lives here rather than beside the v3.0-v6.0 snapshots in
 * `provider-schemas.ts` because the frozen v7.0 NATIVE payloads
 * (`nativeListQuerySchemaV70`) need it too, and `provider-native-schemas.ts`
 * cannot import from `provider-schemas.ts` - that edge runs the other way.
 */
export const providerIdSchemaV70 = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
  "amp",
  "devin",
  "pi",
  "hermes",
  "omp",
  // `huggingface` belongs to this line, which is why it is named here rather
  // than projected away from it. v7.0 is unreleased - no non-RC
  // `host-v*`/`cli-v*`/`desktop-v*` tag carries a major-7 contract - so this
  // enum mirrors the live one. `downgradeProviderCliStateListToV60` reads the
  // same boundary from the other side: it drops post-v6.0 providers, of which
  // `huggingface` is one.
  //
  // Once a non-RC release ships a major-7 contract, a provider added to the
  // live enum must be projected away by the bridge down from the next major
  // rather than mirrored here.
  "huggingface",
]);
export type ProviderIdV70 = z.infer<typeof providerIdSchemaV70>;
