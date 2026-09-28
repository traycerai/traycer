import {
  SERVICE_TASK_OWNER_UNCONFIRMED_LEFT_IN_PLACE_MESSAGE,
  SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE,
  type ServiceTaskNotOwnedReason,
} from "@traycer-clients/shared/platform/host-service-notices";
import { createCliLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError, cliError } from "../../runner/errors";
import { isServiceMutationAuthorityError } from "../mutation-authority";
import { unescapeXml } from "../escape-xml";
import { windowsTaskName, type ServiceLabel } from "../label";
import type {
  EndedStdinRunOptions,
  RunOptions,
  RunResult,
} from "../process-runner";
import {
  WINDOWS_TASK_CREATE_BUDGET_MS,
  WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS,
} from "../spawn-edge-bounds";

// THE OWNERSHIP GATE for the host's Scheduled Task.
//
// The task name (`windowsTaskName`) is machine-global: every Windows account
// that runs Traycer names the same `\Traycer\Host`, but the task belongs to
// the account whose principal it carries. Task Scheduler's default DACL lets
// Administrators read, redefine and delete another account's task, so a full-
// token admin's CLI could `/Create /F` a second user's task under its own SID
// (taking over their autostart) or delete it, and nothing compared the task's
// principal with the caller.
//
// Every verb that CHANGES the task - `/Create`, `/Run`, `/End`, `/Delete`, and
// the Schedule.Service folder delete - is spelled in this module
// and nowhere else in the CLI (a source gate test pins that), and each one is
// reached only through `gateWindowsTaskVerb`, which asks the one function that
// decides ownership (`readWindowsTaskOwnership`) immediately before the verb.
// A `/Create`, whose caller stages a definition between that read and the
// verb, reads again once the staging is done and writes only on what that
// confirm-read found; on an absent task it creates only if the task is still
// absent (see `createGatedTask`). The task's principal is never cached: it is
// read again for every verb. What
// a caller does with a task that is not its own is the call site's policy:
// `/End` is skipped (the caller's own slot sweep still runs), every write is
// refused with `E_SERVICE_TASK_NOT_OWNED`, and an uninstall leaves the task in
// place while it finishes the caller's own teardown.
//
// Fail closed: a task whose principal cannot be read, parsed or resolved, or a
// caller whose own SID cannot be read, is NOT the caller's. It is refused like
// another account's task, under the same code, but it is not SAID to be
// another account's: nothing confirmed that. Its refusal and log lines say the
// owner could not be confirmed (`reason: "unconfirmed"`), and only a principal
// resolved to another SID is "owned by another user" (`other-owner`).
//
// No account identifier leaves this module above DEBUG, and none at all is
// logged: not the task's principal, not the caller's SID, not a user name.

/** What `schtasks /Query /TN <task> /XML` answered. */
export type ScheduledTaskXmlQuery =
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "xml"; readonly xml: string };

/**
 * Why a task is not treated as the caller's: its principal names another
 * account (`other-owner`), or nothing here could confirm that it is the
 * caller's (`unconfirmed`, fail closed). Sent as `details.reason`.
 */
export type WindowsTaskNotOwnedReason = ServiceTaskNotOwnedReason;

/** The one ownership verdict, for the task as it is right now. */
export type WindowsTaskOwnership =
  | { readonly kind: "absent" }
  /** The caller's task, with the XML the verdict was read from. */
  | { readonly kind: "caller"; readonly xml: string }
  | {
      readonly kind: "not-owned";
      readonly reason: WindowsTaskNotOwnedReason;
      /** DEBUG only: why, in words that name no account. */
      readonly detail: string;
    };

export interface WindowsTaskOwnershipDeps {
  /** Read-only: the registered task's XML. */
  readonly queryTaskXml: (taskName: string) => Promise<ScheduledTaskXmlQuery>;
  /** The SID of the account this process runs as, or `null`. */
  readonly callerSid: () => string | null;
  /**
   * Resolve an account NAME (`DOMAIN\name`, `.\name`, or a bare name) to its
   * SID through the OS, or `null` when it resolves to nothing.
   */
  readonly resolveAccountSid: (account: string) => Promise<string | null>;
}

/**
 * The refusal every write on another account's task throws. Written for the
 * person reading it: the desktop shows it verbatim, including a desktop too
 * old to know the code.
 */
