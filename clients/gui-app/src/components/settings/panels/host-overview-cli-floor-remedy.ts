import {
  PACKAGE_MANAGER_UPGRADE_COMMAND,
  type CliInstallSource,
} from "@traycer/protocol/config/installation-records";
import { compareHostVersions } from "@traycer-clients/shared/host-version/compare-host-versions";
import type { DesktopAppUpdateSnapshot } from "@/lib/windows/types";

// There is deliberately no terminal action: a 1.2.0 host ignores shellCommand
// on ordinary terminal creates. Copying the recorded binary path works on the
// hosts this remedy actually serves, without guessing what is on their PATH.
export const CLI_FLOOR_REMEDY_ACTION_KINDS = [
  "desktop-download",
  "desktop-progress",
  "desktop-install",
  "desktop-check",
  "restart-desktop-hint",
  "copy-command",
  "help",
] as const;

export type CliFloorRemedyActionKind =
  (typeof CLI_FLOOR_REMEDY_ACTION_KINDS)[number];

interface CliFloorRemedyActionPayloads {
  readonly "desktop-download": {
    readonly label: string;
    readonly disabled: boolean;
    readonly tooltip: string | null;
  };
  readonly "desktop-progress": { readonly label: string };
  readonly "desktop-install": {
    readonly label: string;
    readonly disabled: boolean;
    readonly tooltip: string | null;
    readonly showGuidance: boolean;
    readonly installInFlight: boolean;
  };
  readonly "desktop-check": {
    readonly label: string | null;
    readonly checkOnMount: boolean;
  };
  readonly "restart-desktop-hint": unknown;
  readonly "copy-command": {
    readonly label: string;
    readonly command: string;
  };
  readonly help: { readonly label: string };
}

export type CliFloorRemedyAction = {
  [Kind in CliFloorRemedyActionKind]: {
    readonly kind: Kind;
  } & CliFloorRemedyActionPayloads[Kind];
}[CliFloorRemedyActionKind];

export interface CliFloorRemedy {
  readonly sentence: string;
  readonly actions: readonly CliFloorRemedyAction[];
}

export interface CliFloorRemedyInput {
  readonly isLocalMachine: boolean;
  readonly platform: string | null;
  readonly cliSource: CliInstallSource | null;
  readonly cliBinaryPath: string | null;
  readonly cliVersion: string | null;
  readonly requiredCliVersion: string | null;
  readonly desktopUpdate: DesktopAppUpdateSnapshot | null;
  readonly hostName: string;
}

/** Called only after the executing CLI has refused the projected asset. */
export function describeCliFloorRemedy(
  input: CliFloorRemedyInput,
): CliFloorRemedy {
  if (input.cliSource === null) {
    return {
      sentence: `Traycer couldn't determine how its command-line tools were installed on ${input.hostName}.`,
      actions: [{ kind: "help", label: "Show installation help" }],
    };
  }
  if (
    input.isLocalMachine &&
    input.cliSource === "desktop" &&
    input.desktopUpdate !== null
  ) {
    return describeDesktopRemedy(input.desktopUpdate, input);
  }
  if (input.cliSource !== "desktop" && input.cliSource !== "manual") {
    const command = PACKAGE_MANAGER_UPGRADE_COMMAND[input.cliSource];
    return describeCopyRemedy(
      input,
      `On ${input.hostName}, run this command to prepare the host update: ${command}. Then select Check now.`,
      command,
      "Copy command",
    );
  }
  // Unknown platforms take the Windows-safe route too. The old Windows CLI
  // finalizes its staged upgrade during host restart, whose taskkill /T would
  // kill that very CLI if the command ran in a Traycer-hosted terminal.
  if (input.platform === null || input.platform.startsWith("win32")) {
    return describeCopyRemedy(
      input,
      `Run traycer cli upgrade on ${input.hostName}, then traycer host restart, from a terminal outside Traycer on that machine (an SSH session or a Windows Terminal window there). Restarting briefly disconnects this host. When it reconnects, select Check now, then Update now.`,
      "traycer cli upgrade\ntraycer host restart",
      "Copy commands",
    );
  }
  return describeCopyRemedy(
    input,
    `First update Traycer's command-line tools on ${input.hostName}. Open a terminal on that machine and run the copied command. When it finishes, come back here: this page rechecks while it is open, and Update now appears once the host accepts the update.`,
    posixCliUpgradeCommand(input.cliBinaryPath),
    "Copy command",
  );
}

function describeDesktopRemedy(
  snapshot: DesktopAppUpdateSnapshot,
  input: CliFloorRemedyInput,
): CliFloorRemedy {
  const fallback = describeDesktopFloorFallbackFor(snapshot, input);
  if (fallback !== null) return fallback;
  const version = snapshot.latestVersion ?? input.requiredCliVersion;
  switch (snapshot.status) {
    case "available":
      return {
        sentence: `Update Traycer Desktop${version === null ? "" : ` to ${version}`} to install this host update.`,
        actions: [
          {
            kind: "desktop-download",
            label: "Download update",
            disabled: snapshot.installBlockedReason !== null,
            tooltip: snapshot.installBlockedReason,
          },
        ],
      };
    case "downloading":
      return {
        sentence: "Downloading the Traycer Desktop update…",
        actions: [
          {
            kind: "desktop-progress",
            label:
              snapshot.downloadProgress === null
                ? "Downloading update"
                : `Downloading ${snapshot.downloadProgress}%`,
          },
        ],
      };
    case "ready":
      return describeDesktopReady(snapshot, version);
    case "up-to-date":
      return {
        sentence:
          "Traycer Desktop is up to date, but this computer still needs to finish updating its host tools. Restart Traycer Desktop to finish.",
        actions: [{ kind: "restart-desktop-hint" }],
      };
    case "error":
    case "unavailable":
      return describeDesktopCheckFailed(snapshot);
    case "idle":
      return {
        sentence: "Check for a Traycer Desktop update.",
        actions: [{ kind: "desktop-check", label: null, checkOnMount: true }],
      };
    case "checking":
      return {
        sentence: "Checking for a Traycer Desktop update…",
        actions: [{ kind: "desktop-check", label: null, checkOnMount: false }],
      };
  }
}

