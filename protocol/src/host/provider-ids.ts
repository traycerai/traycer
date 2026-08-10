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
 * Frozen provider id set as shipped in protocol v7.0 (identical to v6.0's -
 * v7.0 opened for `terminalLogin` and the `native` list carrier, not for a
 * provider).
 *
 * Frozen the moment v8.0 opened, rather than left pointing at the live enum,
 * because that pointer is precisely how `omp` first tried to ride v5.0 and how
 * the provider-pack-registry fields grew v6.0: a line stays correct only until
 * the next thing lands on the live schema. A new provider extends
 * `providerIdSchema` and reaches v7.0 clients through the v8→v7 bridge, which
 * drops what this enum does not name.
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
  // `huggingface` is ON this line, not projected away from it. It reached the
  // live enum after the v8.0 freeze cut, and v7.0 is unreleased - no non-RC
  // `host-v*`/`cli-v*`/`desktop-v*` tag carries a major-7 contract - so
  // growing v7.0 in place was legitimate, exactly as `config_unreadable` was.
  // `downgradeProviderCliStateListToV60` says the same thing from the other
  // side: it exists to "drop post-v6.0 providers (currently `huggingface`)",
  // which is only true if huggingface belongs to v7.0.
  //
  // Same expiry as everywhere else in this transition: once a release ships a
  // major-7 contract, a provider added to the live enum must be projected away
  // by the v8→v7 bridge instead of mirrored here.
  "huggingface",
]);
export type ProviderIdV70 = z.infer<typeof providerIdSchemaV70>;
