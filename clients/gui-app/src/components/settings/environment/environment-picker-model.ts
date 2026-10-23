import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import {
  localRowCohort,
  type LocalRowVerb,
} from "@/components/settings/environment/local-row-cohort";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";

export const NOT_MOVED_SUBTITLE =
  "not moved · Personal's settings are not on it";
export const PARTLY_MOVED_SUBTITLE = "partly moved";

export function needsUpdateSubtitle(hostName: string): string {
  return `${hostName} needs an update to show its settings here.`;
}

/** A computer row under Personal. */
export interface LocalPickerRow {
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
  readonly personalSubtitle: string;
  readonly localRows: readonly LocalPickerRow[];
  /** What the window opens on when the person has picked nothing. */
  readonly defaultPick: EnvironmentPick;
}

/**
 * The Local row a host has, from its `environment.status` and the version it
 * negotiated for that method, or `null` for none.
 *
 * A Local row exists while setup waits at the move: `moving_settings` and
 * either `awaiting_consent` (nothing has moved) or an upload accepted and not
 * finished (partly moved). A host whose `environment.status` predates 1.1
 * can never report `awaiting_consent`, so one that has not reached
 * `applying` gets the greyed `needs an update` row instead; one that has is
 * already shared and has no row. A host that has not answered, or not been
 * dialled, has no row: nothing is known about it.
 */
export function localPickerRow(
  host: EnvironmentPickerHost,
  status: EnvironmentStatusResponse | null,
  version: NegotiatedMethodVersion,
): LocalPickerRow | null {
  if (isBeforeConsentGate(version)) {
    return isUnmovedOldHost(status, version) ? needsUpdateRow(host) : null;
  }
  if (status === null) return null;
  const cohort = localRowCohort(status);
  if (cohort !== null) {
    return cohort.kind === "none"
      ? null
      : {
          hostId: host.hostId,
          name: host.name,
          subtitle: cohort.subtitle,
          verb: cohort.verb,
          needsUpdate: false,
          defaultsToLocal: cohort.defaultsToLocal,
        };
  }
  const setup = status.setup;
  if (setup === null || setup.stage !== "moving_settings") return null;
  if (setup.state === "awaiting_consent") {
    return {
      hostId: host.hostId,
      name: host.name,
      subtitle: NOT_MOVED_SUBTITLE,
      verb: "move_to_personal",
      needsUpdate: false,
      defaultsToLocal: true,
    };
  }
  if (!hasUploadPastAccept(status)) return null;
  return {
    hostId: host.hostId,
    name: host.name,
    subtitle: PARTLY_MOVED_SUBTITLE,
    verb: "finish_moving",
    needsUpdate: false,
    defaultsToLocal: false,
  };
}

/** An old host that has not reached `applying`: it has not moved. */
function isUnmovedOldHost(
  status: EnvironmentStatusResponse | null,
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
    hostId: host.hostId,
    name: host.name,
    subtitle: needsUpdateSubtitle(host.name),
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

/** The person accepted the move and its upload has not finished. */
function hasUploadPastAccept(status: EnvironmentStatusResponse): boolean {
  return status.pendingUploads.length > 0;
}

/**
 * `your settings · on MacBook Pro, dev-box`: the hosts running Personal,
 * two named, the rest counted. A computer with a Local row is not among them.
 */
export function personalSubtitle(names: readonly string[]): string {
  if (names.length === 0) return "your settings";
  const [first, second] = names;
  if (names.length === 1) return `your settings · on ${first}`;
  const rest = names.length - 2;
  return rest === 0
    ? `your settings · on ${first}, ${second}`
    : `your settings · on ${first}, ${second} and ${rest} more`;
}

export function environmentPickerModel(input: {
  readonly hosts: readonly EnvironmentPickerHost[];
  readonly statuses: ReadonlyMap<string, EnvironmentStatusResponse | null>;
  readonly versions: ReadonlyMap<string, NegotiatedMethodVersion>;
  /** This window's own host, whose Local row is the default pick. */
  readonly windowHostId: string | null;
}): EnvironmentPickerModel {
  const localRows: LocalPickerRow[] = [];
  const runningPersonal: string[] = [];
  for (const host of input.hosts) {
    const status = input.statuses.get(host.hostId) ?? null;
    const row = localPickerRow(
      host,
      status,
      input.versions.get(host.hostId) ?? null,
    );
    if (row !== null) localRows.push(row);
    else if (status?.principal?.kind === "personal") {
      runningPersonal.push(host.name);
    }
  }
  const windowRow =
    localRows.find((row) => row.hostId === input.windowHostId) ?? null;
  return {
    personalSubtitle: personalSubtitle(runningPersonal),
    localRows,
    defaultPick:
      windowRow !== null && !windowRow.needsUpdate && windowRow.defaultsToLocal
        ? { kind: "local", hostId: windowRow.hostId, hostName: windowRow.name }
        : PERSONAL_PICK,
  };
}

/**
 * Whether the person's pick names a Local row that is gone: its computer
 * answered and has moved (or is too old to show its settings). The pick
 * then returns to the default, so a page never reads through a computer
 * that has no local settings left to show. A computer that has not answered
 * yet keeps the pick: nothing is known.
 */
export function isStaleLocalPick(
  pick: EnvironmentPick | null,
  model: EnvironmentPickerModel,
  statuses: ReadonlyMap<string, EnvironmentStatusResponse | null>,
): boolean {
  if (pick === null || pick.kind !== "local") return false;
  if ((statuses.get(pick.hostId) ?? null) === null) return false;
  const row = model.localRows.find((entry) => entry.hostId === pick.hostId);
  return row === undefined || row.needsUpdate;
}
