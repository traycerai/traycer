import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const SECRETS = defineSettingsSection("secrets", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Secrets",
    description: "Keys and logins your agents use.",
    keywords: [
      "secret",
      "api key",
      "token",
      "credential",
      "github",
      "password",
    ],
  },
  dashboard: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Secrets",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // Gated on the SHELL: with no platform origin to name the link renders
  // nothing, so the row folds into the page.
  manageSecrets: {
    kind: "row",
    group: "dashboard",
    search: { contributesTo: "page" },
    label: "Manage secrets",
    description:
      "Add, replace or remove the keys your agents use, and connect GitHub. Opens in your browser.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
