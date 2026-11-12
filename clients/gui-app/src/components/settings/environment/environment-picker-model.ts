import {
  SETUP_STEPS,
  setupView,
} from "@/components/settings/host-scope/host-access-model";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import {
  localRowCohort,
  type LocalRowVerb,
} from "@/components/settings/environment/local-row-cohort";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";

/** The tooltip on every `Local` badge. */
export const LOCAL_BADGE_TOOLTIP = "Settings on this computer only";

export function needsUpdateSubtitle(hostName: string): string {
  return `${hostName} needs an update to show its settings here.`;
}

/** A computer with its own settings or unfinished setup. */
export interface LocalPickerRow {
  readonly kind: "local" | "setup";
  readonly hostId: string;
  readonly name: string;
  readonly subtitle: string;
  readonly verb: LocalRowVerb | null;
  /** A host too old to show its settings here: greyed, not pickable. */
  readonly needsUpdate: boolean;
  readonly defaultsToLocal: boolean;
}

export interface EnvironmentPickerHost {
  readonly hostId: string;
  readonly name: string;
}

export interface EnvironmentPickerModel {
  readonly localRows: readonly LocalPickerRow[];
  /** What the window opens on when the person has picked nothing. */
  readonly defaultPick: EnvironmentPick;
}

/**
 * The computers the Environment group reads `environment.status` from. This
 * window's own computer always counts: a new computer registers with remote
 * access off, and the account's host list leaves such a host out, so registry
 * membership would hide it until its settings had moved. Any other computer
 * counts once the account lists it, since an unlisted one cannot be reached
 * from this window. A sandbox never counts: it is created on a
 * configuration's settings and has none of its own to move.
 */
export function isEnvironmentComputer(
  host: Pick<HostScopeOption, "isLocalMachine" | "registered" | "sandbox">,
): boolean {
  return host.sandbox === null && (host.isLocalMachine || host.registered);
}

/**
 * A computer's own-settings or setup row, from `environment.status` and
 * the version negotiated for that method, or `null` for none.
 *
 * A Local row exists while any plane is still this computer's own or stopped,
 * and its wording comes from those planes (`localRowCohort`). An unfinished
 * setup with no known configuration keeps a separate setup row, so the person
 * can still open the computer and finish or retry it. A host whose
 * `environment.status` predates 1.1 reports no
 * planes at all, so one that has not reached `applying` gets the greyed
 * `needs an update` row instead; one that has is already shared and has no
 * row. A host that has not answered, or not been dialled, has no row:
 * nothing is known about it.
 */
export function localPickerRow(
  host: EnvironmentPickerHost,
  status: EnvironmentStatusResponseV11 | null,
  version: NegotiatedMethodVersion,
): LocalPickerRow | null {
  if (isBeforeConsentGate(version)) {
    return isUnmovedOldHost(status, version) ? needsUpdateRow(host) : null;
  }
  if (status === null) return null;
  const cohort = localRowCohort(status);
  if (cohort.kind === "none") {
    const setup = unresolvedSetupText(status);
    return setup === null
      ? null
      : {
          kind: "setup",
          hostId: host.hostId,
          name: host.name,
          subtitle: setup,
          verb: null,
          needsUpdate: false,
          defaultsToLocal: true,
        };
  }
  return {
    kind: "local",
    hostId: host.hostId,
    name: host.name,
    subtitle: cohort.subtitle,
    verb: cohort.verb,
    needsUpdate: false,
    defaultsToLocal: cohort.defaultsToLocal,
  };
}

/** An unfinished setup that cannot yet identify its configuration. */
export function unresolvedSetupText(
  status: EnvironmentStatusResponseV11,
): string | null {
  if (status.principal !== null || localRowCohort(status).kind !== "none")
    return null;
  const setup = setupView(status.setup);
  if (setup === null) return null;
  return setup.kind === "stopped"
    ? setup.text
    : (SETUP_STEPS[setup.stepIndex]?.label ?? "Setting up this computer");
}

