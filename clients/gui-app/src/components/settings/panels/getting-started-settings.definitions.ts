import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * One row per checklist card. The cards are bespoke buttons rather than
 * `SettingsRow`s, but their copy is still searchable copy, so it is written
 * here once and the panel renders from it.
 *
 * Only the tour owns an ENTRY. It used to be General's "Product tour" row and
 * took that row's words and anchor with it when it moved, so a search for
 * "walkthrough" has to land on the card that replays it. The three guide
 * cards contribute to the page instead: each one names a settings page that
 * has its own entry already ("Agent selection" is the Agents page's own
 * label), and a second result under the same name would outrank the page a
 * person typing it actually wants.
 */
export const GETTING_STARTED = defineSettingsSection("getting-started", {
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
