import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const APP_DIAGNOSTICS = defineSettingsSection("app-diagnostics", {
  page: {
    label: "Diagnostics",
    description:
      "Logging and memory capture for the Traycer app itself - this window, whichever host it points at.",
    keywords: [
      "logs",
      "debug",
      "troubleshoot",
      "verbose",
      "renderer",
      "app",
      "support",
    ],
  },
  logDetail: {
    kind: "group",
    search: { anchor: "app-diagnostics-log-detail" },
    label: "Log detail",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["verbosity", "level", "debug", "trace", "logging", "info"],
  },
  // Rendered only with the desktop log-levels bridge, which the availability
  // context does not model, so it folds into the card that always renders.
  appLogLevel: {
    kind: "row",
    group: "logDetail",
    search: { contributesTo: "logDetail" },
    label: "App log level",
    description:
      "Verbosity of the desktop app's own logs. Applies to this app, not to a host.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  memory: {
    kind: "group",
    search: { anchor: "app-diagnostics-memory" },
    label: "Memory",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["heap", "ram", "leak", "usage", "snapshot"],
  },
});
