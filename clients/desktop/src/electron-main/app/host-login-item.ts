import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import {
  classifyLaunchctlPrintResult,
  deriveWedgeVerdict,
  type ProbeCommandResult,
} from "@traycer-clients/shared/host-lifecycle";
import { access, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { config, isDevBuild } from "../../config";
import {
  getHostFsLayout,
  labelForEnvironment,
  smAppServiceAgentLabelId,
  userLaunchAgentPlistPath,
} from "../host/host-paths";
import type { Environment } from "../host/host-paths";
import { isHostRemovedByUser } from "../host/host-removal-state";
import { log } from "./logger";

// The desktop never registers this label: it only cleans it up (legacy plist removal, bootout, old-serviceName unregister) inside the register cycle.
const CLI_HOST_LABEL = labelForEnvironment(config.environment).id;
const HOST_AGENT_LABEL = smAppServiceAgentLabelId(CLI_HOST_LABEL);
const HOST_SERVICE_NAME = `${HOST_AGENT_LABEL}.plist`;
const LEGACY_HOST_SERVICE_NAME = `${CLI_HOST_LABEL}.plist`;

// Every SMAppService mutation for the host label must flow through this promise tail.
// Each caller is already independently exclusive at the `HostController` level.
let hostLoginItemRegistrationTail: Promise<void> = Promise.resolve();

export function withHostLoginItemRegistrationLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = hostLoginItemRegistrationTail.then(operation);
  hostLoginItemRegistrationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export type HostLoginItemStatus =
  | "enabled"
  | "requires-approval"
  | "not-registered"
  | "not-found"
  | "not-supported";

export type RegisterHostLoginItemResult =
  | HostLoginItemStatus
  | "removed-by-user"
  | "deferred-busy"
  /** Cycle refused to begin; nothing was booted out. Do not treat as a completed register. */
  | "parked";

type LoginItemRegistrationSnapshot = {
  readonly primary: HostLoginItemStatus | null;
  readonly legacy: HostLoginItemStatus | null;
  /** A raw legacy LaunchAgent cannot be restored exactly through Electron. */
  /** Tri-state: `unreadable` is disqualifying; `present` is migration work. */
  readonly legacyManifest: "present" | "absent" | "unreadable";
};

// The dev slot never owns the login item: its host is managed by the `make dev-desktop` orchestrator / CLI, not SMAppService.
export async function hostManagesHostLoginItem(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (isDevBuild) return false;
  // Outside Electron - eg unit tests - `process.resourcesPath` is unset.
  // No bundle, no in-bundle plist, no host-owned registration.
  if (
    typeof process.resourcesPath !== "string" ||
    process.resourcesPath.length === 0
  ) {
    return false;
  }
  return fileExists(inAppLaunchAgentPlistPath());
}

export function readHostLoginItemStatus(): HostLoginItemStatus {
  return readLoginItemStatus(HOST_SERVICE_NAME);
}

function readLoginItemStatus(serviceName: string): HostLoginItemStatus {
  const evidence = readLoginItemStatusEvidence(serviceName);
  if (evidence.kind === "read") return evidence.status;
  // Existing observational callers retain their stable coarse projection.
  // Destructive transaction snapshots use the evidence function directly and
  // treat this path as un-restorable rather than folding it into absence.
  return "not-registered";
}

type LoginItemStatusEvidence =
  | { readonly kind: "read"; readonly status: HostLoginItemStatus }
  | { readonly kind: "unreadable" };

function readLoginItemStatusEvidence(
  serviceName: string,
): LoginItemStatusEvidence {
  try {
    const settings = app.getLoginItemSettings({
      type: "agentService",
      serviceName,
    });
    return { kind: "read", status: normalizeStatus(settings.status) };
  } catch (err) {
    log.warn("[host-login-item] getLoginItemSettings threw", err);
    return { kind: "unreadable" };
  }
}

const REGISTER_STATUS_POLL_DEADLINE_MS = 1500;
const REGISTER_STATUS_POLL_INTERVAL_MS = 100;

/**
 * Caller must have confirmed `hostManagesHostLoginItem()` and installed the host bytes first.
 * On macOS 26+, `launchctl bootout` must run before SMAppService register to flush a stale LWCR.
 */
export function registerHostLoginItem(
  revalidateBeforeBootout: (() => Promise<boolean>) | undefined,
): Promise<RegisterHostLoginItemResult> {
  return withHostLoginItemRegistrationLock(() =>
    registerHostLoginItemUnserialized(revalidateBeforeBootout),
  );
}

async function mutationAllowed(
  revalidateBeforeMutation: (() => Promise<boolean>) | null | undefined,
): Promise<boolean> {
  return revalidateBeforeMutation === null ||
    revalidateBeforeMutation === undefined
    ? true
    : revalidateBeforeMutation();
}

async function registerHostLoginItemUnserialized(
  revalidateBeforeBootout: (() => Promise<boolean>) | undefined,
): Promise<RegisterHostLoginItemResult> {
  if (await isHostRemovedByUser()) {
    log.info(
      "[host-login-item] register skipped - host removed by user on this device",
    );
    return "removed-by-user";
  }

  if (!(await mutationAllowed(revalidateBeforeBootout))) {
    log.info(
      "[host-login-item] register cycle deferred - caller's guard failed once dequeued from the registration lock (host is no longer idle)",
    );
    return "deferred-busy";
  }

  const plistPath = inAppLaunchAgentPlistPath();
  // Snapshot before the first legacy bootout/removal.
  // It is authoritative evidence for deciding whether we may begin, but it is never used to compensate after authority loss: Electron exposes no BTM transaction/CAS and a stale.
  const priorRegistration = await snapshotLoginItemRegistration();
  if (!(await canBeginDestructiveRegistration(priorRegistration))) {
    // We have no transaction primitive that can recreate an arbitrary BTM approval state, a loaded raw LaunchAgent, or a bundle whose helper identity changed under us.
    // Do not pretend a plist digest is enough to undo those edges.
    log.warn(
      "[host-login-item] registration parked: prior registration cannot be restored exactly",
      {
        primary: priorRegistration.primary,
        legacy: priorRegistration.legacy,
        legacyManifest: priorRegistration.legacyManifest,
      },
    );
    return "parked";
  }

  if (!(await retireLegacyLabelRegistrations(revalidateBeforeBootout))) {
    parkRegistrationAfterAuthorityLoss("legacy registration retirement");
    return "deferred-busy";
  }

  {
    const bootout = await bootoutStaleAgent(
      HOST_AGENT_LABEL,
      revalidateBeforeBootout,
    );
    if (bootout === "authority-lost") {
      parkRegistrationAfterAuthorityLoss("primary launchctl bootout");
      return "deferred-busy";
    }
    // "bootout-failed" proceeds: this is the REGISTER cycle, where the
    // docstring's best-effort promise holds  -  the worst case is the pre-fix
    // behavior for this one call, and the register below re-derives state.
  }

  const clearedOk = await setLoginItemSettingsWithGuard(
    false,
    HOST_SERVICE_NAME,
    revalidateBeforeBootout,
  );
  if (clearedOk === null) {
    parkRegistrationAfterAuthorityLoss("primary SMAppService clear");
    return "deferred-busy";
  }
  if (!clearedOk) {
    return "not-registered";
  }
  const cleared = readHostLoginItemStatus();
  log.info("[host-login-item] SMAppService cleared prior registration", {
    serviceName: HOST_SERVICE_NAME,
    plistPath,
    status: cleared,
  });

  const registeredOk = await setLoginItemSettingsWithGuard(
    true,
    HOST_SERVICE_NAME,
    revalidateBeforeBootout,
  );
  if (registeredOk === null) {
    // A stale contender must not recreate a login item from mutable current bundle bytes, so park for a freshly admitted repair instead of compensating after authority is gone.
    parkRegistrationAfterAuthorityLoss("primary SMAppService register");
    return "deferred-busy";
  }
  if (!registeredOk) {
    return "not-registered";
  }
  const status = await pollRegisterStatusUntilSettled();
  log.info("[host-login-item] SMAppService register result", {
    serviceName: HOST_SERVICE_NAME,
    plistPath,
    status,
  });
  if (status === "enabled") {
    const markerClearedUnderAuthority = await clearPendingLoginItemRevision(
      config.environment,
      revalidateBeforeBootout,
    );
    if (!markerClearedUnderAuthority) {
      parkRegistrationAfterAuthorityLoss("pending login-item revision removal");
      return "deferred-busy";
    }
  }
  return status;
}

/**
 * 3. Unregister the old serviceName (`<cli-label>.plist`) - drops the old app-scoped BTM record on machines that were SMAppService-registered under the shared label before the split.
 * Every step is best-effort (warn + continue): the agent-label register does not depend on any of them, and a failed cleanup leaves the machine no worse than before the cycle ran.
 */
/** Remove the raw CLI `RunAtLoad` manifest and PROVE it is gone. */
async function removeCliLabelManifestProvably(
  revalidateBeforeMutation: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  const removed = await removeCliLabelManifest(revalidateBeforeMutation);
  if (removed === "deferred" || removed === "failed") return false;
  if (removed === "removed") {
    // `rm(force)` cannot distinguish "removed it" from "there was nothing there", and a manifest that reappears - a concurrent CLI install, a race with the launch repair.
    const after = await probeCliLabelManifest(
      userLaunchAgentPlistPath(CLI_HOST_LABEL),
    );
    if (after.kind !== "absent") {
      log.warn(
        "[host-login-item] CLI LaunchAgent manifest was not provably absent after removal - parking",
        { probe: after.kind },
      );
      return false;
    }
  }
  return true;
}

async function retireLegacyLabelRegistrations(
  revalidateBeforeMutation: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!(await removeCliLabelManifestProvably(revalidateBeforeMutation))) {
    return false;
  }
  {
    const bootout = await bootoutStaleAgent(
      CLI_HOST_LABEL,
      revalidateBeforeMutation,
    );
    if (bootout === "authority-lost") return false;
    // A bootout failure leaves only the RUNNING legacy instance, which cannot return once both durable anchors are gone.
  }
  const unregistered = await setLoginItemSettingsWithGuard(
    false,
    LEGACY_HOST_SERVICE_NAME,
    revalidateBeforeMutation,
  );
  if (unregistered === null) return false;
  if (!unregistered) {
    log.warn(
      "[host-login-item] legacy-label SMAppService clear failed - parking the retirement",
      { serviceName: LEGACY_HOST_SERVICE_NAME },
    );
    return false;
  }
  log.info("[host-login-item] retired legacy-label SMAppService registration", {
    serviceName: LEGACY_HOST_SERVICE_NAME,
    unregistered,
  });
  return true;
}

