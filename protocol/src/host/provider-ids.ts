import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

// The literal list is the enum's source, and what module-scope consumers read:
// reading `.options` at module scope would build the schema at import.
export const PROVIDER_ID_VALUES = [
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
  "reasonix",
  "antigravity",
] as const;
export const providerIdSchema = lazySchema(() => z.enum(PROVIDER_ID_VALUES));
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * Frozen provider id set as shipped in protocol v1.0. Used only by the frozen
 * v1.0 `providers.list` response so a v1.0 client never receives the ACP GUI
 * harness providers; the v2.0 line adds them with a v2→v1 downgrade bridge. Do
 * not add new providers here.
 */
export const providerIdSchemaV10 = lazySchema(() =>
  z.enum(["claude-code", "codex", "opencode", "cursor", "traycer"]),
);
export type ProviderIdV10 = z.infer<typeof providerIdSchemaV10>;

/**
 * Frozen provider id set as shipped in protocol v2.0 (before Amp). Used only
 * by the frozen v2.0 `providers.list` response so an already-shipped v2.0
 * client never receives the Amp provider. Do not add new providers here -
 * extend the latest `providerIdSchema` and use the existing version bridges.
 */
export const providerIdSchemaV20 = lazySchema(() =>
  z.enum([
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
  ]),
);
export type ProviderIdV20 = z.infer<typeof providerIdSchemaV20>;
