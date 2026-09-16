import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * Page-only, like `LINK_PHONE`: the panel is two paragraphs and one action,
 * with no row or group a query could usefully land ON, so it writes no anchor
 * and the section entry is the whole destination.
 *
 * The keywords are the words someone reaches for when they are trying to
 * leave. "Close account", "remove account" and "cancel" are not what the page
 * is called, which is exactly why they are here - a search surface that only
 * matches its own title is one a person in this mood will not find.
 */
export const DELETE_ACCOUNT = defineSettingsSection("delete-account", {
  page: {
    label: "Delete account",
    description:
      "Permanently delete your Traycer account and all associated data.",
    keywords: [
      "delete",
      "remove",
      "close",
      "cancel",
      "account",
      "data",
      "erase",
      "gdpr",
      "privacy",
    ],
  },
});