// `hasPendingLoginItemRevision` documents a read error as "no pending revision" so an FS hiccup never blocks the ensure fast path, and `hostManagesHostLoginItem` fails safe to "not.
type CliManifestProbe =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly cause: unknown };

async function probeCliLabelManifest(
  manifest: string,
): Promise<CliManifestProbe> {
  try {
    await access(manifest, constants.F_OK);
    return { kind: "present" };
  } catch (cause) {
    // ENOENT - and only ENOENT - is positive proof there is no manifest.
    // EACCES on the containing directory means we could not look.
    const missing =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT";
    return missing ? { kind: "absent" } : { kind: "unreadable", cause };
  }
}

/** Single implementation shared by the register cycle's step 1 and the launch-time repair, so the two can never drift on what "retired" means. */
async function removeCliLabelManifest(
  revalidateBeforeRemoval: (() => Promise<boolean>) | null | undefined,
): Promise<"removed" | "absent" | "failed" | "deferred"> {
  const manifest = userLaunchAgentPlistPath(CLI_HOST_LABEL);
  const probe = await probeCliLabelManifest(manifest);
  if (probe.kind === "absent") return "absent";
  if (probe.kind === "unreadable") {
    // No `rm` attempt either - `rm(force)` cannot tell "removed" from "was never there", so on a path we could not even read it would report a removal that may not have happened.
    // Hedged wording for the same reason: we cannot see whether a manifest is there at all.
    log.warn(
      "[host-login-item] could not read the CLI LaunchAgent manifest, so it was not removed — if one is present it may auto-start a competing host at next login",
      { manifest, err: probe.cause },
    );
    return "failed";
  }
  try {
    if (!(await mutationAllowed(revalidateBeforeRemoval))) return "deferred";
    await rm(manifest, { force: true });
  } catch (err) {
    log.warn(
      "[host-login-item] failed to remove CLI LaunchAgent manifest — the CLI label may auto-start a competing host at next login",
      { manifest, err },
    );
    return "failed";
  }
  log.info("[host-login-item] removed CLI LaunchAgent manifest", { manifest });
  return "removed";
}

