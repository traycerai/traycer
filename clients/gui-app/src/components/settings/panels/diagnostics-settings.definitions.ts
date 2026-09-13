import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// The Log detail card is dropped for a host too old to answer the log-level
// RPC, so it and its rows fold into the page.
export const HOST_DIAGNOSTICS = defineSettingsSection("diagnostics", {
  page: {
    label: "Diagnostics",
    description:
      "Log verbosity and recent log output for the host selected above.",
    keywords: [
      "logs",
      "debug",
      "verbose",
      "troubleshoot",
      "host",
      "cli",
      "support",
      "log file",
      "log detail",
      "log level",
      "cli log level",
      "host log level",
      "verbosity",
      "trace",
      "logging",
    ],
  },
  logDetail: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Log detail",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // Both rows are named per machine, not per host: the store is
  // `~/.traycer/cli/config.json`, shared by every Traycer host environment
  // this OS user runs.
  cliLogLevel: {
    kind: "row",
    group: "logDetail",
    search: { contributesTo: "page" },
    label: "CLI log level",
    description:
      "Verbosity of the Traycer CLI's logs. Applies to every Traycer host environment on this machine.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  hostLogLevel: {
    kind: "row",
    group: "logDetail",
    search: { contributesTo: "page" },
    label: "Host log level",
    description:
      "Verbosity of the background host process's logs. Applies to every Traycer host environment on this machine.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