/**
 * Whether `host` runs Personal: it reports Personal as its configuration and
 * has no Local row. The dropdown lists it under Personal by this rule, and a
 * Personal page reads that host's own pages only when the window's host
 * passes it.
 */
export function hostRunsPersonal(
  host: EnvironmentPickerHost,
  status: EnvironmentStatusResponseV11 | null,
  version: NegotiatedMethodVersion,
): boolean {
  return (
    status?.principal?.kind === "personal" &&
    localPickerRow(host, status, version) === null
  );
}

/** An old host that has not reached `applying`: it has not moved. */
function isUnmovedOldHost(
  status: EnvironmentStatusResponseV11 | null,
  version: NegotiatedMethodVersion,
): boolean {
  if (version === false || status === null || status.setup === null) {
    return true;
  }
  const { stage } = status.setup;
  return stage === "registering" || stage === "moving_settings";
}

function needsUpdateRow(host: EnvironmentPickerHost): LocalPickerRow {
  return {
    kind: "local",
    hostId: host.hostId,
    name: host.name,
    subtitle: "Update to view these settings.",
    verb: null,
    needsUpdate: true,
    defaultsToLocal: false,
  };
}

/**
 * `environment.status` below 1.1: the host predates the move's consent gate.
 * `null` (no handshake yet) is not "too old": nothing is known.
 */
function isBeforeConsentGate(version: NegotiatedMethodVersion): boolean {
  if (version === null) return false;
  if (version === false) return true;
  return version.major < 1 || (version.major === 1 && version.minor < 1);
}

/**
 * `your settings · on MacBook Pro, dev-box`: the hosts running Personal
 * (`useHostsRunningPersonal`), two named, the rest counted, or `· not on any
 * computer or sandbox` while none does.
 */
export function personalSubtitle(names: readonly string[]): string {
  if (names.length === 0)
    return "your settings · not on any computer or sandbox";
  const [first, second] = names;
  if (names.length === 1) return `your settings · on ${first}`;
  const rest = names.length - 2;
  return rest === 0
    ? `your settings · on ${first}, ${second}`
    : `your settings · on ${first}, ${second} and ${rest} more`;
}

export function environmentPickerModel(input: {
  readonly hosts: readonly EnvironmentPickerHost[];
  readonly statuses: ReadonlyMap<string, EnvironmentStatusResponseV11 | null>;
  readonly versions: ReadonlyMap<string, NegotiatedMethodVersion>;
  /** This window's own host, whose Local row is the default pick. */
  readonly windowHostId: string | null;
}): EnvironmentPickerModel {
  const localRows: LocalPickerRow[] = [];
  for (const host of input.hosts) {
    const row = localPickerRow(
      host,
      input.statuses.get(host.hostId) ?? null,
      input.versions.get(host.hostId) ?? null,
    );
    if (row !== null) localRows.push(row);
  }
  const windowRow =
    localRows.find((row) => row.hostId === input.windowHostId) ?? null;
  return {
    localRows,
    defaultPick:
      windowRow !== null && !windowRow.needsUpdate && windowRow.defaultsToLocal
        ? { kind: "local", hostId: windowRow.hostId, hostName: windowRow.name }
        : PERSONAL_PICK,
  };
}

/**
 * Whether the person's per-computer pick is gone: its computer answered and
 * has neither local settings nor unfinished setup (or is too old). The pick
 * then returns to the default, so a page does not retain a finished setup's
 * per-computer entry. A computer that has not answered
 * yet keeps the pick: nothing is known.
 */
export function isStaleLocalPick(
  pick: EnvironmentPick | null,
  model: EnvironmentPickerModel,
  statuses: ReadonlyMap<string, EnvironmentStatusResponseV11 | null>,
): boolean {
  if (pick === null || pick.kind !== "local") return false;
  if ((statuses.get(pick.hostId) ?? null) === null) return false;
  const row = model.localRows.find((entry) => entry.hostId === pick.hostId);
  return row === undefined || row.needsUpdate;
}