/**
 * Returned (rather than logged and swallowed) so the startup caller can log one line and tests can assert the gates without reading the logger.
 * Steady state, and never inferred from a directory we could not read.
 */
export type LaunchCompetingRegistrationRepair =
  | "not-applicable"
  | "agent-not-enabled"
  | "agent-possibly-wedged"
  | "nothing-to-retire"
  | "retired"
  | "retire-failed";

export type AgentWedgeProbeResult = "wedged" | "not-wedged" | "unknown";

type AgentPrintRunner = (target: string) => Promise<ProbeCommandResult>;

// Test seam, mirroring `runLaunchctlBootout`'s injected spawn: the suite
// must never read the developer's real launchd domain. Production always
// runs the real execFile.
let agentPrintRunnerOverride: AgentPrintRunner | null = null;

export function overrideAgentPrintRunnerForTests(
  runner: AgentPrintRunner | null,
): void {
  agentPrintRunnerOverride = runner;
}

// execFile's rejection shape: numeric `code` for a non-zero exit (output
// still captured), string errno for a spawn failure, `killed` on timeout.
type ExecFileProbeFailure = {
  readonly code: string | number | undefined;
  readonly killed: boolean | undefined;
  readonly signal: NodeJS.Signals | undefined;
};

function runAgentPrint(target: string): Promise<ProbeCommandResult> {
  if (agentPrintRunnerOverride !== null) {
    return agentPrintRunnerOverride(target);
  }
  return new Promise((resolve) => {
    execFile(
      "/bin/launchctl",
      ["print", target],
      { timeout: BOOTOUT_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({
            exitCode: 0,
            stdout,
            stderr,
            timedOut: false,
            spawnFailed: false,
            signal: null,
          });
          return;
        }
        const failure = error as ExecFileProbeFailure;
        if (typeof failure.code === "string") {
          resolve({
            exitCode: -1,
            stdout: "",
            stderr: "",
            timedOut: false,
            spawnFailed: true,
            signal: null,
          });
          return;
        }
        resolve({
          exitCode: typeof failure.code === "number" ? failure.code : -1,
          stdout,
          stderr,
          timedOut: failure.killed === true,
          spawnFailed: false,
          signal: failure.signal ?? null,
        });
      },
    );
  });
}

