import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE } from "@traycer/protocol/host/lifecycle-constants";
import type { ILogger } from "../logger";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { serviceLabelFor } from "../service/label";
import {
  readWindowsServiceTaskOwnership,
  windowsTaskXmlEnabledState,
} from "../service/platforms/windows";
import type { WindowsTaskNotOwnedReason } from "../service/platforms/windows-task-gate";
import { SERVICE_REGISTRATION_DISABLED_MESSAGE } from "../service/registration-disabled";
import {
  serviceTaskNotOwnedWarning,
  type ServiceRegistrationWarning,
} from "../service/registration-owner";
import { hostHomeDir } from "../store/paths";
import {
  readSupervisorRecord,
  readSupervisorRunState,
  type SupervisorRunAdmission,
} from "./lifecycle-files";
import { readHostPidMetadataEvidence } from "./pid-metadata";

/**
 * The update paths that stop the host and start it again through its service
 * registration, by argv. AUTOMATIC: `host update`, every trigger (the host
 * update reconciler's detached run included), and `host apply --respect-hold`,
 * which only the desktop's launch-time apply passes. EXPLICIT: `host apply`
 * without `--respect-hold` - at a terminal, or the desktop's Update now click.
 */
export type HostUpdateServicePath =
  | "host update"
  | "host apply --respect-hold"
  | "host apply";

/** What an automatic update deferred over a disabled service reports. */
export const HOST_UPDATE_DEFERRED_SERVICE_DISABLED_MESSAGE = `Host update deferred: ${SERVICE_REGISTRATION_DISABLED_MESSAGE}. Nothing was stopped or installed; the update installs once the task is enabled again.`;

/**
 * What an automatic update deferred over another account's task reports. Names
 * no account: the owner is "another Windows user", always.
 */
export const HOST_UPDATE_DEFERRED_TASK_NOT_OWNED_MESSAGE =
  "Host update deferred: the Traycer Host task on this PC is owned by another Windows user, so this account could not start the host again after stopping it. Nothing was stopped or installed; the update installs once that task is gone.";

/** What an explicit `host apply` refused over another account's task reports. */
export const HOST_APPLY_REFUSED_TASK_NOT_OWNED_MESSAGE =
  "Host update not applied: the Traycer Host task on this PC is owned by another Windows user, so this account could not start the host again after stopping it. Nothing was stopped or installed.";

/**
 * The same two over a task whose owner could not be confirmed: refused the
 * same way, but never said to be another user's - nothing confirmed that.
 */
export const HOST_UPDATE_DEFERRED_TASK_OWNER_UNCONFIRMED_MESSAGE =
  "Host update deferred: Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Nothing was stopped or installed. Try again, or run `traycer host doctor`.";
export const HOST_APPLY_REFUSED_TASK_OWNER_UNCONFIRMED_MESSAGE =
  "Host update not applied: Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Nothing was stopped or installed. Try again, or run `traycer host doctor`.";

/** Why the service an update would stop cannot be started again. */
type UnstartableService = "disabled" | "not-owned";

// Present while automatic updates are parked for that reason, so the refusal
// logs at INFO once per state change - when the park starts, and when the
// service can be started again - and at DEBUG on every run in between. A
// level-triggered caller may run this many times per state; the log must not
// grow with it. Each holds no account identifier, nor anything else: its
// existence is the whole record.
const PARK_MARKERS: Readonly<Record<UnstartableService, string>> = {
  disabled: "update-deferred-service-disabled",
  "not-owned": "update-deferred-service-not-owned",
};