export const SERVICE_TASK_NOT_OWNED_MESSAGE =
  "The Traycer Host task on this PC is owned by another Windows user, so Traycer left it alone and can't run a background host for you here. Connect to a remote host, or ask that user to remove Traycer from their account first.";

/**
 * The warning a command with its own work to do reports when it finished that
 * work and left another account's task in place (`host uninstall`).
 */
export const SERVICE_TASK_LEFT_IN_PLACE_MESSAGE =
  "The Traycer Host task on this PC is owned by another Windows user, so it was left in place; everything of yours was removed.";

/**
 * What a refused write says, by reason: a task whose owner could not be
 * confirmed never says another user owns it. Its sentence is the desktop's
 * own (shared), so a desktop that shows this text verbatim says the same.
 */
export function serviceTaskNotOwnedMessage(
  reason: WindowsTaskNotOwnedReason,
): string {
  return reason === "other-owner"
    ? SERVICE_TASK_NOT_OWNED_MESSAGE
    : SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE;
}

/** What a removal that left the task in place says, by reason. */
export function serviceTaskLeftInPlaceMessage(
  reason: WindowsTaskNotOwnedReason,
): string {
  return reason === "other-owner"
    ? SERVICE_TASK_LEFT_IN_PLACE_MESSAGE
    : SERVICE_TASK_OWNER_UNCONFIRMED_LEFT_IN_PLACE_MESSAGE;
}

/**
 * A `/Create` that failed closed because the task would not hold still long
 * enough to write it: it changed under every read, or its reads ran past the
 * create's budget. Names no account and no owner.
 */
export const SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE =
  "The service registration kept changing while it was being installed; try again.";

export function isServiceRegistrationKeptChangingError(
  error: unknown,
): boolean {
  return (
    error instanceof CliError &&
    error.code === CLI_ERROR_CODES.SERVICE_INSTALL_FAILED &&
    error.message === SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE
  );
}

export function serviceTaskNotOwnedError(
  label: ServiceLabel,
  verb: WindowsTaskVerb,
  reason: WindowsTaskNotOwnedReason,
): CliError {
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
    message: serviceTaskNotOwnedMessage(reason),
    details: { task: windowsTaskName(label), verb, reason },
    exitCode: 1,
  });
}

export function isServiceTaskNotOwnedError(error: unknown): error is CliError {
  return (
    error instanceof CliError &&
    error.code === CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED
  );
}

/**
 * The reason a not-owned refusal carries. Only an explicit `other-owner` is
 * another user's; anything else - no details, or a reason this build does not
 * know - is `unconfirmed`, so no copy claims an owner nothing confirmed.
 */
export function serviceTaskNotOwnedReasonOf(
  error: CliError,
): WindowsTaskNotOwnedReason {
  return error.details?.reason === "other-owner"
    ? "other-owner"
    : "unconfirmed";
}

// `S-1-<revision>-<authority>-<sub>...`, the only SID string form. Anything
// else in `<UserId>` is an account name.
const SID_SHAPE = /^S-1-[0-9]+(?:-[0-9]+)+$/i;

export function isSidShaped(value: string): boolean {
  return SID_SHAPE.test(value);
}

/**
 * The `<UserId>` of the principal the task's actions run as, or `null` when the
 * task has no such principal (a group principal, none at all, or a context
 * that names no principal). The actions' `Context` selects the principal;
 * without one, a task with exactly one principal runs as it.
 */
export function parseTaskPrincipalUserId(xml: string): string | null {
  const principals = /<Principals>([\s\S]*?)<\/Principals>/.exec(xml)?.[1];
  if (principals === undefined) return null;
  const entries = [
    ...principals.matchAll(/<Principal\b([^>]*)>([\s\S]*?)<\/Principal>/g),
  ];
  const context = /<Actions\b[^>]*\bContext="([^"]*)"/.exec(xml)?.[1] ?? null;
  const chosen =
    context === null
      ? entries.length === 1
        ? entries[0]
        : undefined
      : entries.find(
          (entry) => /\bid="([^"]*)"/.exec(entry[1] ?? "")?.[1] === context,
        );
  if (chosen === undefined) return null;
  const userId = /<UserId>([\s\S]*?)<\/UserId>/.exec(chosen[2] ?? "")?.[1];
  if (userId === undefined) return null;
  const value = unescapeXml(userId.trim());
  return value.length === 0 ? null : value;
}