async function probeAgentWedgeForRetirement(): Promise<AgentWedgeProbeResult> {
  if (typeof process.getuid !== "function") return "unknown";
  const target = `gui/${process.getuid()}/${HOST_AGENT_LABEL}`;
  let result: ProbeCommandResult;
  try {
    result = await runAgentPrint(target);
  } catch {
    return "unknown";
  }
  const probe = classifyLaunchctlPrintResult(result, null, HOST_AGENT_LABEL);
  if (probe.kind === "absent") return "not-wedged";
  if (probe.kind === "indeterminate") return "unknown";
  const verdict = deriveWedgeVerdict(probe, {
    loginItemEnabled: null,
    hasPidMetadata: false,
    hasAttemptProgress: false,
  });
  return verdict.kind === "wedged" ? "wedged" : "not-wedged";
}

/**
 * Both jobs are `RunAtLoad`, so every login starts two hosts against one data dir.
 * Same availability bias as `findLiveIncumbentHost` in the CLI: never leave a machine with no host to prevent a duplicate.
 */
export function retireCompetingCliRegistrationAtLaunch(): Promise<LaunchCompetingRegistrationRepair> {
  return withHostLoginItemRegistrationLock(async () => {
    const outcome = await retireCompetingCliRegistrationUnserialized(null);
    // The null arm is reachable only when a contender guard was supplied.
    // Keep this legacy no-guard API total without fabricating a retirement.
    return outcome ?? "not-applicable";
  });
}

