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
    description: "So your settings follow you to it.",
    availableWhen: alwaysAvailable,
    keywords: ["download", "install", "another computer", "desktop"],
  },
  credits: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Add credits",
    description: "Credits pay for your sandboxes, awake or resting.",
    availableWhen: alwaysAvailable,
    keywords: ["credits", "billing", "sandbox"],
  },
});

/**
 * The 1.5.1 checklist, which a build without environments
 * (`unreleased-features.ts`) keeps: the tour and the three setup guides
 * (`getting-started-guides-checklist.ts`).
 *
 * Only the tour owns an ENTRY. It used to be General's "Product tour" row and
 * took that row's words and anchor with it when it moved, so a search for
 * "walkthrough" has to land on the card that replays it. The three guide
 * cards contribute to the page instead: each one names a settings page that
 * has its own entry already ("Agent selection" is the Agents page's own
 * label), and a second result under the same name would outrank the page a
 * person typing it actually wants.
 */
export const GETTING_STARTED_GUIDES = defineSettingsSection("getting-started", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Getting started",
    description: "Your introduction and setup guides.",
    keywords: [
      "onboarding",
      "setup",
      "tour",
      "replay",
      "tutorial",
      "guide",
      "agent selection",
      "appearance",
      "customization",
      "browser cookies",
      "import logins",
    ],
  },
  productTour: {
    kind: "row",
    group: null,
    search: { anchor: "getting-started-product-tour" },
    label: "Initial tour",
    description: "Your workspace, providers, and tasks.",
    availableWhen: alwaysAvailable,
    keywords: [
      "product tour",
      "tour",
      "walkthrough",
      "replay",
      "welcome",
      "first run",
      "intro",
    ],
  },
  agentSelection: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Agent selection",
    description: "Choose how agents delegate work.",
    availableWhen: alwaysAvailable,
    keywords: ["agents", "harness", "model", "delegation", "instructions"],
  },
  appearanceAndLayout: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Appearance and layout",
    description: "Theme, start page, fonts, and layout.",
    availableWhen: alwaysAvailable,
    keywords: ["theme", "wallpaper", "fonts", "density", "sidebar"],
  },
  browserSignIns: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Browser sign-ins",
    description: "Bring your cookies from another browser.",
    availableWhen: alwaysAvailable,
    keywords: ["cookies", "logins", "sessions", "import", "browser"],
  },
});
