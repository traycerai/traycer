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
  "Turning this off stops Traycer starting new switches or waits. Chats already switching or waiting carry on - stop those from the chat. Your coding agent's own retries are separate and unaffected.";

/**
 * Host-scoped, so nothing below the page owns an anchor: the page's scope gate
 * conceals every card while the host connects or cannot be reached, and each
 * card renders only once the host answers the policy read. Every group and row
 * folds its words into the page entry instead, which is the one destination on
 * this page a result can always land on.
 */
export const FALLBACK = defineSettingsSection("fallback", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Model routing",
    description:
      "What Traycer tries when a rate limit or another provider problem interrupts your chat.",
    keywords: [
      // "fallback" and "failover" stay in the index on purpose: they were the
      // shipped name and are what the category calls this, so muscle memory
      // and a developer's first guess both still land on the page.
      "fallback",
      "failover",
      "routing",
      "route",
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
      "per-failure overrides",
      "reset",
    ],
  },
  fallback: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Model routing",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  automaticFallback: {
    kind: "row",
    group: "fallback",
    search: { contributesTo: "page" },
    label: "Route automatically",
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
    label: "Time to cancel a switch",
    description:
      "Traycer waits this long before switching, so you can cancel from the chat. Opening the menu to choose another account or model pauses the countdown.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  maxWait: {
    kind: "row",
    group: "behavior",
    search: { contributesTo: "page" },
    label: "Longest wait for a usage limit to reset",
    description:
      "If the limit resets later than this, Traycer skips waiting and moves on to the next step.",
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
    label: "Reset model routing",
    description: "Puts every setting on this page back to its default.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