export async function retireCompetingCliRegistrationAtLaunchGuarded(
  revalidateBeforeRemoval: () => Promise<boolean>,
): Promise<LaunchCompetingRegistrationRepair | null> {
  return withHostLoginItemRegistrationLock(() =>
    retireCompetingCliRegistrationUnserialized(revalidateBeforeRemoval),
  );
}

async function retireCompetingCliRegistrationUnserialized(
  revalidateBeforeRemoval: (() => Promise<boolean>) | null,
): Promise<LaunchCompetingRegistrationRepair | null> {
  if (!(await hostManagesHostLoginItem())) return "not-applicable";
  // A host the user removed on this device must not be repaired back into
  // existence; `unregisterHostLoginItem` deliberately leaves the machine
  // alone once the sentinel is set.
  if (await isHostRemovedByUser()) return "not-applicable";
  if (readHostLoginItemStatus() !== "enabled") return "agent-not-enabled";
  const wedge = await probeAgentWedgeForRetirement();
  if (wedge !== "not-wedged") {
    log.warn(
      "[host-login-item] skipping competing-CLI retirement - the agent may not be spawnable",
      { probe: wedge },
    );
    return "agent-possibly-wedged";
  }
  // No pre-guard here: `removeCliLabelManifest` revalidates at its own rm
  // edge (the probe before it is read-only), so a second copy of the same
  // admission check only invited the two to drift.
  const outcome = await removeCliLabelManifest(revalidateBeforeRemoval);
  if (outcome === "deferred") return null;
  if (outcome === "absent") return "nothing-to-retire";
  if (outcome === "failed") return "retire-failed";
  // The same proof the register and uninstall paths demand: `rm(force)` cannot tell "removed it" from "there was nothing there", and a manifest recreated underneath us (a concurrent.
  const after = await probeCliLabelManifest(
    userLaunchAgentPlistPath(CLI_HOST_LABEL),
  );
  if (after.kind !== "absent") {
    log.warn(
      "[host-login-item] CLI LaunchAgent manifest was not provably absent after the launch repair",
      { probe: after.kind },
    );
    return "retire-failed";
  }
  log.info(
    "[host-login-item] retired competing CLI registration (dual-registration repair)",
  );
  return "retired";
}

/** Best-effort: a read error (permissions, race) is treated as "no pending revision" so a transient FS hiccup never blocks the ensure fast path. */
export async function hasPendingLoginItemRevision(
  environment: Environment,
): Promise<boolean> {
  return fileExists(getHostFsLayout(environment).pendingLoginItemRevisionFile);
}

let appliedPendingRevisionMtimeMs: number | null = null;

export async function hasUnappliedPendingLoginItemRevision(
  environment: Environment,
): Promise<boolean> {
  const markerPath = getHostFsLayout(environment).pendingLoginItemRevisionFile;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(markerPath)).mtimeMs;
  } catch {
    // Absent or unreadable - same fail-open posture as
    // `hasPendingLoginItemRevision` ("nothing pending").
    return false;
  }
  return (
    appliedPendingRevisionMtimeMs === null ||
    mtimeMs !== appliedPendingRevisionMtimeMs
  );
}