/**
 * THE decision: is the task named `taskName` the caller's, right now? One
 * read-only `/Query /XML`; an account-name principal (a task written from a
 * name rather than a SID) costs one OS name lookup. Never cached.
 */
export async function readWindowsTaskOwnership(
  taskName: string,
  deps: WindowsTaskOwnershipDeps,
): Promise<WindowsTaskOwnership> {
  const query = await deps.queryTaskXml(taskName);
  if (query.kind === "absent") return { kind: "absent" };
  if (query.kind === "failed") {
    return notOwned(
      "unconfirmed",
      `the task could not be read (${query.reason})`,
    );
  }
  const principal = parseTaskPrincipalUserId(query.xml);
  if (principal === null) {
    return notOwned("unconfirmed", "the task names no principal account");
  }
  const caller = deps.callerSid();
  if (caller === null) {
    return notOwned("unconfirmed", "this account's SID could not be read");
  }
  const principalSid = isSidShaped(principal)
    ? principal
    : await deps.resolveAccountSid(principal);
  if (principalSid === null) {
    return notOwned(
      "unconfirmed",
      "the task's principal account name resolves to no SID",
    );
  }
  return principalSid.toUpperCase() === caller.toUpperCase()
    ? { kind: "caller", xml: query.xml }
    : notOwned(
        "other-owner",
        isSidShaped(principal)
          ? "the task's principal SID is another account's"
          : "the task's principal account name resolves to another account",
      );
}

function notOwned(
  reason: WindowsTaskNotOwnedReason,
  detail: string,
): WindowsTaskOwnership {
  return { kind: "not-owned", reason, detail };
}

/** Every verb that changes the task (or the folder it lives in). */
export type WindowsTaskVerb =
  | "end"
  | "run"
  | "create"
  | "delete"
  | "delete-empty-folder";

/** The runner a gated verb is issued through (the controller's own `run`). */
export type WindowsTaskVerbRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

interface WindowsTaskVerbExecutors {
  readonly end: (
    run: WindowsTaskVerbRunner,
    options: RunOptions,
  ) => Promise<RunResult>;
  readonly run: (
    run: WindowsTaskVerbRunner,
    options: RunOptions,
  ) => Promise<RunResult>;
  readonly create: (
    run: WindowsTaskVerbRunner,
    stage: WindowsTaskCreateStager,
    options: RunOptions,
  ) => Promise<PermittedWindowsTask>;
  readonly delete: (
    run: WindowsTaskVerbRunner,
    options: RunOptions,
  ) => Promise<RunResult>;
  readonly "delete-empty-folder": (
    run: WindowsTaskVerbRunner,
    options: RunOptions,
  ) => Promise<RunResult>;
}

/** The task a permitted verb acts on, as the gate's own read found it. */
export type PermittedWindowsTask =
  | { readonly kind: "absent" }
  | { readonly kind: "caller"; readonly xml: string };

/**
 * Stages the definition a `/Create` writes FOR `task`, as a read found it:
 * `absent` for a fresh registration, or the caller's own task, whose XML
 * carries the settings the write keeps (`<Enabled>` above all). Returns the
 * staged XML's path. Called again whenever the confirm-read finds the task
 * changed, so each call stages afresh.
 */
export type WindowsTaskCreateStager = (
  task: PermittedWindowsTask,
) => Promise<string>;

// How many times a `/Create` stages before it gives up on a task that changes
// under every read. Two covers the races the confirm-read exists for - one
// change, or a create-if-absent that lost to the caller's own concurrent
// create - and the third is headroom, not a retry policy.
const CREATE_STAGING_PASSES = 3;

export type WindowsTaskVerbGate<V extends WindowsTaskVerb> =
  | {
      readonly kind: "permitted";
      readonly task: PermittedWindowsTask;
      /** Issues the verb. Call it once, right away. */
      readonly exec: WindowsTaskVerbExecutors[V];
    }
  | {
      readonly kind: "not-owned";
      readonly reason: WindowsTaskNotOwnedReason;
      /** The refusal, for a call site whose policy is to refuse. */
      readonly error: CliError;
    };

