import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

// Host-scoped: the page's scope gate conceals both cards while the host
// connects or is unreachable and drops them for a host that vanished, so
// every card and row here folds into the page.
export const HOST_NOTIFICATIONS = defineSettingsSection("notifications", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Notifications",
    // Under the host picker in a build without environments
    // (`settings-sections.ts`), where the page describes one host.
    description: UNRELEASED_FEATURES_ENABLED
      ? "What gets surfaced to you, and what your automation receives."
      : "What this host surfaces, and what its automation receives.",
    keywords: [
      "alerts",
      "inbox",
      "filter",
      "automation",
      "host",
      "in-app notifications",
      "toast",
      "severity",
      "notification hooks",
      "hooks",
      "webhook",
      "script",
      "command",
      "trigger",
      "run on",
    ],
  },
  inAppNotifications: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "In-app notifications",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  severityNeedsAction: {
    kind: "row",
    group: "inAppNotifications",
    search: { contributesTo: "page" },
    label: "Needs action",
    description: "Approvals and interviews.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  severityFailure: {
    kind: "row",
    group: "inAppNotifications",
    search: { contributesTo: "page" },
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  severityDone: {
    kind: "row",
    group: "inAppNotifications",
    search: { contributesTo: "page" },
    label: "Done",
    description: "Completed or intentionally stopped turns.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  severityInfo: {
    kind: "row",
    group: "inAppNotifications",
    search: { contributesTo: "page" },
    label: "Info",
    description: "Background host operations, including worktree cleanup.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  notificationHooks: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Notification hooks",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