/**
 * THE refusal: an update whose stop and restart go through a service this
 * account cannot start again is refused before it claims an attempt,
 * downloads, stops, swaps or writes anything. Windows only - the host's
 * Scheduled Task - from ONE read-only `/Query /XML`, the ownership read every
 * task verb goes through:
 *
 * - The caller's task, disabled by its owner in Task Scheduler. It refuses
 *   `/Run`, and turning it back on is its owner's call, not an update's. An
 *   automatic path parks (below). An explicit `host apply` goes on: it swaps,
 *   keeps the task disabled and says so (`SERVICE_KEPT_DISABLED_WARNING`).
 * - A task this account does not own (another account's, or one whose owner
 *   cannot be confirmed), while the host last admitted here was started
 *   THROUGH the task: its supervisor record says `granted` or `unattended`.
 *   The stop would take that host down and nothing here could start it again.
 *   An automatic path parks; an explicit `host apply` is refused, exit 1.
 *   A `foreground` run (`traycer host start` in a terminal) comes back without
 *   the task and is not refused. With no supervisor and no published host
 *   there is no host to take down: not refused either, and the swap carries
 *   the not-owned warning this returns, as `host install` does.
 *
 * The admission is the supervisor's own record - `supervisor-run.json` paired
 * with `supervisor.json` on one pid, as `readHostLifecycleSnapshot` pairs them
 * - read from the host home, with no process probe. A host whose admission
 * cannot be read is treated as started through the task:
 *   - a published host (`pid.json`) with no `supervisor.json` - what a
 *     supervisor from before these records leaves (cli-v1.3.0 writes none),
 *     and a supervisor that died leaving the pid file;
 *   - a record that is invalid, unreadable or unpaired.
 * A record whose supervisor has since died reads as the task-started host it
 * was. Each of those refuses an update that may stop nothing; that errs toward
 * leaving the machine as it is.
 *
 * An automatic park keeps the stage and exits
 * `HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE`, which only this refusal
 * returns and on which the host's reconciler latches; the code says which
 * state it is. The first automatic run that finds the service startable again
 * applies the stage.
 */
export async function refuseUpdateOverUnstartableService(
  environment: Environment,
  logger: ILogger,
  path: HostUpdateServicePath,
): Promise<ServiceRegistrationWarning | null> {
  const automatic = path !== "host apply";
  const state = await readUpdateServiceState(environment);
  if (state.kind === "not-owned-no-host" || state.kind === "startable") {
    if (automatic) await announceParkEnded(environment, logger, path);
    return state.kind === "not-owned-no-host"
      ? serviceTaskNotOwnedWarning(state.reason)
      : null;
  }
  if (!automatic) {
    if (state.kind === "disabled") return null;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message:
        state.reason === "other-owner"
          ? HOST_APPLY_REFUSED_TASK_NOT_OWNED_MESSAGE
          : HOST_APPLY_REFUSED_TASK_OWNER_UNCONFIRMED_MESSAGE,
      details: { environment, path, reason: state.reason },
      exitCode: 1,
    });
  }
  if (state.kind === "disabled") {
    await announcePark(environment, logger, path, "disabled");
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_REGISTRATION_DISABLED,
      message: HOST_UPDATE_DEFERRED_SERVICE_DISABLED_MESSAGE,
      details: { environment, deferred: true },
      exitCode: HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE,
    });
  }
  await announcePark(environment, logger, path, state.reason);
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
    message:
      state.reason === "other-owner"
        ? HOST_UPDATE_DEFERRED_TASK_NOT_OWNED_MESSAGE
        : HOST_UPDATE_DEFERRED_TASK_OWNER_UNCONFIRMED_MESSAGE,
    details: { environment, deferred: true, reason: state.reason },
    exitCode: HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE,
  });
}

type UpdateServiceState =
  | { readonly kind: "startable" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "not-owned-task-host" | "not-owned-no-host";
      readonly reason: WindowsTaskNotOwnedReason;
    };