/**
 * The one door to a verb that changes the host's task: read ownership now,
 * then hand back the verb only when the task is absent or the caller's. A task
 * that is not the caller's gets the typed refusal instead, and the verb is
 * never issued - the call site decides whether that skips or throws.
 */
export async function gateWindowsTaskVerb<V extends WindowsTaskVerb>(
  label: ServiceLabel,
  verb: V,
  deps: WindowsTaskOwnershipDeps,
): Promise<WindowsTaskVerbGate<V>> {
  const taskName = windowsTaskName(label);
  const ownership = await readWindowsTaskOwnership(taskName, deps);
  if (ownership.kind === "not-owned") {
    return {
      kind: "not-owned",
      reason: ownership.reason,
      error: refuseNotOwned(label, verb, ownership),
    };
  }
  const executors: WindowsTaskVerbExecutors = {
    end: (run, options) => run("schtasks", ["/End", "/TN", taskName], options),
    run: (run, options) => run("schtasks", ["/Run", "/TN", taskName], options),
    create: (run, stage, options) =>
      createGatedTask(label, deps, ownership, run, stage, options),
    delete: (run, options) =>
      run("schtasks", ["/Delete", "/TN", taskName, "/F"], options),
    // `schtasks /Delete` removes only the task; the `\Traycer` FOLDER it was
    // auto-created in stays behind forever (probed live on Windows 11: the
    // empty folder remains visible in Task Scheduler Library - and folders
    // show even though the task itself was hidden). schtasks has no verb for
    // folders, so ask the Schedule.Service COM API - and ONLY when the folder
    // is genuinely empty: other environments' tasks (`Host-Dev`,
    // `Host-Staging`), and another user's, live in the same folder and must
    // survive this uninstall.
    "delete-empty-folder": (run, options) =>
      run(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$s=New-Object -ComObject Schedule.Service;$s.Connect();$f=$s.GetFolder('\\Traycer');if((@($f.GetTasks(1)).Count -eq 0) -and (@($f.GetFolders(0)).Count -eq 0)){$s.GetFolder('\\').DeleteFolder('Traycer',0)}",
        ],
        options,
      ),
  };
  const exec: WindowsTaskVerbExecutors[V] = executors[verb];
  return { kind: "permitted", task: ownership, exec };
}

/**
 * The typed refusal for a task that is not the caller's, logged the one way
 * every refusal is: INFO says why by reason - "owned by another user", or
 * that its owner could not be confirmed - and names no account; the detail,
 * still naming none, is DEBUG.
 */
function refuseNotOwned(
  label: ServiceLabel,
  verb: WindowsTaskVerb,
  ownership: Extract<WindowsTaskOwnership, { kind: "not-owned" }>,
): CliError {
  const taskName = windowsTaskName(label);
  const logger = createCliLogger(label.environment);
  logger.info(
    ownership.reason === "other-owner"
      ? "The host's Scheduled Task is owned by another user; not changing it"
      : "The host's Scheduled Task's owner could not be confirmed as this account; not changing it",
    { task: taskName, verb, reason: ownership.reason },
  );
  logger.debug("Scheduled Task ownership was not confirmed as this account's", {
    task: taskName,
    verb,
    detail: ownership.detail,
  });
  return serviceTaskNotOwnedError(label, verb, ownership.reason);
}

/**
 * The `/Create` behind the gate: read (the gate's), stage, CONFIRM-READ, verb.
 * Task Scheduler has no compare-and-set, so a write is decided by a read taken
 * as late as it can be - after the staging, immediately before the verb - and
 * never by the gate's earlier read alone, which only refuses before anything
 * is staged. The confirm-read decides:
 *
 * - another account's task, or one that cannot be read: the typed refusal,
 *   and nothing is written;
 * - a task other than the one the definition was staged from (registered,
 *   removed, or its XML - `<Enabled>` above all - edited in between): the
 *   definition is staged again from THAT read, which is confirmed in turn;
 * - the caller's own task, as staged: `/Create /F` redefines it;
 * - no task: `/Create` WITHOUT `/F`, which creates only while the task is
 *   still absent and refuses an existing one untouched (measured on Windows
 *   Server 2022 build 20348: exit 1, the existing definition unchanged, no
 *   prompt; stdin is ended at spawn so a build that did prompt reads EOF).
 *   Anything but a clean exit - a refusal, a timeout, a child that could not
 *   run - is decided by one more read, never by the command's output, which
 *   Windows localises: the caller's own task (its own concurrent create won)
 *   goes down the owned path, another account's is the refusal, one that
 *   cannot be read is refused too, and a task still absent means the create
 *   failed on its own account, which is rethrown as itself.
 *
 * What stays open is the owned `/Create /F`'s own start latency after its
 * confirm-read (one `schtasks` call, 40-64 ms on that measured host): a task
 * the caller owns that another party deletes, AND a second account registers
 * under the same name, inside that window is overwritten.
 *
 * All of it runs under a step budget, `WINDOWS_TASK_CREATE_BUDGET_MS` (B),
 * on a monotonic clock from entry. A read or a create starts only when it can
 * finish at its own ceiling inside B; one that cannot fails the create closed
 * before it writes. An install makes this create after publishing its grant,
 * and B is what that grant's bound counts for it
 * (`WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS`), however often the task changes.
 */
