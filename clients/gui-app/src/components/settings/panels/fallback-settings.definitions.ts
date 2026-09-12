import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * What the master switch does, in three sentences - and the third is the one
 * that is not obvious.
 *
 * Fixed copy, agreed as written. Each sentence answers a question the previous
 * wording left open:
 *
 *  - **what stops** - NEW recovery, not the feature's effects;
 *  - **what does not** - work already in progress runs to its end, and the
 *    place to stop THAT is the chat's own card, which has the stop action. A
 *    user who reads "turning this off stops fallback" and then watches a chat
 *    go on waiting has been told something false by omission;
 *  - **what this switch is not.** Claude Code, Codex and the rest have their
 *    own retry and fallback behaviour, and this page does not reach it. Without
 *    the sentence, a user turning this off can reasonably believe they have
 *    stopped ALL automatic recovery on their machine, and then be surprised by
 *    their coding agent's own. That belief is the expensive one, because the
 *    remedy for it is in a different product.
 *
 * "Traycer recovery" rather than "fallback" as the subject of the first
 * sentence, for the same reason: the noun has to be ours specifically, or the
 * third sentence has nothing to contrast with.
 *
 * It lives in this module because it is the row's static description, and a
 * row's description is one value read by both the panel that renders it and
 * the index that searches it. The count that follows it while chats are in
 * flight is live, so it goes in the row's `status` at the call site instead.
 */
export const MASTER_TOGGLE_DESCRIPTION =
  "Stops new Traycer recovery. Recovery already in progress continues; stop it from the chat. Your coding agent's own recovery settings are unchanged.";

/**
 * Host-scoped, so nothing below the page owns an anchor: the page's scope gate
 * conceals every card while the host connects or cannot be reached, and each
 * card renders only once the host answers the policy read. Every group and row
 * folds its words into the page entry instead, which is the one destination on
 * this page a result can always land on.
 */
export const FALLBACK = defineSettingsSection("fallback", {
  page: {
    label: "Fallback",
    description: "When a turn fails on a provider error, try these in order.",
    keywords: [
      "automatic",
      "rate limit",
      "usage limit",
      "limit reached",
      "session limit",
      "switch account",
      "switch model",
      "failover",
      "backup model",
      "recovery",
      "retry",
      "outage",
      "wait for reset",
      "grace period",
      "countdown",
      "equivalent models",
      "similar model",
      "tier",
      "allowed destinations",
      "exclude provider",
      "per-failure overrides",
      "reset",
    ],
  },
  fallback: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Fallback",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  automaticFallback: {
    kind: "row",
    group: "fallback",
    search: { contributesTo: "page" },
    label: "Automatic fallback",
    description: MASTER_TOGGLE_DESCRIPTION,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  plan: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Plan",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  behavior: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Behavior",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  graceWindow: {
    kind: "row",
    group: "behavior",
    search: { contributesTo: "page" },
    label: "Time to cancel before switching",
    description:
      "How long a chat shows the switch card before it goes ahead. Opening the destination menu pauses this.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  maxWait: {
    kind: "row",
    group: "behavior",
    search: { contributesTo: "page" },
    label: "Longest wait for a reset",
    description:
      "The waiting step is skipped when a provider's limit resets later than this.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  equivalentModels: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Equivalent models",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  allowedDestinations: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Allowed destinations",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  advanced: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Advanced",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  dangerZone: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Danger Zone",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  resetAll: {
    kind: "row",
    group: "dangerZone",
    search: { contributesTo: "page" },
    label: "Reset all fallback settings",
    description: "Puts every fallback setting back to its default.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
