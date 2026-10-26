import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// The Sounds page. Its id still says notifications because ids are a
// compatibility surface (see the section table in `lib/settings-sections.ts`).
export const APP_NOTIFICATIONS = defineSettingsSection("app-notifications", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Sounds",
    description: "Which chime plays for each kind of alert, across hosts.",
    keywords: ["sound", "chime", "audio", "beep", "volume", "mute", "ding"],
  },
  // The chime card shows no heading — the page already names it — so it is not
  // a destination of its own; it and its rows fold into the page.
  chimes: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Chimes",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  chimeNeedsAction: {
    kind: "row",
    group: "chimes",
    search: { contributesTo: "page" },
    label: "Needs action",
    description: "Approvals and interviews.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  chimeFailure: {
    kind: "row",
    group: "chimes",
    search: { contributesTo: "page" },
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  chimeDone: {
    kind: "row",
    group: "chimes",
    search: { contributesTo: "page" },
    label: "Done",
    description: "Completed or intentionally stopped turns.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  chimeInfo: {
    kind: "row",
    group: "chimes",
    search: { contributesTo: "page" },
    label: "Info",
    description:
      "Sharing, comments, access changes, and other informational notifications.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
