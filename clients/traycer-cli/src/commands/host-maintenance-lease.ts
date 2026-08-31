import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import {
  rebindUpdateMutationCapabilityLiveness,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import { createCliLogger } from "../logger";
import {
  requireCliUpdateMutationCapability,
  withCliAttemptMutation,
  withCliUpdateExecutionSegment,
  type WithCliUpdateContenderOptions,
} from "../host/update-contender";
import {
  runHostUninstallWithAttempt,
  type HostUninstallArgs,
} from "./host-uninstall";
import { uninstallHost } from "../installer";
import { readHostPidMetadata } from "../host/pid-metadata";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import { createServiceController, serviceLabelFor } from "../service";
import { withMacosMaintenanceServiceUid } from "../service/platforms/macos";
import { stopHostServiceWithAttempt } from "../host/update-mutation";
import type { Environment } from "../runner/environment";
import {
  parseHostMaintenanceLeaseTarget,
  type HostMaintenanceLeaseTarget,
} from "./host-maintenance-target";

export {
  isHostMaintenanceTargetPath,
  parseHostMaintenanceLeaseTarget,
} from "./host-maintenance-target";
export type { HostMaintenanceLeaseTarget } from "./host-maintenance-target";

/**
 * Versioned line protocol used only by the internal root install scripts.
 * The child keeps both lock levels live while the root process performs its
 * platform-owned work, and requires a fresh capability check before each
 * named actuator. An older CLI neither advertises nor speaks this protocol,
 * so scripts fail closed instead of treating an arbitrary zero exit as a
 * transferable admission lease.
 */
export const HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION = 1;

export type HostMaintenanceLeaseAdmission =
  | "desktop-activation-maintenance"
  | "uninstall-maintenance";

type HostMaintenanceLeaseAction = "host-stop" | "host-uninstall-all";

type RootMaintenanceOperation =
  | "cloud-macos-install"
  | "cloud-platform-install"
  | "cloud-uninstall"
  | "standalone-uninstall";

type RootMaintenanceExecutor = {
  readonly runtime: string;
  readonly script: string;
  readonly operation: RootMaintenanceOperation;
  readonly payload: Record<string, unknown>;
};

type LeaseRequest =
  | {
      readonly v: number;
      readonly id: string;
      readonly kind: "verify";
      readonly operation: string;
    }
  | {
      readonly v: number;
      readonly id: string;
      readonly kind: "execute";
      readonly action: HostMaintenanceLeaseAction;
    }
  | {
      readonly v: number;
      readonly id: string;
      readonly kind: "execute-root";
      readonly executor: RootMaintenanceExecutor;
    }
  | { readonly v: number; readonly id: string; readonly kind: "release" };

type LeaseResponse =
  | { readonly v: number; readonly kind: "ready" }
  | { readonly v: number; readonly id: string; readonly kind: "verified" }
  | { readonly v: number; readonly id: string; readonly kind: "executed" }
  | {
      readonly v: number;
      readonly id: string;
      readonly kind: "root-executed";
      readonly value: unknown;
    }
  | { readonly v: number; readonly id: string; readonly kind: "released" }
  | {
      readonly v: number;
      readonly id: string | null;
      readonly kind: "refused";
      readonly message: string;
    };

/**
 * Refuse unless this process's own path helpers resolve to the SAME account
 * the caller sealed into the target.
 *
 * `--host-home` and `TRAYCER_ROOT_MAINTENANCE_HOME` name the target account
 * explicitly, and the v2 protocol fields honour them — but `executeAction`'s
 * `host-uninstall-all` reaches `uninstallHost`, whose paths all descend from
 * `store/paths.ts`'s module-level `join(homedir(), ".traycer")`. Nothing
 * threads the target through that. The root script binds it by setting `HOME`
 * on the child's environment, which works on POSIX because Node's
 * `os.homedir()` prefers `$HOME` there — and does NOT work on win32, where
 * `os.homedir()` reads the OS profile API and ignores `HOME` entirely.
 *
 * So the binding is real but implicit, and its failure mode is silent and
 * severe: sweeping a different account's `.traycer` tree while reporting
 * success. Rather than re-thread a module constant, assert the binding held
 * and fail closed when it did not — the same posture the parent takes when it
 * cannot canonicalize the target home.
 */
function assertPathHelpersBoundToTarget(): void {
  const sealed = process.env.TRAYCER_ROOT_MAINTENANCE_HOME;
  if (typeof sealed !== "string" || sealed.length === 0) return;
  let resolvedSealed: string;
  let resolvedActual: string;
  try {
    resolvedSealed = realpathSync(sealed);
    resolvedActual = realpathSync(homedir());
  } catch {
    throw new Error(
      "maintenance lease could not confirm its target home directory",
    );
  }
  if (resolvedSealed !== resolvedActual) {
    throw new Error(
      "maintenance lease path helpers are bound to a different account than its sealed target",
    );
  }
}

export async function runHostMaintenanceLease(
  environment: Environment,
  admission: HostMaintenanceLeaseAdmission,
  target: HostMaintenanceLeaseTarget,
): Promise<void> {
  assertPathHelpersBoundToTarget();
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment,
    hostHomeDir: target.hostHomeDir,
    reason: "host-maintenance-lease",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission,
  };
  // A privileged root helper must never let the macOS controller fall back to
  // its effective uid (`gui/0`). The root script supplied and this endpoint
  // validated the target desktop uid; bind it in an AsyncLocalStorage scope
  // rather than trusting a caller-controlled environment variable.
  await withMacosMaintenanceServiceUid(target.serviceUid, () =>
    // The root script can spend time copying an app bundle or waiting for a
    // platform uninstaller. Hold only the outer attempt capability for that
    // whole segment; `executeAction` takes the legacy CLI lock only around
    // the actual service/install-tree mutation. This retains attempt-lock →
    // cli-lock ordering without turning the CLI lock into a root-script lease.
    withCliUpdateExecutionSegment(contenderOptions, (capability) =>
      serveMaintenanceLease(capability, contenderOptions),
    ),
  );
}