async function createGatedTask(
  label: ServiceLabel,
  deps: WindowsTaskOwnershipDeps,
  first: PermittedWindowsTask,
  run: WindowsTaskVerbRunner,
  stage: WindowsTaskCreateStager,
  options: RunOptions,
): Promise<PermittedWindowsTask> {
  const taskName = windowsTaskName(label);
  const deadlineMs = performance.now() + WINDOWS_TASK_CREATE_BUDGET_MS;
  let staged: PermittedWindowsTask = first;
  let stagings = 1;
  let xmlPath = await stage(staged);
  // `timeoutMs <= 0` arms no timeout (`process-runner.ts`), so it never fits.
  const createCeilingMs =
    options.timeoutMs > 0 ? options.timeoutMs : Number.POSITIVE_INFINITY;
  const requireBudget = (ceilingMs: number): void => {
    if (performance.now() + ceilingMs > deadlineMs) {
      throw registrationKeptChanging(label, "budget", stagings);
    }
  };
  const confirmRead = (): Promise<WindowsTaskOwnership> => {
    requireBudget(WINDOWS_TASK_OWNERSHIP_READ_BOUND_MS);
    return readWindowsTaskOwnership(taskName, deps);
  };
  const restage = async (task: PermittedWindowsTask): Promise<void> => {
    if (stagings >= CREATE_STAGING_PASSES) {
      throw registrationKeptChanging(label, "stagings", stagings);
    }
    stagings += 1;
    staged = task;
    xmlPath = await stage(task);
  };
  for (;;) {
    const confirmed = await confirmRead();
    if (confirmed.kind === "not-owned") {
      throw refuseNotOwned(label, "create", confirmed);
    }
    if (!samePermittedTask(staged, confirmed)) {
      await restage(confirmed);
      continue;
    }
    requireBudget(createCeilingMs);
    if (confirmed.kind === "caller") {
      await run(
        "schtasks",
        ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"],
        options,
      );
      return confirmed;
    }
    const createOnlyIfAbsent: EndedStdinRunOptions = {
      ...options,
      endStdin: true,
    };
    try {
      await run(
        "schtasks",
        ["/Create", "/TN", taskName, "/XML", xmlPath],
        createOnlyIfAbsent,
      );
      return confirmed;
    } catch (cause) {
      if (isServiceMutationAuthorityError(cause)) throw cause;
      const reread = await confirmRead();
      if (reread.kind === "not-owned") {
        throw refuseNotOwned(label, "create", reread);
      }
      if (reread.kind === "absent") throw cause;
      await restage(reread);
    }
  }
}

function samePermittedTask(
  staged: PermittedWindowsTask,
  confirmed: PermittedWindowsTask,
): boolean {
  if (staged.kind === "absent") return confirmed.kind === "absent";
  return confirmed.kind === "caller" && confirmed.xml === staged.xml;
}

/**
 * The fail-closed end of a `/Create` that could not settle: `stagings`, the
 * task changed under every read it was staged from; `budget`, the next read
 * or the create could not finish inside B.
 */
function registrationKeptChanging(
  label: ServiceLabel,
  reason: "stagings" | "budget",
  stagings: number,
): CliError {
  return cliError({
    code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    message: SERVICE_REGISTRATION_KEPT_CHANGING_MESSAGE,
    details: { task: windowsTaskName(label), reason, stagings },
    exitCode: 1,
  });
}
