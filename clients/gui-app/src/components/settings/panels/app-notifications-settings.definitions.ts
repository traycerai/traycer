import {
  alwaysAvailable,
  isSoundtrackRowAvailable,
} from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// The Sounds page. Its id still says notifications because ids are a
// compatibility surface (see the section table in `lib/settings-sections.ts`).
export const APP_NOTIFICATIONS = defineSettingsSection("app-notifications", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Sounds",
    description: "Which chime plays for each kind of alert.",
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
  soundtrack: {
    kind: "group",
    search: { anchor: "sounds-soundtrack" },
    label: "Soundtrack",
    description: null,
    breadcrumb: null,
    availableWhen: isSoundtrackRowAvailable,
    keywords: ["music", "ambient"],
  },
  soundtrackVolume: {
    kind: "row",
    group: "soundtrack",
    search: { anchor: "sounds-soundtrack-volume" },
    label: "Volume",
    description: "How loud the music plays.",
    availableWhen: isSoundtrackRowAvailable,
    keywords: ["music", "loudness"],
  },
  soundtrackDirector: {
    kind: "row",
    group: "soundtrack",
    search: { anchor: "sounds-soundtrack-director" },
    label: "Follows",
    description: "What the music changes with.",
    availableWhen: isSoundtrackRowAvailable,
    keywords: ["music", "activity"],
  },
});
