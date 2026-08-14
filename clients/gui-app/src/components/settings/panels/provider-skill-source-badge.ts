import type { ProviderSkillSourceBadge } from "@traycer/protocol/host/provider-native-schemas";

/**
 * How a skill's origin is named and toned. Shared by the list row and the
 * expanded dialog: the same skill must not be "Shared" in one and something
 * else in the other, and a badge that changes color when you open it reads as
 * a different object.
 */
export const SKILL_SOURCE_LABEL: Record<ProviderSkillSourceBadge, string> = {
  shared: "Shared",
  provider: "Provider-only",
  plugin: "Plugin",
  managed: "Built-in",
};

export const SKILL_SOURCE_TONE: Record<ProviderSkillSourceBadge, string> = {
  shared: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  provider:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  plugin:
    "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  managed: "border-border bg-muted/60 text-muted-foreground",
};

/** Display order for source badges wherever they are enumerated (filter menu). */
export const SKILL_SOURCE_ORDER: readonly ProviderSkillSourceBadge[] = [
  "shared",
  "provider",
  "plugin",
  "managed",
];

/** Occupied link-target row. Distinct from the source badge. */
export const SKILL_CONFLICT_LABEL = "Conflict";

export const SKILL_CONFLICT_TONE =
  "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200";

export const SKILL_CONFLICT_TOOLTIP =
  "A folder already occupies this provider's link for this skill. Traycer did not adopt or overwrite it.";
