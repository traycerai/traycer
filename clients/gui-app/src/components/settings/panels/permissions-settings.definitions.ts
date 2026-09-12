import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// A host-scoped page, so it indexes no anchor (SETTINGS.md § Search): the Auto
// mode group is dropped entirely on a host that advertises neither
// `autoJudge.get` nor `autoPolicy.get` - which is every host until it updates -
// and on a scope that is connecting, unreachable or vanished. No shell-level
// predicate can decide either, so the group and its rows contribute to the page
// instead and their vocabulary lands a search at the top of it.
export const PERMISSIONS = defineSettingsSection("permissions", {
  page: {
    label: "Permissions",
    description:
      "Who reviews what an agent does on this machine under the Auto permission mode.",
    keywords: [
      "permissions",
      "permission mode",
      "auto mode",
      "approve",
      "approval",
      "ask before",
      "judge",
      "policy",
    ],
  },
  autoMode: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Auto mode",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["auto", "automatic", "unattended"],
  },
  // "Traycer's auto mode judge", not "Auto mode judge": the OTHER row of that
  // name lives under Settings ▸ Providers and is the one that WINS
  // (`isProviderJudgedExecution` reads the provider's own `autoJudge` alone),
  // so both rows name whose judge they are about and state the precedence. The
  // dropped clause - that a tool-less provider runs the judge as a full agent
  // session in an empty scratch directory - is true and is an implementation
  // note; it was the longest sentence in Settings and it answered a question no
  // first-time user has.
  autoModeJudge: {
    kind: "row",
    group: "autoMode",
    search: { contributesTo: "page" },
    label: "Traycer's auto mode judge",
    description:
      "The agent that runs Traycer's judge on this machine. Traycer's default judge runs on Traycer's own inference and uses your credits. Pick another provider to move that cost onto your own subscription instead. A provider set to use its own classifier (Settings ▸ Providers) doesn't use this judge.",
    availableWhen: alwaysAvailable,
    keywords: [
      "auto mode",
      "judge",
      "classifier",
      "reviewer",
      "credits",
      "inference",
      "permission mode",
    ],
  },
  // "Every machine's judge follows it" was false twice over: a repository with
  // its own policy file displaces this one, and a provider switched to its own
  // classifier never reads a Traycer policy at all. Both exceptions are named
  // where the promise is made, rather than one of them a sentence later and the
  // other nowhere.
  autoModePolicy: {
    kind: "row",
    group: "autoMode",
    search: { contributesTo: "page" },
    label: "Auto mode policy",
    description:
      "Extra rules for Traycer's judge: what this machine is, what to approve without asking, and what to never approve. Stored on your account, so Traycer's judge picks it up on every machine. A repository with a .traycer/auto-policy.md file uses that file instead, and a provider set to use its own classifier (Settings ▸ Providers) doesn't follow a policy at all.",
    availableWhen: alwaysAvailable,
    keywords: [
      "auto mode",
      "policy",
      "rules",
      "allow",
      "deny",
      "approve without asking",
      "auto-policy.md",
    ],
  },
  autoModeShippedRules: {
    kind: "row",
    group: "autoMode",
    search: { contributesTo: "page" },
    label: "What the judge already blocks",
    description:
      "Traycer's own rules, before any policy of yours: what it allows without asking, what it always asks you about, and what your policy cannot turn off. The same on every machine.",
    availableWhen: alwaysAvailable,
    keywords: [
      "auto mode",
      "judge",
      "built-in rules",
      "default rules",
      "always asks",
      "blocked",
    ],
  },
});