function describeDesktopReady(
  snapshot: DesktopAppUpdateSnapshot,
  version: string | null,
): CliFloorRemedy {
  // Same precedence as the header: a blocked location wins over manual
  // install guidance, and main's in-flight snapshot disarms every surface.
  const showGuidance =
    snapshot.installBlockedReason === null && snapshot.installGuidance !== null;
  return {
    sentence: `Traycer Desktop${version === null ? "" : ` ${version}`} is ready. Restart Traycer to finish, then this host update can install.`,
    actions: [
      {
        kind: "desktop-install",
        label: showGuidance ? "Finish update" : "Restart to update",
        disabled:
          snapshot.installBlockedReason !== null || snapshot.installInFlight,
        tooltip: snapshot.installBlockedReason,
        showGuidance,
        installInFlight: snapshot.installInFlight,
      },
    ],
  };
}

function describeDesktopCheckFailed(
  snapshot: DesktopAppUpdateSnapshot,
): CliFloorRemedy {
  return {
    sentence:
      snapshot.errorMessage?.trim() ||
      "Traycer Desktop couldn't check for updates.",
    actions: [
      { kind: "desktop-check", label: "Check again", checkOnMount: false },
      { kind: "help", label: "Show installation help" },
    ],
  };
}

// Desktop and its bundled CLI share a version. Downloading or restarting a
// stable build below an RC host's floor would leave the same refusal. When no
// update is offered, a restart runs the installed Desktop, and the feed's
// latest version may be older than it (for example after leaving RCs).
function describeDesktopFloorFallbackFor(
  snapshot: DesktopAppUpdateSnapshot,
  input: CliFloorRemedyInput,
): CliFloorRemedy | null {
  switch (snapshot.status) {
    case "available":
    case "downloading":
    case "ready":
      return describeDesktopFloorFallback(input, snapshot.latestVersion);
    case "up-to-date":
      return describeDesktopFloorFallback(input, snapshot.currentVersion);
    default:
      return null;
  }
}

function describeDesktopFloorFallback(
  input: CliFloorRemedyInput,
  candidate: string | null,
): CliFloorRemedy | null {
  const { requiredCliVersion } = input;
  if (requiredCliVersion === null) return null;
  const comparison =
    candidate === null
      ? null
      : compareHostVersions(candidate, requiredCliVersion);
  if (
    comparison !== null &&
    comparison.comparable &&
    comparison.ordering !== "less"
  ) {
    return null;
  }
  const versionDescription =
    input.desktopUpdate?.status === "up-to-date"
      ? `Traycer Desktop v${candidate} is installed`
      : `Traycer v${candidate} is the latest on this update channel`;
  const sentence =
    comparison !== null && comparison.comparable
      ? `${versionDescription} and its command-line tools are below ${requiredCliVersion}.`
      : `Traycer couldn't verify that this Desktop update includes Traycer CLI ${requiredCliVersion} or newer.`;
  // A Desktop-owned CLI may have a separate recorded binary. Only reuse the
  // model's existing absolute POSIX path route; guessing PATH could upgrade
  // another copy and leave this host refused by the same bundled CLI.
  const command =
    input.platform !== null &&
    !input.platform.startsWith("win32") &&
    input.cliBinaryPath !== null &&
    input.cliBinaryPath.startsWith("/")
      ? posixCliUpgradeCommand(input.cliBinaryPath)
      : null;
  const help: CliFloorRemedyAction = {
    kind: "help",
    label: "Show installation help",
  };
  return {
    sentence:
      command === null
        ? sentence
        : `${sentence} Open a terminal on ${input.hostName} and run the copied command, then select Check now.`,
    actions:
      command === null
        ? [help]
        : [{ kind: "copy-command", label: "Copy command", command }, help],
  };
}

function describeCopyRemedy(
  input: CliFloorRemedyInput,
  sentence: string,
  command: string,
  label: string,
): CliFloorRemedy {
  const comparison =
    input.cliVersion === null || input.requiredCliVersion === null
      ? null
      : compareHostVersions(input.cliVersion, input.requiredCliVersion);
  const olderCopy =
    comparison !== null &&
    comparison.comparable &&
    comparison.ordering !== "less";
  return {
    sentence: olderCopy
      ? `Traycer's command-line tools on ${input.hostName} were updated, but the host is still using an older copy. Run the command again: ${sentence}`
      : sentence,
    actions: [{ kind: "copy-command", label, command }],
  };
}

function posixCliUpgradeCommand(binaryPath: string | null): string {
  if (binaryPath === null || !binaryPath.startsWith("/")) {
    return "traycer cli upgrade";
  }
  // A path is one shell token. Double quotes would still expand dollars and
  // backticks; single quotes with escaped apostrophes keep every byte literal.
  return `'${binaryPath.replaceAll("'", "'\\''")}' cli upgrade`;
}