async function readUpdateServiceState(
  environment: Environment,
): Promise<UpdateServiceState> {
  if (process.platform !== "win32") return { kind: "startable" };
  const ownership = await readWindowsServiceTaskOwnership(
    serviceLabelFor(environment),
  );
  switch (ownership.kind) {
    case "absent":
      return { kind: "startable" };
    case "caller":
      // An `<Enabled>` that cannot be read is not one the user is known to
      // have switched off: ownership passed on this same read.
      return windowsTaskXmlEnabledState(ownership.xml).kind === "disabled"
        ? { kind: "disabled" }
        : { kind: "startable" };
    case "not-owned": {
      const host = await readRecordedHostAdmission(environment);
      if (host.kind === "none") {
        return { kind: "not-owned-no-host", reason: ownership.reason };
      }
      return host.kind === "admitted" && host.admission === "foreground"
        ? { kind: "startable" }
        : { kind: "not-owned-task-host", reason: ownership.reason };
    }
  }
}

/**
 * How the host last admitted here was started, from the files the supervisor
 * and the host leave in the host home: `admitted` with the paired records'
 * `admission`; `none` when there is no supervisor and no published host; and
 * `unknown` for a host whose admission cannot be read (see
 * `refuseUpdateOverUnstartableService`).
 */
type RecordedHostAdmission =
  | { readonly kind: "admitted"; readonly admission: SupervisorRunAdmission }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

async function readRecordedHostAdmission(
  environment: Environment,
): Promise<RecordedHostAdmission> {
  const [supervisor, run, published] = await Promise.all([
    readSupervisorRecord(environment),
    readSupervisorRunState(environment),
    readHostPidMetadataEvidence(environment),
  ]);
  if (
    supervisor.kind === "valid" &&
    run.kind === "valid" &&
    run.record.supervisorPid === supervisor.record.pid
  ) {
    return { kind: "admitted", admission: run.record.admission };
  }
  if (supervisor.kind === "absent" && published.kind === "absent") {
    return { kind: "none" };
  }
  return { kind: "unknown" };
}

async function announcePark(
  environment: Environment,
  logger: ILogger,
  path: HostUpdateServicePath,
  why: "disabled" | WindowsTaskNotOwnedReason,
): Promise<void> {
  // One marker per state the park is IN - disabled, or not this account's -
  // whatever the not-owned reason, so a read that flips between an
  // unconfirmed owner and another user's does not re-announce the park.
  const reason: UnstartableService =
    why === "disabled" ? "disabled" : "not-owned";
  const other: UnstartableService =
    reason === "disabled" ? "not-owned" : "disabled";
  await removeMarker(markerPath(environment, other));
  const began = await placeMarker(markerPath(environment, reason));
  const message =
    why === "disabled"
      ? "the host's background service is disabled"
      : why === "other-owner"
        ? "the host's Scheduled Task is owned by another user"
        : "the host's Scheduled Task's owner could not be confirmed as this account";
  if (began) {
    logger.info(`Automatic host update deferred: ${message}`, {
      environment,
      path,
    });
  } else {
    logger.debug(`Automatic host update still deferred: ${message}`, {
      environment,
      path,
    });
  }
}

async function announceParkEnded(
  environment: Environment,
  logger: ILogger,
  path: HostUpdateServicePath,
): Promise<void> {
  const disabledEnded = await removeMarker(markerPath(environment, "disabled"));
  const notOwnedEnded = await removeMarker(
    markerPath(environment, "not-owned"),
  );
  if (disabledEnded) {
    logger.info(
      "The host's background service is enabled again; automatic host updates resume",
      { environment, path },
    );
  }
  if (notOwnedEnded) {
    logger.info(
      "The host's Scheduled Task no longer stops this account's updates; automatic host updates resume",
      { environment, path },
    );
  }
}

function markerPath(
  environment: Environment,
  reason: UnstartableService,
): string {
  return join(hostHomeDir(environment), PARK_MARKERS[reason]);
}

/** Whether this call placed the marker (the park just began). */
async function placeMarker(marker: string): Promise<boolean> {
  try {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, "", { flag: "wx" });
    return true;
  } catch {
    // Another run placed it first, or the home is not writable: either way
    // this run is not the one to announce the change.
    return false;
  }
}

/** Whether this call removed the marker (the park just ended). */
async function removeMarker(marker: string): Promise<boolean> {
  try {
    await rm(marker);
    return true;
  } catch {
    return false;
  }
}
