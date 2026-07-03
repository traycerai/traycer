import type {
  CliInstallManifestSnapshot,
  HostAvailableSnapshot,
  HostInstalledRecord,
  HostOperationKind,
  HostProgressEvent,
  HostRegistryUpdateState,
  LocalHostSnapshot,
  ServiceStatusSnapshot,
} from "@traycer-clients/shared/platform/runner-host";

export const VERSION_LIST_PREVIEW = 10;

export interface HostProgressState {
  readonly kind: HostOperationKind;
  readonly event: HostProgressEvent;
}

export function deriveStatus(
  localHost: LocalHostSnapshot | null,
  installedRecord: HostInstalledRecord | null | undefined,
): ServiceStatusSnapshot | undefined {
  if (localHost !== null) {
    return {
      state: "running",
      version: localHost.version,
      listenUrl: localHost.websocketUrl,
      pid: localHost.pid,
    };
  }
  if (installedRecord === undefined) return undefined;
  if (installedRecord !== null) {
    return {
      state: "stopped",
      version: installedRecord.version,
      listenUrl: null,
      pid: null,
    };
  }
  return {
    state: "not-installed",
    version: null,
    listenUrl: null,
    pid: null,
  };
}

export function statusLabel(state: ServiceStatusSnapshot["state"]): string {
  switch (state) {
    case "running":
      return "● Running";
    case "stopped":
      return "○ Stopped";
    case "not-installed":
      return "Not installed";
  }
}

export function statusColorClass(
  state: ServiceStatusSnapshot["state"],
): string {
  switch (state) {
    case "running":
      return "text-emerald-500";
    case "stopped":
      return "text-amber-500";
    case "not-installed":
      return "text-muted-foreground";
  }
}

export function statusDescription(
  state: ServiceStatusSnapshot["state"] | undefined,
): string {
  switch (state) {
    case "running":
      return "Host is running locally and reachable.";
    case "stopped":
      return "Installed, but the host process isn't running.";
    case "not-installed":
      return "No host is installed on this machine yet.";
    case undefined:
      return "Checking the local host…";
  }
}

export function serviceDescription(
  state: ServiceStatusSnapshot["state"] | undefined,
): string {
  if (state === undefined) {
    return "Checking service registration…";
  }
  if (state === "not-installed") {
    return "Not registered. The OS service manifest is required for the host to survive logout.";
  }
  return "Registered. The OS service manifest starts the host at user login.";
}

export function updatesDescription(args: {
  readonly registryState: HostRegistryUpdateState | undefined;
  readonly registryFetching: boolean;
  readonly latestReleasedAt: string | null;
  readonly nowMs: number;
}): string {
  const { registryState, registryFetching, latestReleasedAt, nowMs } = args;
  if (registryState !== undefined && registryState.updateAvailable) {
    if (latestReleasedAt !== null) {
      return `Released ${formatReleaseAge(latestReleasedAt, nowMs)}.`;
    }
    return "A newer host is available.";
  }
  if (registryState !== undefined && !registryState.reachable) {
    const errorMessage = registryState.errorMessage;
    if (errorMessage !== null && errorMessage.length > 0) {
      return truncateLine(errorMessage, 140);
    }
    return "Update check unavailable.";
  }
  if (registryFetching && registryState === undefined) {
    return "Checking for updates…";
  }
  if (registryState?.checkedAt) {
    return `Last checked ${formatReleaseAge(registryState.checkedAt, nowMs)}.`;
  }
  return "Check for host updates.";
}

function truncateLine(value: string, maxLength: number): string {
  const oneLine = value.split(/\r?\n/)[0] ?? "";
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, maxLength - 1)}…`;
}

export function extractErrorMessage(
  queryError: Error | null,
  registryState: HostRegistryUpdateState | undefined,
): string | null {
  if (queryError !== null) return truncateLine(queryError.message, 200);
  if (registryState !== undefined && !registryState.reachable) {
    const message = registryState.errorMessage;
    if (message !== null && message.length > 0) {
      return truncateLine(message, 200);
    }
    return "Registry unreachable.";
  }
  return null;
}

export function formatCheckedAtTooltip(checkedAt: string | null): string {
  if (checkedAt === null) return "Never checked";
  return `Last checked ${new Date(checkedAt).toLocaleString()}`;
}

export function formatInstallDate(iso: string): string {
  if (iso.length === 0) return "unknown";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

function formatReleaseAge(releasedAt: string, nowMs: number): string {
  if (releasedAt.length === 0) return "recently";
  const releasedMs = new Date(releasedAt).getTime();
  if (Number.isNaN(releasedMs)) return "recently";
  const diffSeconds = Math.max(0, (nowMs - releasedMs) / 1000);
  const minute = 60;
  const hour = 3600;
  const day = 86400;
  if (diffSeconds < minute) return "just now";
  if (diffSeconds < hour) return `${Math.floor(diffSeconds / minute)}m ago`;
  if (diffSeconds < day) return `${Math.floor(diffSeconds / hour)}h ago`;
  if (diffSeconds < 7 * day) return `${Math.floor(diffSeconds / day)}d ago`;
  if (diffSeconds < 30 * day) {
    return `${Math.floor(diffSeconds / (7 * day))}w ago`;
  }
  if (diffSeconds < 365 * day) {
    return `${Math.floor(diffSeconds / (30 * day))}mo ago`;
  }
  return `${Math.floor(diffSeconds / (365 * day))}y ago`;
}

export function findReleasedAt(
  snapshot: HostAvailableSnapshot | undefined,
  latestVersion: string | null,
): string | null {
  if (snapshot === undefined) return null;
  if (latestVersion === null) return null;
  const match = snapshot.versions.find(
    (entry) => entry.version === latestVersion,
  );
  return match === undefined ? null : match.releasedAt;
}

export function formatSource(source: HostInstalledRecord["source"]): string {
  if (source.kind === "registry") {
    return source.value.length > 0 ? `Registry · ${source.value}` : "Registry";
  }
  return source.value.length > 0
    ? `Local file · ${source.value}`
    : "Local file";
}

export function formatProgressKind(kind: HostOperationKind): string {
  switch (kind) {
    case "install":
      return "Installing host";
    case "update":
      return "Updating host";
    case "register-service":
      return "Registering service";
    case "ensure":
      return "Setting up host";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  const gib = mib / 1024;
  return `${gib.toFixed(2)} GiB`;
}

export function formatTransfer(
  bytes: number | null,
  totalBytes: number | null,
): string | null {
  if (bytes === null && totalBytes === null) return null;
  if (bytes !== null && totalBytes !== null && totalBytes > 0) {
    return `${formatBytes(bytes)} / ${formatBytes(totalBytes)}`;
  }
  if (bytes !== null) return formatBytes(bytes);
  if (totalBytes !== null) return formatBytes(totalBytes);
  return null;
}

export function formatPackageManagerSource(
  source: NonNullable<
    CliInstallManifestSnapshot["packageManagerUpgrade"]
  >["source"],
): string {
  switch (source) {
    case "homebrew":
      return "Homebrew";
    case "npm":
      return "npm";
    case "winget":
      return "winget";
    case "scoop":
      return "Scoop";
    case "apt":
      return "apt";
    case "rpm":
      return "rpm";
  }
}
