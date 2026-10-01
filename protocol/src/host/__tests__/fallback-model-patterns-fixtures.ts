import type {
  TierGroup,
  TierModelIdentity,
} from "@traycer/protocol/host/fallback-policy";

/** The 2026-09-25 live catalogs recorded in the model-patterns spec, in catalog order. */
export const CLAUDE_CATALOG: readonly TierModelIdentity[] = [
  { slug: "default", label: "Default (Opus 5.5)" },
  { slug: "opus[1m]", label: "Opus 5.5 (1M context)" },
  { slug: "claude-fable-5-1[1m]", label: "Fable 5.1 (1M context)" },
  { slug: "sonnet", label: "Sonnet 5" },
  { slug: "haiku", label: "Haiku" },
];

export const CODEX_CATALOG: readonly TierModelIdentity[] = [
  { slug: "gpt-6-astra", label: "GPT-6-Astra" },
  { slug: "gpt-6-sol", label: "GPT-6-Sol" },
  { slug: "gpt-6-luna", label: "GPT-6-Luna" },
  { slug: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  { slug: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
  { slug: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  { slug: "gpt-5.5", label: "GPT-5.5" },
];

export const GROK_CATALOG: readonly TierModelIdentity[] = [
  { slug: "grok-4.7", label: "Grok 4.7" },
  { slug: "grok-4.7-build-fast", label: "Grok 4.7 Build Fast" },
  { slug: "grok-4.6", label: "Grok 4.6" },
  { slug: "grok-4.5", label: "Grok 4.5" },
];

/** The seed as a literal; the host builds the real one. */
export const SEED_GROUPS: readonly TierGroup[] = [
  {
    id: "frontier",
    candidates: [
      { harnessId: "claude", modelFamily: "*fable*", reasoningEffort: "high" },
      { harnessId: "codex", modelFamily: "*astra*", reasoningEffort: "high" },
    ],
  },
  {
    id: "flagship",
    candidates: [
      { harnessId: "claude", modelFamily: "*opus*", reasoningEffort: "high" },
      { harnessId: "codex", modelFamily: "*sol*", reasoningEffort: "high" },
      { harnessId: "grok", modelFamily: "*grok*", reasoningEffort: null },
    ],
  },
  {
    id: "standard",
    candidates: [
      { harnessId: "claude", modelFamily: "*sonnet*", reasoningEffort: null },
      { harnessId: "codex", modelFamily: "*terra*", reasoningEffort: "medium" },
    ],
  },
];

export const SEED_DEFAULT = "flagship";
