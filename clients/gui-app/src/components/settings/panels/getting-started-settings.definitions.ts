import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * One row per checklist card. The cards are bespoke buttons rather than
 * `SettingsRow`s, but their copy is still searchable copy, so it is written
 * here once and the panel renders from it.
 *
 * Provider and secret name pages that already have their own entries, so they
 * contribute to this page rather than competing with Providers and Secrets.
 * Start a task and the download card have no other home, so each owns an
 * entry. Credits contributes too: Account ▸ Credits is the page that owns
 * those words once E4's section is on the index.
 */
export const GETTING_STARTED = defineSettingsSection("getting-started", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Getting started",
    description: "The first things to do.",
    keywords: ["onboarding", "setup", "guide", "checklist"],
  },
  provider: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Add a key or sign in to a coding agent",
    description: "So a coding agent can run.",
    availableWhen: alwaysAvailable,
    keywords: ["provider", "api key", "coding agent", "sign in"],
  },
  task: {
    kind: "row",
    group: null,
    search: { anchor: "getting-started-start-task" },
    label: "Start a task",
    description: "Begin a piece of work.",
    availableWhen: alwaysAvailable,
    keywords: ["task", "epic", "new task"],
  },
  secret: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Add a secret if agents need one",
    description: "A deploy key or a login.",
    availableWhen: alwaysAvailable,
    keywords: ["secret", "deploy key", "login"],
  },
  install: {
    kind: "row",
    group: null,
    search: { anchor: "getting-started-install" },
    label: "Install Traycer on another computer",
    description: "The download page.",
    availableWhen: alwaysAvailable,
    keywords: ["download", "install", "another computer", "desktop"],
  },
  credits: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Add credits",
    description: "Credits pay for your sandboxes.",
    availableWhen: alwaysAvailable,
    keywords: ["credits", "billing", "sandbox"],
  },
});