async function clearPendingLoginItemRevision(
  environment: Environment,
  revalidateBeforeRemoval: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  const markerPath = getHostFsLayout(environment).pendingLoginItemRevisionFile;
  try {
    if (!(await mutationAllowed(revalidateBeforeRemoval))) return false;
    await rm(markerPath, { force: true });
    // Cleared cleanly - there is no lingering marker to suppress.
    appliedPendingRevisionMtimeMs = null;
    return true;
  } catch (err) {
    // M-B: the marker for the revision we just applied could not be removed.
    // Latch its mtime so `hasUnappliedPendingLoginItemRevision` stops treating
    // it as pending; a newer revision (different mtime) still re-arms.
    try {
      appliedPendingRevisionMtimeMs = (await stat(markerPath)).mtimeMs;
    } catch {
      appliedPendingRevisionMtimeMs = null;
    }
    log.warn(
      "[host-login-item] failed to clear pending LaunchAgent revision marker",
      { err },
    );
    return true;
  }
}

/** Caller must have confirmed `hostManagesHostLoginItem()` first; on every other build there is no SMAppService registration to remove. */
export function unregisterHostLoginItem(): Promise<void> {
  return withHostLoginItemRegistrationLock(async () => {
    await unregisterHostLoginItemUnserialized(undefined);
  });
}

/** The guard is evaluated while the registration serialization lock is held and just before either bootout, so a capability that was released while queued cannot remove a live. */
export async function unregisterHostLoginItemGuarded(
  revalidateBeforeBootout: () => Promise<boolean>,
): Promise<boolean> {
  return withHostLoginItemRegistrationLock(async () => {
    return unregisterHostLoginItemUnserialized(revalidateBeforeBootout);
  });
}

async function unregisterHostLoginItemUnserialized(
  revalidateBeforeMutation: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  const priorRegistration = await snapshotLoginItemRegistration();
  if (!(await canBeginRegistrationRemoval(priorRegistration))) {
    log.warn(
      "[host-login-item] unregister parked: prior registration is not in a removable state",
    );
    return false;
  }
  const primaryBootout = await bootoutStaleAgent(
    HOST_AGENT_LABEL,
    revalidateBeforeMutation,
  );
  if (primaryBootout === "authority-lost") {
    parkRegistrationAfterAuthorityLoss("primary uninstall bootout");
    return false;
  }
  // Not an authority loss - no park; the caller may retry.
  if (primaryBootout === "bootout-failed") {
    log.warn(
      "[host-login-item] primary uninstall bootout failed - teardown is not complete",
      { label: HOST_AGENT_LABEL },
    );
    return false;
  }
  const legacyBootout = await bootoutStaleAgent(
    CLI_HOST_LABEL,
    revalidateBeforeMutation,
  );
  if (legacyBootout === "authority-lost") {
    parkRegistrationAfterAuthorityLoss("legacy uninstall bootout");
    return false;
  }
  if (legacyBootout === "bootout-failed") {
    log.warn(
      "[host-login-item] legacy uninstall bootout failed - teardown is not complete",
      { label: CLI_HOST_LABEL },
    );
    return false;
  }
  let cleared = true;
  if (statusHasClearableRegistration(priorRegistration.primary)) {
    const clearedOutcome = await setLoginItemSettingsWithGuard(
      false,
      HOST_SERVICE_NAME,
      revalidateBeforeMutation,
    );
    if (clearedOutcome === null) {
      parkRegistrationAfterAuthorityLoss("primary uninstall clear");
      return false;
    }
    if (!clearedOutcome) {
      log.warn(
        "[host-login-item] primary SMAppService clear failed - teardown is not complete",
        { serviceName: HOST_SERVICE_NAME },
      );
      return false;
    }
    cleared = clearedOutcome;
  }
  let clearedLegacy = true;
  if (statusHasClearableRegistration(priorRegistration.legacy)) {
    const clearedLegacyOutcome = await setLoginItemSettingsWithGuard(
      false,
      LEGACY_HOST_SERVICE_NAME,
      revalidateBeforeMutation,
    );
    if (clearedLegacyOutcome === null) {
      parkRegistrationAfterAuthorityLoss("legacy uninstall clear");
      return false;
    }
    if (!clearedLegacyOutcome) {
      log.warn(
        "[host-login-item] legacy SMAppService clear failed - teardown is not complete",
        { serviceName: LEGACY_HOST_SERVICE_NAME },
      );
      return false;
    }
    clearedLegacy = clearedLegacyOutcome;
  }
  if (!(await removeCliLabelManifestProvably(revalidateBeforeMutation))) {
    parkRegistrationAfterAuthorityLoss("legacy manifest retirement");
    return false;
  }
  log.info("[host-login-item] SMAppService registration torn down", {
    serviceName: HOST_SERVICE_NAME,
    cleared,
    clearedLegacy,
  });
  return true;
}