async function serveMaintenanceLease(
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
): Promise<void> {
  writeProtocol({ v: HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION, kind: "ready" });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const request = parseRequest(line);
    if (request === null) {
      writeProtocol({
        v: HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION,
        id: null,
        kind: "refused",
        message: "malformed maintenance lease request",
      });
      continue;
    }
    if (request.kind === "release") {
      writeProtocol({
        v: HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION,
        id: request.id,
        kind: "released",
      });
      return;
    }
    try {
      await requireCliUpdateMutationCapability(capability, contenderOptions);
      if (request.kind === "verify") {
        writeProtocol({
          v: HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION,
          id: request.id,
          kind: "verified",
        });
        continue;
      }
      if (request.kind === "execute") {
        await executeAction(request.action, capability, contenderOptions);
        writeProtocol({
          v: HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION,
          id: request.id,
          kind: "executed",
        });
      } else {
        const value = await superviseRootMaintenanceExecutor(
          request.executor,
          capability,
          contenderOptions,
        );
        writeProtocol({
          v: HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION,
          id: request.id,
          kind: "root-executed",
          value,
        });
      }
    } catch (err) {
      writeProtocol({
        v: HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION,
        id: request.id,
        kind: "refused",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }
}

/**
 * The lock owner starts and waits for the root-platform executor. The root
 * caller can request only a closed operation name; it cannot obtain a bare
 * "verified" token and then run launchctl/rm/dpkg itself. The executor asks
 * us to revalidate before each individual edge over stdio, so a capability
 * loss aborts its remaining work. When this helper dies, the executor's
 * parent-liveness monitor terminates its active actuator before the lock can
 * become breakable.
 */
async function superviseRootMaintenanceExecutor(
  executor: RootMaintenanceExecutor,
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
): Promise<unknown> {
  // C is about to own the published liveness envelope for D's raw platform
  // work. Revalidate at that spawn edge rather than relying on the protocol
  // dispatch check above: parsing, target validation, and previous requests
  // can all have yielded before this particular executor is created.
  await requireCliUpdateMutationCapability(capability, contenderOptions);
  const child = spawn(
    executor.runtime,
    [
      executor.script,
      "--root-maintenance-supervisor",
      executor.operation,
      JSON.stringify(executor.payload),
    ],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        TRAYCER_ROOT_MAINTENANCE_PARENT_PID: String(process.pid),
        TRAYCER_ROOT_MAINTENANCE_EXECUTOR: "1",
      },
    },
  );
  // EVERY subscription — terminal evidence AND the stdout parser — is
  // attached here, from the instant of spawn: before the guards below (which
  // throw), and before any await. `error`, `close`, and the stream's chunks
  // are emitted once and never replayed, so where these subscriptions sit
  // decides what is observable at all:
  //
  // - The pid guard below throws synchronously for a spawn that will still
  //   emit ENOENT asynchronously; with no `error` listener that emission is
  //   an uncaught event that kills the lease process on exactly the failure
  //   the guard reports politely.
  // - With the first terminal subscription after the liveness rebind — a
  //   filesystem round trip — an executor that died in that window emitted
  //   into no listener: the error crashed the process, the exit left the
  //   supervision promise pending forever with the attempt lock held.
  // - With the `data` subscription after that same await, a short-lived
  //   executor's `complete` frame sat in a paused stream while the recorded
  //   `close` was reconciled, so a completed operation classified as
  //   `completed === null` — a confident failure over finished root work.
  //
  // `close`, not `exit`, for the terminal event: `exit` can be delivered
  // while the final stdout chunk is still in the pipe; `close` fires only
  // after the stdout stream has ended, and a stream's events are ordered, so
  // every `data` callback (and therefore `finish`) has run before
  // classification.
  type ExecutorTermination =
    | { readonly kind: "spawn-error"; readonly error: Error }
    | {
        readonly kind: "closed";
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      };
  let termination: ExecutorTermination | null = null;
  let onTermination: (() => void) | null = null;
  const recordTermination = (event: ExecutorTermination): void => {
    // First evidence wins: a failed spawn emits `error` and then `close`, and
    // the error names the cause while that close carries only a null code.
    if (termination !== null) return;
    termination = event;
    onTermination?.();
  };
  child.once("error", (error) => {
    recordTermination({ kind: "spawn-error", error });
  });
  child.once("close", (code, signal) => {
    recordTermination({ kind: "closed", code, signal });
  });
  if (child.stdin === null || child.stdout === null) {
    child.kill("SIGTERM");
    throw new Error("maintenance executor could not establish protocol pipes");
  }
  // A refusal or acknowledgement can land on an executor that just died, and
  // stdin reports that EPIPE asynchronously on its own emitter — an unhandled
  // stream `error` is a throw. Deliberately inert: the `close` above carries
  // the exit evidence an EPIPE does not.
  child.stdin.on("error", () => undefined);
  // The read side is its own emitter too — an EIO mid-rebind or mid-operation
  // with no listener is the same uncaught throw. But inert is NOT enough
  // here: a broken protocol pipe means no frame can ever arrive again, while
  // the executor itself may keep running, and `close` (which gates every
  // settlement above) waits on process exit. Terminate the executor so the
  // ordinary `close` classification runs; with no completion frame it takes
  // the supervised failure arm — dispatch tail drained, actuator group
  // reaped, holder restored — instead of hanging unsupervised.
  child.stdout.on("error", () => {
    child.kill("SIGTERM");
  });
  if (child.pid === undefined) {
    child.kill("SIGTERM");
    throw new Error("maintenance executor did not expose a process identity");
  }
  const supervisorPid = child.pid;
  let settled = false;
  // A BOX, not the value itself. `undefined` was doing double duty as "no
  // completion frame has arrived", which made an actuator that legitimately
  // completes with `undefined` indistinguishable from one that never
  // completed at all — and `JSON.stringify({ value: undefined })` drops the
  // key outright, so that is exactly what an executor returning nothing
  // sends. The close handler would then take the failure path on a clean
  // exit 0 and report `maintenance executor exited (0, none)` for a
  // successful operation.
  //
  // `null` is not usable as the sentinel either: it is a legitimate actuator
  // result with its own meaning (the Linux platform install returns it for
  // "left for the developer to install by hand"). Only a wrapper can say
  // "completed" without also claiming something about the value.
  let completed: { readonly value: unknown } | null = null;
  let buffer = "";
  let actuatorGroupId: number | null = null;
  const refuse = (message: string): void => {
    if (!child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify({ kind: "refused", message })}\n`);
    }
  };
  const finish = (value: unknown): void => {
    if (settled || completed !== null) return;
    completed = { value };
  };
  // Chunks are CAPTURED from spawn; frames are DISPATCHED only once the
  // initial liveness rebind below has landed. The split is deliberate: a
  // `bind-actuator` arriving mid-rebind would run its own group-bound
  // publication concurrently with the plain one, and whichever landed second
  // would win — the plain one landing last would strip
  // `retainOnPublisherDeath` from a group already released to run. Deferring
  // dispatch keeps the publication order the protocol assumes, while the
  // early capture means no frame is ever lost to the await.
  let frameDispatchArmed = false;
  // ONE dispatch tail, and settlement awaits it. Handlers are asynchronous —
  // an `execute` runs a real service stop or uninstall — and a fire-and-
  // forget dispatch let the close path restore the holder and reject while
  // that destructive handler was still mid-flight: the outer execution
  // segment then released its lock and admitted the next contender INTO the
  // running operation. A buffered `bind-actuator` had the analogous race,
  // able to land its group-bound publication after the restoration it was
  // supposed to precede. Serializing on the tail also matches the executor
  // protocol, which is strictly request/response; every link catches into
  // `refuse`, so the tail itself never rejects and awaiting it cannot throw.
  let dispatchTail: Promise<void> = Promise.resolve();
  const drainFrames = (): void => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        refuse("maintenance executor emitted malformed protocol data");
        continue;
      }
      dispatchTail = dispatchTail.then(() =>
        handleRootExecutorRequest(
          request,
          capability,
          contenderOptions,
          child.stdin,
          finish,
          refuse,
          supervisorPid,
          (groupId) => {
            actuatorGroupId = groupId;
          },
        ).catch((err) =>
          refuse(err instanceof Error ? err.message : String(err)),
        ),
      );
    }
  };
  child.stdout.setEncoding("utf8");
  // LATCHED, not just cleared: SIGTERM does not synchronously stop `data`
  // events, and stdout already queued in the pipe keeps arriving after the
  // overflow. Without the latch, a later newline-delimited frame would still
  // reach `drainFrames()` — a damaged executor could dispatch an `execute`
  // AFTER violating the protocol, and one that handles SIGTERM and emits
  // `complete` could even resolve the supervision successfully. Once
  // violated, no subsequent frame is trusted: dispatch is off for good, so a
  // post-overflow `complete` never sets `completed` and the `close`
  // classification takes the supervised failure arm. (A `complete` that
  // dispatched BEFORE the overflow keeps its meaning — the work finished,
  // and failing it retroactively would be a confident false negative over a
  // completed root mutation.)
  let protocolViolated = false;
  child.stdout.on("data", (chunk: string) => {
    if (protocolViolated) return;
    buffer += chunk;
    // Protocol frames are single JSON lines of at most a few KiB; an
    // executor streaming an unterminated or runaway line is damaged, and
    // because supervision legitimately spans an unbounded platform
    // operation, an unbounded `buffer += chunk` is a slow memory exhaustion
    // rather than a quick failure. Same terminal action as a stdout stream
    // error below: no frame arriving on that line is deliverable, so
    // terminate the executor and let the ordinary `close` classification
    // take the supervised failure arm.
    if (buffer.length > EXECUTOR_PROTOCOL_BUFFER_LIMIT_BYTES) {
      protocolViolated = true;
      buffer = "";
      child.kill("SIGTERM");
      return;
    }
    if (frameDispatchArmed) drainFrames();
  });
  // C is only a liveness publisher, not a capability recipient. Until it
  // obtains D's detached group and receives B's acknowledgement, D is held
  // at its start gate and cannot run a raw actuator. The later group-bound
  // publication closes the hard-C-death interval without retaining a lock
  // forever for a supervisor that died before starting any work.
  try {
    await rebindUpdateMutationCapabilityLiveness(capability, supervisorPid, {});
  } catch (rebindError) {
    // Every failure exit of this function must take the child with it. The
    // executor is parked at its start gate waiting for frames that will now
    // never come, and its live handle would keep this CLI's event loop alive
    // after the outer request already reported refusal — a privileged flow
    // hung on a process nothing supervises. The throwing guards above kill
    // before throwing for the same reason.
    child.kill("SIGTERM");
    throw rebindError;
  }
  return new Promise((resolve, reject) => {
    const restoreHolder = async (): Promise<void> => {
      await rebindUpdateMutationCapabilityLiveness(capability, process.pid, {});
    };
    // Assumes the dispatch tail has ALREADY been awaited by the caller.
    const settleFailureAfterTail = async (error: Error): Promise<void> => {
      if (actuatorGroupId !== null) {
        if (process.platform === "win32") {
          // Node has no Job-object membership proof. Keep the token published
          // with retain-on-death so release refuses to unlink it; a repair can
          // resolve this fail-closed state, but no contender can race an
          // actuator whose tree we cannot positively enumerate.
          reject(error);
          return;
        }
        await terminateAndReapProcessGroup(actuatorGroupId);
      }
      await restoreHolder();
      reject(error);
    };
    const settleFailure = async (error: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      // The dispatch tail FIRST, before any teardown or restoration: a
      // handler still mid-flight holds real work (an `execute`'s service
      // stop, a `bind-actuator`'s publication), and restoring the holder
      // under it re-opens exactly the ordering this settlement exists to
      // close. The tail never rejects (every link catches into `refuse`),
      // and no new frames can arrive after `close`, so this await is
      // bounded by work already accepted.
      await dispatchTail;
      await settleFailureAfterTail(error);
    };
    onTermination = (): void => {
      if (settled) return;
      const event = termination;
      if (event === null) return;
      if (event.kind === "spawn-error") {
        void settleFailure(event.error).catch(reject);
        return;
      }
      settled = true;
      void (async () => {
        // The dispatch tail BEFORE classification, not merely before the
        // teardown: `completed` is set by a handler QUEUED on the tail, so
        // an executor that wrote its `complete` frame and closed during the
        // initial liveness rebind has its completion still in flight right
        // here. Reading `completed` first classified that clean exit 0 as
        // `maintenance executor exited (0, none)` — a finished platform
        // install or uninstall reported as a failure.
        await dispatchTail;
        const completion: { readonly value: unknown } | null = completed;
        if (completion !== null && event.code === 0) {
          if (actuatorGroupId !== null && process.platform !== "win32") {
            await waitForProcessGroupExit(actuatorGroupId);
          }
          await restoreHolder();
          resolve(completion.value);
          return;
        }
        await settleFailureAfterTail(
          new Error(
            `maintenance executor exited (${event.code ?? "null"}, ${event.signal ?? "none"})`,
          ),
        );
      })().catch(reject);
    };
    // Arm dispatch and drain whatever the capture accumulated during the
    // rebind, IN THIS ORDER — frames first, then the recorded termination.
    // A completed executor that died mid-rebind has its `complete` frame in
    // the buffer and its `close` in `termination`; draining first is what
    // lets the classification below see the completion it earned.
    frameDispatchArmed = true;
    drainFrames();
    // The executor can have terminated while the liveness rebind above was in
    // flight; the recorded evidence is reconciled here, once the supervision
    // promise owns settlement.
    if (termination !== null) onTermination();
  });
}

async function handleRootExecutorRequest(
  request: unknown,
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  stdin: NodeJS.WritableStream,
  finish: (value: unknown) => void,
  refuse: (message: string) => void,
  supervisorPid: number,
  setActuatorGroup: (groupId: number) => void,
): Promise<void> {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request)
  ) {
    refuse("maintenance executor request was malformed");
    return;
  }
  const value = request as Record<string, unknown>;
  if (value.kind === "complete") {
    finish(value.value);
    return;
  }
  if (
    value.kind === "bind-actuator" &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    // > 1, not > 0, same floor as the lock parsers (cross-process-lock,
    // host-update-attempt-liveness): this value becomes a NEGATED
    // process-group target, and `kill(-1, ...)` is "every process I may
    // signal", not group 1 — from a root maintenance lease that is a
    // system-wide signal.
    value.pid > 1
  ) {
    await requireCliUpdateMutationCapability(capability, contenderOptions);
    // C remains the publisher, while D's detached group supplies supplemental
    // kernel liveness after a hard C death. D waits at its start gate until
    // this atomic token-preserving publication succeeds, so B always knows
    // the exact group before any irreversible edge can run.
    await rebindUpdateMutationCapabilityLiveness(capability, supervisorPid, {
      supervisedProcessGroupId: value.pid,
      retainOnPublisherDeath: true,
    });
    setActuatorGroup(value.pid);
    stdin.write(`${JSON.stringify({ kind: "actuator-bound" })}\n`);
    return;
  }
  if (value.kind === "verify" && typeof value.operation === "string") {
    await requireCliUpdateMutationCapability(capability, contenderOptions);
    stdin.write(`${JSON.stringify({ kind: "verified" })}\n`);
    return;
  }
  if (
    value.kind === "execute" &&
    (value.action === "host-stop" || value.action === "host-uninstall-all")
  ) {
    await executeAction(value.action, capability, contenderOptions);
    stdin.write(`${JSON.stringify({ kind: "executed" })}\n`);
    return;
  }
  refuse("maintenance executor requested an unsupported action");
}

// Ceiling on proving a supervised actuator group gone, on both the clean and
// the terminating path. Without it, ONE surviving group member (a
// SIGKILL-resistant D-state process, or a descendant that double-forked into
// the group) parks these polls forever: the supervision promise never
// settles, `runHostMaintenanceLease` never returns, and the update-attempt
// capability stays held by a process nobody is watching. Hitting the deadline
// throws, and every reject path here deliberately SKIPS `restoreHolder` — the
// published retain-on-death token stays, so no contender can race the group
// we failed to prove dead. That wedges THIS lease, not the machine.
const PROCESS_GROUP_EXIT_DEADLINE_MS = 60_000;

// Executor protocol frames are single JSON lines of at most a few KiB; the
// bound exists so a damaged executor streaming an unterminated line costs a
// terminated supervision, never an unbounded accumulation in the CLI.
const EXECUTOR_PROTOCOL_BUFFER_LIMIT_BYTES = 1024 * 1024;

async function terminateAndReapProcessGroup(groupId: number): Promise<void> {
  try {
    process.kill(-groupId, "SIGTERM");
  } catch {
    // The group may have completed while C was reporting its failure. The
    // liveness wait below, not a failed signal, is the proof it is safe to
    // hand publication back to B.
  }
  const escalationAt = Date.now() + 2_000;
  const deadline = Date.now() + PROCESS_GROUP_EXIT_DEADLINE_MS;
  let escalated = false;
  for (;;) {
    const liveness = processGroupLiveness(groupId);
    if (liveness === "gone") return;
    if (liveness === "indeterminate") {
      throw new Error("could not prove supervised actuator group exited");
    }
    if (!escalated && Date.now() >= escalationAt) {
      escalated = true;
      try {
        process.kill(-groupId, "SIGKILL");
      } catch {
        // Re-probe on the next iteration; this can mean the group exited.
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "supervised actuator group survived SIGKILL past the exit deadline",
      );
    }
    await waitForMaintenanceProcessGroupPoll();
  }
}

async function waitForProcessGroupExit(groupId: number): Promise<void> {
  const deadline = Date.now() + PROCESS_GROUP_EXIT_DEADLINE_MS;
  for (;;) {
    const liveness = processGroupLiveness(groupId);
    if (liveness === "gone") return;
    if (liveness === "indeterminate") {
      throw new Error("could not prove supervised actuator group exited");
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "supervised actuator group did not exit before the deadline",
      );
    }
    await waitForMaintenanceProcessGroupPoll();
  }
}

function processGroupLiveness(
  groupId: number,
): "live" | "gone" | "indeterminate" {
  try {
    process.kill(-groupId, 0);
    return "live";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) {
      return "indeterminate";
    }
    if (error.code === "ESRCH") return "gone";
    if (error.code === "EPERM") return "live";
    return "indeterminate";
  }
}

function waitForMaintenanceProcessGroupPoll(): Promise<void> {
  return new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
}

async function executeAction(
  action: HostMaintenanceLeaseAction,
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
): Promise<void> {
  await withCliAttemptMutation(capability, contenderOptions, async () => {
    const environment = contenderOptions.environment;
    if (action === "host-stop") {
      await stopHostServiceWithAttempt(
        capability,
        contenderOptions,
        createServiceController(),
        serviceLabelFor(environment),
        { force: false },
      );
      return;
    }
    const args: HostUninstallArgs = { all: true };
    await runHostUninstallWithAttempt(
      args,
      {
        environment,
        logger: createCliLogger(environment),
        progress: () => undefined,
      },
      {
        createServiceController,
        uninstallHost,
        // Same wiring as `buildHostUninstallCommand`: liveness comes from
        // process identity against the published pid metadata, never from a
        // resolved teardown call.
        readPublishedHost: async (env) => {
          const metadata = await readHostPidMetadata(env);
          if (metadata === null) return null;
          return {
            pid: metadata.pid,
            startIdentity: metadata.processStartIdentity,
          };
        },
        probeProcessExited: getPublishedProcessIdentityVerdict,
      },
      capability,
    );
  });
}

function parseRequest(line: string): LeaseRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.v !== HOST_MAINTENANCE_LEASE_PROTOCOL_VERSION ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.kind !== "string"
  ) {
    return null;
  }
  if (
    value.kind === "execute-root" &&
    isRootMaintenanceExecutor(value.executor)
  ) {
    return {
      v: value.v,
      id: value.id,
      kind: "execute-root",
      executor: value.executor,
    };
  }
  if (value.kind === "verify" && typeof value.operation === "string") {
    return {
      v: value.v,
      id: value.id,
      kind: "verify",
      operation: value.operation,
    };
  }
  if (
    value.kind === "execute" &&
    (value.action === "host-stop" || value.action === "host-uninstall-all")
  ) {
    return { v: value.v, id: value.id, kind: "execute", action: value.action };
  }
  if (value.kind === "release") {
    return { v: value.v, id: value.id, kind: "release" };
  }
  return null;
}

function isRootMaintenanceExecutor(
  value: unknown,
): value is RootMaintenanceExecutor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const executor = value as Record<string, unknown>;
  return (
    typeof executor.runtime === "string" &&
    executor.runtime.length > 0 &&
    typeof executor.script === "string" &&
    executor.script.length > 0 &&
    (executor.operation === "cloud-macos-install" ||
      executor.operation === "cloud-platform-install" ||
      executor.operation === "cloud-uninstall" ||
      executor.operation === "standalone-uninstall") &&
    executor.payload !== null &&
    typeof executor.payload === "object" &&
    !Array.isArray(executor.payload)
  );
}

function writeProtocol(response: LeaseResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
