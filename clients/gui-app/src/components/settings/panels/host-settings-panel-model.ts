import type {
  CliInstallManifestSnapshot,
  HostAvailableSnapshot,
  HostInstalledRecord,
  HostRegistryUpdateState,
  LocalHostSnapshot,
  MutationLaneStatus,
  ServiceStatusSnapshot,
} from "@traycer-clients/shared/platform/runner-host";

export const VERSION_LIST_PREVIEW = 10;

// Renderer-facing alias so call sites don't reach for the wire type name
// directly - this is the canonical mutation-lane status the progress banner
// renders, unchanged in shape from `MutationLaneStatus`.
export type HostProgressState = MutationLaneStatus;

/**
 * The name triple, as either source states it.
 *
 * `HostNameSettings` (the local CLI bridge) and `HostIdentity` (the host's own
 * `host.identity.get`) are the same three fields, which is not a coincidence —
 * the host took over the file the bridge used to own. Naming the shape lets one
 * edit form serve both the RPC page and the recovery console instead of
 * cloning it per transport.
 */
export interface HostDisplayIdentity {
  readonly systemName: string;
  readonly customName: string | null;
  readonly effectiveName: string;
}

/**
 * The string an untouched name form opens with, and the baseline its dirtiness
 * is measured against — derived ONCE, for both transports.
 *
 * It existed twice, and the two copies did not agree: the bridge card seeded
 * `customName ?? systemName` while the RPC page seeded `customName ??
 * effectiveName`. That only looks equivalent under the unwritten assumption
 * that `effectiveName === customName ?? systemName`, which is exactly what a
 * PROVISIONED host breaks — its effective name folds a registration label, so
 * the two seeds differ and an untouched form reads as dirty on one path.
 *
 * `effectiveName` is the correct fallback: it is the name the host actually
 * publishes, so an unnamed provisioned host opens showing its label rather
 * than a hostname nobody chose.
 */
export function persistedDraftFromIdentity(
  // Both absences, because the two transports spell it differently: the bridge
  // card holds `undefined` while the RPC view holds `null`. Widening here beats
  // making one call site launder its own value.
  identity: HostDisplayIdentity | null | undefined,
): string {
  if (identity === null || identity === undefined) return "";
  return identity.customName ?? identity.effectiveName;
}

/**
 * The BRIDGE path's draft rule, used only by the recovery console.
 *
 * Typing the machine's own name means "clear the override", which is correct
 * here and only here: the bridge writes this computer's name file, and a
 * desktop host on this computer registers under `os.hostname()` — so clearing
 * lands back on exactly the string that was typed.
 *
 * The RPC path deliberately does NOT share this rule — see
 * `customNameFromIdentityDraft`, which explains what breaks when a host was
 * started with a registration label that is not its hostname.
 */
export function customNameFromDraft(
  draftName: string,
  settings: HostDisplayIdentity | undefined,
): string | null {
  const normalized = draftName.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  if (settings !== undefined && normalized === settings.systemName) {
    return null;
  }
  return normalized;
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

// `formatProgressKind` / `formatTransfer` / `formatBytes` lived here and are
// DELETED, not moved with a re-export (F19). They were this file's private
// answer to "what is the host controller doing, and how big is it" - the boot
// surface had its own, and the two disagreed on both the wording and the unit.
// The one answer is `@/lib/host/host-progress-copy`, which every surface now
// reads; a shim here would be exactly the second table that let them drift.

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