async function setLoginItemSettingsWithGuard(
  openAtLogin: boolean,
  serviceName: string,
  revalidateBeforeMutation: (() => Promise<boolean>) | null | undefined,
): Promise<boolean | null> {
  if (!(await mutationAllowed(revalidateBeforeMutation))) return null;
  try {
    app.setLoginItemSettings({
      openAtLogin,
      type: "agentService",
      serviceName,
    });
    return true;
  } catch (err) {
    log.warn("[host-login-item] setLoginItemSettings threw", {
      openAtLogin,
      serviceName,
      err,
    });
    return false;
  }
}

async function snapshotLoginItemRegistration(): Promise<LoginItemRegistrationSnapshot> {
  const primary = readLoginItemStatusEvidence(HOST_SERVICE_NAME);
  const legacy = readLoginItemStatusEvidence(LEGACY_HOST_SERVICE_NAME);
  const legacyManifest = await probeCliLabelManifest(
    userLaunchAgentPlistPath(CLI_HOST_LABEL),
  );
  return {
    primary: primary.kind === "read" ? primary.status : null,
    legacy: legacy.kind === "read" ? legacy.status : null,
    legacyManifest: legacyManifest.kind,
  };
}

/** We therefore reject states whose authoritative status cannot be read before the first destructive edge. */
async function canBeginDestructiveRegistration(
  snapshot: LoginItemRegistrationSnapshot,
): Promise<boolean> {
  return (
    (snapshot.primary === "not-registered" || snapshot.primary === "enabled") &&
    (snapshot.legacy === "not-registered" || snapshot.legacy === "enabled") &&
    // A readable manifest - present OR absent - may enter. `present` is the
    // work; `unreadable` is the only disqualifier, because we cannot retire
    // what we cannot see and must not register a second label beside it.
    snapshot.legacyManifest !== "unreadable"
  );
}

/**
 * Registration is destructive-then-restorative: it boots out and re-registers, so it must refuse any prior state it could not put back.
 * Sharing the registration guard here meant an explicit deregister parked on precisely the state it exists to clear, and a user who had toggled the login item off could never remove.
 */
async function canBeginRegistrationRemoval(
  snapshot: LoginItemRegistrationSnapshot,
): Promise<boolean> {
  // `null` (no readable status) stays refused, exactly as before.
  const removable = (status: HostLoginItemStatus | null): boolean =>
    status !== null;
  return (
    removable(snapshot.primary) &&
    removable(snapshot.legacy) &&
    snapshot.legacyManifest !== "unreadable"
  );
}

function statusHasClearableRegistration(
  status: HostLoginItemStatus | null,
): boolean {
  // `null` cannot reach the clear legs (the entry guard refuses it); if it
  // ever did, attempting the clear is the conservative answer.
  return status !== "not-found" && status !== "not-supported";
}

function parkRegistrationAfterAuthorityLoss(edge: string): void {
  // Do not call SMAppService after the attempt capability disappears.
  log.warn("[host-login-item] registration parked after authority loss", {
    edge,
  });
}

async function pollRegisterStatusUntilSettled(): Promise<HostLoginItemStatus> {
  const deadline = Date.now() + REGISTER_STATUS_POLL_DEADLINE_MS;
  let last: HostLoginItemStatus = readHostLoginItemStatus();
  while (last === "not-registered" && Date.now() < deadline) {
    await sleep(REGISTER_STATUS_POLL_INTERVAL_MS);
    last = readHostLoginItemStatus();
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(raw: string | undefined): HostLoginItemStatus {
  if (
    raw === "enabled" ||
    raw === "requires-approval" ||
    raw === "not-registered" ||
    raw === "not-found" ||
    raw === "not-supported"
  ) {
    return raw;
  }
  return "not-registered";
}

function inAppLaunchAgentPlistPath(): string {
  // `process.resourcesPath` is `<App>.app/Contents/Resources/`; `dirname`
  // brings us to `Contents/` → `Contents/Library/LaunchAgents/<name>.plist`.
  // `HOST_SERVICE_NAME` already includes the `.plist` suffix.
  const contentsDir = dirname(process.resourcesPath);
  return join(contentsDir, "Library", "LaunchAgents", HOST_SERVICE_NAME);
}

const BOOTOUT_TIMEOUT_MS = 5_000;

/**
 * The outcome distinguishes WHY nothing was (or may not have been) cleared, because different callers owe different honesty: - "authority-lost" - the revalidation refused.
 * A register cycle treats this as best-effort and proceeds (worst case is the pre-fix behavior for one call).
 */
type BootoutOutcome = "ok" | "authority-lost" | "bootout-failed";

let bootoutSpawnOverrideForTests: BootoutSpawnFn | null = null;
export function setBootoutSpawnFnForTests(fn: BootoutSpawnFn | null): void {
  bootoutSpawnOverrideForTests = fn;
}

async function bootoutStaleAgent(
  labelId: string,
  revalidateBeforeBootout: (() => Promise<boolean>) | undefined,
): Promise<BootoutOutcome> {
  if (!(await mutationAllowed(revalidateBeforeBootout)))
    return "authority-lost";
  if (process.platform !== "darwin") return "ok";
  if (typeof process.getuid !== "function") return "ok";
  const uid = process.getuid();
  const target = `gui/${uid}/${labelId}`;
  try {
    const cleared = await runLaunchctlBootout(
      target,
      bootoutSpawnOverrideForTests ??
        ((command, args, options) => spawn(command, args, options)),
    );
    return cleared ? "ok" : "bootout-failed";
  } catch (err) {
    log.warn("[host-login-item] launchctl bootout threw", { target, err });
    return "bootout-failed";
  }
}

export interface BootoutChildProcess {
  once(event: "error", listener: (err: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: "SIGTERM"): boolean;
}
export type BootoutSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { stdio: "ignore" },
) => BootoutChildProcess;

/** Exported for unit tests; never call this from new production code - use `bootoutStaleAgent` instead. */
export function runLaunchctlBootout(
  target: string,
  spawnFn: BootoutSpawnFn,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnFn("/bin/launchctl", ["bootout", target], {
      stdio: "ignore",
    });
    let settled = false;
    const settle = (cleared: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(cleared);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      log.warn("[host-login-item] launchctl bootout exceeded timeout, killed", {
        target,
        timeoutMs: BOOTOUT_TIMEOUT_MS,
      });
      settle(false);
    }, BOOTOUT_TIMEOUT_MS);
    child.once("error", (err) => {
      log.warn("[host-login-item] launchctl bootout errored", {
        target,
        err,
      });
      settle(false);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        log.info("[host-login-item] launchctl bootout cleared BTM entry", {
          target,
        });
      } else if (code === 3 || code === 5 || code === 113) {
        // "Not loaded"  -  nothing to clear. Common on first install.
        log.info(
          "[host-login-item] launchctl bootout: agent not loaded (clean state)",
          { target, code },
        );
      } else {
        log.warn(
          "[host-login-item] launchctl bootout returned unexpected exit code — BTM may still hold a stale LWCR",
          { target, code },
        );
      }
      settle(code === 0 || code === 3 || code === 5 || code === 113);
    });
  });
}

function fileExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}
