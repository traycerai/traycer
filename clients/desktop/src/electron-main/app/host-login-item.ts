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

// macOS Login Items / Background Activity attribution for the host.
//
// Only `SMAppService` (callable from inside the .app bundle) produces a
// polished "Traycer" + icon row attributed to the app. So the desktop owns
// this one piece: it registers the in-bundle LaunchAgent plist via
// SMAppService, which both attributes the Login Items row to the app and
// loads + starts the agent. The host's install + lifecycle (and all
// launchd interaction) remain CLI-owned; the desktop installs the host
// bytes via `traycer host ensure --no-service-register`, then registers
// the login item here.
//
// This runs POST sign-in (auth-first boot), not at launch.

// The CLI-owned label for this environment (`ai.traycer.host[.env]`) - the
// label raw `launchctl` installs (and every pre-label-split registration)
// live under. The desktop never registers this label: it only cleans it up
// (legacy plist removal, bootout, old-serviceName unregister) inside the
// register cycle.
const CLI_HOST_LABEL = labelForEnvironment(config.environment).id;
// The label the desktop actually registers via SMAppService
// (`<cli-label>.agent`). Split from the CLI label because BTM matches
// SMAppService registrations to legacy `~/Library/LaunchAgents` records by
// label, and such a record survives file deletion and bootout - see
// `smAppServiceAgentLabelId`'s doc for the full mechanism and the lockstep
// sites. Matches the in-bundle plist written by `desktop-install-cloud.js`
// (`hostAgentLabel`) and `scripts/prepack/inject-host-launch-agent.cjs`;
// SMAppService resolves the plist by this exact filename.
const HOST_AGENT_LABEL = smAppServiceAgentLabelId(CLI_HOST_LABEL);
const HOST_SERVICE_NAME = `${HOST_AGENT_LABEL}.plist`;
// The serviceName this app registered BEFORE the label split. The bundle
// keeps shipping this plist inert (never registered) for a few releases so
// the transition `unregister` below can resolve it and drop the old
// app-scoped BTM record on machines that upgraded from a same-label
// SMAppService install - without the file, SMAppService can't resolve the
// serviceName and the old record would linger as a ghost Login Items row.
const LEGACY_HOST_SERVICE_NAME = `${CLI_HOST_LABEL}.plist`;

// Every SMAppService mutation for the host label must flow through this
// promise tail. `registerHostLoginItem` is a non-atomic bootout → unregister
// → register sequence; `HostController`'s `convergeReady`, `applyStaged`,
// `activateInstalled`, `installVersion`, `respawn`, `recoverIfDown`,
// `freePortAndRestart` (all via `runLockedMacActivationCycle`), and
// `applyPendingLoginItemRevisionIfIdle` can all need it independently.
// Letting any two of them cross that boundary at the same time can leave BTM
// with the stale LWCR this module is designed to clear.
//
// This intentionally serializes rather than coalesces. Each caller is
// already independently exclusive at the `HostController` level - the
// mutation lane for enqueued intents, the desktop cli-lock for
// `applyPendingLoginItemRevisionIfIdle` - so this tail is defense-in-depth
// against the specific SMAppService boundary, not the primary exclusion
// mechanism. The tail always resolves so a failed cycle never wedges later
// callers.
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

/**
 * Electron's `LoginItemSettings.status` is optional - `agentService`
 * registrations always populate it, but the type is shared with launch-item
 * settings that don't. We map every observed value into a closed union so
 * callers (`ensureHost`, the respawn handler) can branch exhaustively
 * instead of inspecting raw Electron strings.
 *
 * - `enabled` - registered AND loaded by launchd. The agent should spawn.
 * - `requires-approval` - registered but disabled by the user in System
 *   Settings → Login Items. launchd refuses to spawn until they re-enable.
 * - `not-registered` - SMAppService has no record of this plist.
 * - `not-found` - the in-bundle plist filename isn't where SMAppService
 *   looks. A packaging bug; never expected at runtime.
 * - `not-supported` - running on a platform/build where SMAppService is
 *   unavailable. Caller MUST gate with `hostManagesHostLoginItem()`.
 */
export type HostLoginItemStatus =
  | "enabled"
  | "requires-approval"
  | "not-registered"
  | "not-found"
  | "not-supported";

/**
 * `registerHostLoginItem`'s result: the SMAppService status the cycle
 * settled on, `removed-by-user` when the locked section found the removal
 * sentinel set and refused to run the cycle at all, or `deferred-busy` when
 * the caller's own `revalidateBeforeBootout` guard failed once the cycle
 * reached the front of the registration lock's queue (see the re-check
 * rationale in `registerHostLoginItemUnserialized`).
 */
export type RegisterHostLoginItemResult =
  | HostLoginItemStatus
  | "removed-by-user"
  | "deferred-busy";

type LoginItemRegistrationSnapshot = {
  readonly primary: HostLoginItemStatus | null;
  readonly legacy: HostLoginItemStatus | null;
  /** A raw legacy LaunchAgent cannot be restored exactly through Electron. */
  /**
   * Tri-state, deliberately NOT a boolean.
   *
   * Collapsing `unreadable` into "present" is what permanently parked the
   * <=1.1.6 upgrade cohort: a present manifest is migration work this cycle
   * exists to perform, while an unreadable one is the only state that is
   * genuinely disqualifying. One bit could not tell them apart, so it refused
   * both - and since `retireLegacyLabelRegistrations` (the only code that
   * removes the manifest) runs AFTER the entry guard, the manifest was never
   * removed, the guard never passed, and registration could never proceed.
   */
  readonly legacyManifest: "present" | "absent" | "unreadable";
};

// True only when this is a shipped macOS build that ships the in-bundle
// LaunchAgent plist. Used by the ensure flow to decide whether the desktop
// owns registration (SMAppService) - and therefore passes
// `--no-service-register` to the CLI - or whether the CLI should register
// the service itself (non-macOS, or a build without the in-bundle plist).
// The dev slot never owns the login item: its host is managed by the
// `make dev-desktop` orchestrator / CLI, not SMAppService.
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

/**
 * Reads the current SMAppService state for the host LaunchAgent without
 * mutating it. Used by the respawn / ensure flows to decide whether the
 * register cycle is needed and to enrich timeout errors with a specific
 * cause (e.g. `requires-approval`).
 */
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
  // Electron's `getLoginItemSettings` is documented as non-throwing on the
  // agentService shape but its underlying SMAppService bridge has thrown
  // on broken BTM states in older macOS minor versions. We catch at this
  // boundary so callers see a stable `not-registered` instead of an
  // unhandled exception that would crash the main process or surface as
  // a raw Node error string to the renderer.
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

/**
 * Window we'll wait for the BTM database commit after a successful
 * `setLoginItemSettings({openAtLogin: true})` call before declaring the
 * status fatal. SMAppService.register returns before BTM has finished
 * persisting the entry on cold-BTM (first install) machines; observed
 * commit lag is sub-100ms but a few iOS-style ms-level retries here
 * costs nothing in steady state and prevents spurious Doctor routing.
 */
const REGISTER_STATUS_POLL_DEADLINE_MS = 1500;
const REGISTER_STATUS_POLL_INTERVAL_MS = 100;

/**
 * Register the in-bundle LaunchAgent as a login item via SMAppService,
 * under the agent label (`<cli-label>.agent`).
 *
 * Caller must have confirmed `hostManagesHostLoginItem()` and installed
 * the host bytes first.
 *
 * Once the cycle is committed (both guards passed), it runs:
 *
 *   1. rm `~/Library/LaunchAgents/<cli-label>.plist` (legacy CLI manifest)
 *   2. `launchctl bootout gui/<uid>/<cli-label>` (legacy/CLI job)
 *   3. unregister the old serviceName `<cli-label>.plist` (transition
 *      cleanup for machines that were SMAppService-registered under the
 *      shared label pre-split)
 *   4. `launchctl bootout gui/<uid>/<agent-label>` (LWCR flush, macOS 26+)
 *   5. SMAppService unregister → register of the agent plist
 *   6. poll status until settled; clear the pending-revision marker on
 *      `enabled`
 *
 * Steps 1–3 exist to prevent a competing host at login (an intact legacy
 * registration would `RunAtLoad` the old CLI's host alongside the new
 * agent) and to drop the old app-scoped record on healthy machines - NOT
 * to make registration succeed. They are best-effort; step 5 does not
 * depend on any of them. They are also deliberately coupled to the
 * committed cycle: a deferred (`deferred-busy` / `removed-by-user`) cycle
 * runs none of them, so a busy host paused mid-update keeps its legacy
 * *job* loaded until a cycle actually proceeds.
 *
 * That coupling no longer extends to the manifest FILE:
 * `retireCompetingCliRegistrationAtLaunch` deletes it on every launch with
 * no busy check. Deliberate - an orphaned loaded job keeps running on
 * launchd's in-memory definition, so the only thing lost is its auto-restart
 * after a crash, and that is precisely the competing host we want gone.
 *
 * The agent-label bootout (step 4) is the load-bearing LWCR step on macOS
 * 26+; the SMAppService unregister → register pair is kept for
 * defense-in-depth on older macOS where the bootout would be a no-op.
 *
 * SMAppService's BTM database caches a Lightweight Code Requirement
 * (LWCR) derived from the agent helper's CDHash at first registration.
 * When `make install-desktop-{staging,production}` replaces the .app
 * on disk, the helper's ad-hoc CDHash changes (ad-hoc signatures are
 * content-derived). On macOS ≤ 25, `SMAppService.unregister`
 * (`setLoginItemSettings({openAtLogin: false})`) drops the BTM entry
 * and the subsequent register installs a fresh LWCR. On macOS 26.5 (and
 * presumably 26+ generally) that path no longer flushes BTM — the
 * entry persists with the *old* CDHash, marked `needs LWCR update | has
 * LWCR` in `launchctl print gui/<uid>/<label>`. launchd then SIGKILLs
 * every spawn inside dyld init with `last exit code = 78: EX_CONFIG`
 * and a `Launch Constraint Violation` crash report. The symptom user-
 * side is empty `~/.traycer/host/<env>/host.log`, the 60s host-
 * ensure readiness wait timing out, and "pid metadata not yet
 * published" in the renderer.
 *
 * `launchctl bootout gui/<uid>/<label>` is the lever that *does* drop
 * the BTM entry on 26+: after bootout, `launchctl print` returns
 * `Could not find service`, and a fresh `SMAppService.register` then
 * installs an LWCR that matches the rebuilt binary's CDHash. Running
 * bootout before the SMAppService cycle is therefore the actual fix;
 * the SMAppService unregister we used to lean on is now belt-and-
 * suspenders for older macOS.
 *
 * Both Electron API calls are caught at this seam - `setLoginItemSettings`
 * can throw on the Objective-C bridge for malformed plists, missing
 * helper sub-app, or unsupported-platform paths. We turn any throw into
 * a `not-registered` return so the caller routes through Doctor with
 * a stable error rather than a raw `TypeError` / `NSError` message.
 *
 * After the register call we poll the status briefly: SMAppService
 * returns from `register` before BTM has committed the entry; a
 * synchronous status read can transiently say `not-registered` for
 * <100ms on cold-BTM (first-install) machines.
 */
// `revalidateBeforeBootout`, when provided, is called INSIDE the locked
// section immediately before `bootoutStaleAgent()` - not just at the call
// site - because a caller's own idle/busy check (e.g.
// `HostController.applyPendingLoginItemRevisionIfIdle`'s `probeHostBusyVerdict`
// probe) can go stale while queued behind another in-flight cycle (every
// `HostController` SMAppService section shares this same lock). Without a
// re-check here, a cycle that was idle when queued could still boot out a
// host that picked up real work while waiting its turn.
// Return `false` from the callback to defer without mutating anything;
// `registerHostLoginItemUnserialized` reports that back as `"deferred-busy"`.
export function registerHostLoginItem(
  revalidateBeforeBootout: (() => Promise<boolean>) | undefined,
): Promise<RegisterHostLoginItemResult> {
  return withHostLoginItemRegistrationLock(() =>
    registerHostLoginItemUnserialized(revalidateBeforeBootout),
  );
}

/**
 * The contender facade supplies this verifier. Keeping the call immediately
 * adjacent to every destructive edge prevents a capability lost while the
 * registration lock was queued from authorizing the rest of a composite
 * SMAppService cycle.
 */
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
  // Re-checked HERE, inside the locked section, not only at the callers'
  // entry points: an ensure can spend minutes streaming the CLI before its
  // register lands on this lock's tail - possibly queued BEHIND an in-app
  // uninstall's `unregisterHostLoginItem()` (which persists the removed-by-
  // user sentinel before taking the lock). Without this check that queued
  // register would re-create the BTM login item right after "Remove
  // Traycer", and BTM would silently respawn the host at the next login.
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
  // Snapshot before the first legacy bootout/removal. It is authoritative
  // evidence for deciding whether we may begin, but it is never used to
  // compensate after authority loss: Electron exposes no BTM transaction/CAS
  // and a stale process must not write a fresh registration.
  const priorRegistration = await snapshotLoginItemRegistration();
  if (!(await canBeginDestructiveRegistration(priorRegistration))) {
    // We have no transaction primitive that can recreate an arbitrary BTM
    // approval state, a loaded raw LaunchAgent, or a bundle whose helper
    // identity changed under us. Do not pretend a plist digest is enough to
    // undo those edges. Park before the first bootout and leave a newly
    // admitted repair to make the next registration decision from current
    // evidence.
    log.warn(
      "[host-login-item] registration parked: prior registration cannot be restored exactly",
    );
    return priorRegistration.primary ?? "not-registered";
  }

  // Steps 1–3: retire every registration under the legacy shared label.
  // Runs only here - after both guards - so a deferred cycle leaves the
  // legacy registration fully intact (see the docstring's coupling
  // invariant).
  if (!(await retireLegacyLabelRegistrations(revalidateBeforeBootout))) {
    parkRegistrationAfterAuthorityLoss("legacy registration retirement");
    return "deferred-busy";
  }

  // Step 4: flush BTM's stale LWCR for the agent label before touching
  // SMAppService. On macOS 26+ this is the load-bearing step —
  // SMAppService.unregister no longer drops the BTM entry, so without
  // bootout the subsequent register hands launchd a stale CDHash and every
  // spawn is SIGKILL'd inside dyld init. See the docstring above for the
  // full mechanism.
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
    // docstring's best-effort promise holds — the worst case is the pre-fix
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
    // A clear may already have committed, but Electron offers no
    // registration transaction/CAS. A stale contender must not recreate a
    // login item from mutable current bundle bytes, so park for a freshly
    // admitted repair instead of compensating after authority is gone.
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
    // Whatever prompted this cycle (a normal ensure, or the already-ready
    // fast path applying a deferred install), the on-disk plist is now the
    // one active in launchd - any pending-revision marker the installer
    // left behind is resolved.
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
 * Steps 1–3 of the register cycle: retire the legacy shared-label
 * registrations so nothing can start a second host beside the agent-label
 * one at the next login.
 *
 *   1. Remove the CLI-written `~/Library/LaunchAgents/<cli-label>.plist`
 *      (pre-1.1.7 installs) - an intact file with an `[enabled]` BTM legacy
 *      record would `RunAtLoad` the old CLI's host alongside the agent.
 *   2. Bootout the legacy/CLI job under `<cli-label>` so a currently-loaded
 *      one stops running against the label we just orphaned.
 *   3. Unregister the old serviceName (`<cli-label>.plist`) - drops the old
 *      app-scoped BTM record on machines that were SMAppService-registered
 *      under the shared label before the split. Resolves against the inert
 *      copy of the old plist the bundle keeps shipping; on machines whose
 *      only old-label record is the untouchable dangling LEGACY record this
 *      is a harmless no-op.
 *
 * Every step is best-effort (warn + continue): the agent-label register
 * does not depend on any of them, and a failed cleanup leaves the machine
 * no worse than before the cycle ran.
 */
/**
 * Remove the raw CLI `RunAtLoad` manifest and PROVE it is gone.
 *
 * Shared by register and unregister, and sharing it is the point. Ticket 05
 * made the destructive-entry guard permissive about a present legacy manifest
 * - correctly, because a readable manifest is work to do, not a reason to
 * refuse. But that guard is shared, while the retirement step was not: register
 * removed the plist, unregister only booted out the jobs and cleared the
 * SMAppService records. So on a migration machine, deregistering reported
 * success with `~/Library/LaunchAgents/<cli-label>.plist` still on disk, and
 * `RunAtLoad` started the host again at next login - silently undoing the
 * user's explicit deregistration.
 *
 * Admission and retirement have to travel together. One helper, two callers.
 */
async function removeCliLabelManifestProvably(
  revalidateBeforeMutation: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  const removed = await removeCliLabelManifest(revalidateBeforeMutation);
  // `failed` parks exactly as `deferred` does. Letting it fall through was the
  // second half of the same defect: the cycle would go on while a legacy
  // manifest it could not remove was still on disk, which is the
  // competing-`RunAtLoad`-host state this retirement exists to prevent.
  // (`removeCliLabelManifest` already maps an unreadable probe to `failed`.)
  if (removed === "deferred" || removed === "failed") return false;
  if (removed === "removed") {
    // Positively re-probe absence before anything downstream. `rm(force)`
    // cannot distinguish "removed it" from "there was nothing there", and a
    // manifest that reappears - a concurrent CLI install, a race with the
    // launch repair - must not be discovered only after the caller has
    // committed. Absence is proven here or the cycle parks.
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
    // "bootout-failed" proceeds: retirement's durable state is the manifest
    // (removed provably above) and the SMAppService record (cleared below).
    // A bootout failure leaves only the RUNNING legacy instance, which
    // cannot return once both durable anchors are gone.
  }
  const unregistered = await setLoginItemSettingsWithGuard(
    false,
    LEGACY_HOST_SERVICE_NAME,
    revalidateBeforeMutation,
  );
  if (unregistered === null) return false;
  // `false` is a clear that THREW, not a clear that found nothing — the
  // legacy record can still be registered and start the host under the old
  // label, which is the competing-registration state this retirement exists
  // to prevent. Claiming "retired" over it was the same lie the manifest
  // comment below the uninstall path calls out.
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

// Whether the competing CLI manifest is there. Mirrors `ManifestProbe` in the
// CLI's `service/platforms/macos.ts`, and for the same reason: "we could not
// read the directory" has to stay distinct from "there is no manifest".
//
// Deliberately local rather than folded into `fileExists` - that helper's
// other callers WANT the swallow. `hasPendingLoginItemRevision` documents a
// read error as "no pending revision" so an FS hiccup never blocks the ensure
// fast path, and `hostManagesHostLoginItem` fails safe to "not a host-managed
// build". Only the retire path treats absent as proof of a clean machine.
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

/**
 * Delete `~/Library/LaunchAgents/<cli-label>.plist` - the manifest that would
 * `RunAtLoad` a second host beside the agent-label one.
 *
 * Single implementation shared by the register cycle's step 1 and the
 * launch-time repair, so the two can never drift on what "retired" means.
 * The register cycle pairs it with a bootout of the same label; the launch
 * repair deliberately does not (see
 * `retireCompetingCliRegistrationAtLaunch`).
 */
async function removeCliLabelManifest(
  revalidateBeforeRemoval: (() => Promise<boolean>) | null | undefined,
): Promise<"removed" | "absent" | "failed" | "deferred"> {
  const manifest = userLaunchAgentPlistPath(CLI_HOST_LABEL);
  const probe = await probeCliLabelManifest(manifest);
  if (probe.kind === "absent") return "absent";
  if (probe.kind === "unreadable") {
    // NOT `absent`: that is the value the launch repair turns into
    // `nothing-to-retire` ("this machine is already clean"), and an
    // unreadable `~/Library/LaunchAgents` proves no such thing. No `rm`
    // attempt either - `rm(force)` cannot tell "removed" from "was never
    // there", so on a path we could not even read it would report a removal
    // that may not have happened. Hedged wording for the same reason: we
    // cannot see whether a manifest is there at all.
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
 * What `retireCompetingCliRegistrationAtLaunch` did this launch. Returned
 * (rather than logged and swallowed) so the startup caller can log one line
 * and tests can assert the gates without reading the logger.
 *
 *   - `not-applicable` - not a build/platform where Desktop owns
 *     registration, or the user removed the host on this device.
 *   - `agent-not-enabled` - SMAppService is not reporting `enabled`, so we
 *     have no proof a host would still start at login without the CLI
 *     registration. Deliberately does nothing (see the doc below).
 *   - `nothing-to-retire` - positively no competing manifest on disk. Steady
 *     state, and never inferred from a directory we could not read.
 *   - `retired` - a competing manifest was found and removed.
 *   - `retire-failed` - the manifest was not removed: either the removal
 *     itself failed, or `~/Library/LaunchAgents` was unreadable so we could
 *     not tell whether one is there. Both leave the relapse possible, which
 *     is what this value means.
 */
export type LaunchCompetingRegistrationRepair =
  | "not-applicable"
  | "agent-not-enabled"
  // The agent reads `enabled` but its `launchctl print` carries positive
  // wedge markers (spawn failed / EX_CONFIG / LWCR mismatch) - or the
  // probe could not answer. The CLI registration below may be the only
  // host that works on this machine (including one installed via
  // `service install --takeover`), so the retirement is skipped.
  | "agent-possibly-wedged"
  | "nothing-to-retire"
  | "retired"
  | "retire-failed";

// Real spawn observation for the retirement gate: classify the agent's own
// `launchctl print` through the shared wedge predicate. Only POSITIVE
// markers report `wedged` - at launch the agent may legitimately not have
// spawned yet, so the loaded-but-no-pid heuristic stays disarmed
// (`loginItemEnabled: null`).
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
 * Remove a `~/Library/LaunchAgents/<cli-label>.plist` that would start a
 * SECOND host beside this app's SMAppService agent at the next login.
 *
 * Why this exists separately from `retireLegacyLabelRegistrations`, which
 * does strictly more: that runs ONLY inside a committed register cycle, and
 * the routine "open the app, host is already healthy" path never runs one.
 * A machine that acquired a dual registration during the v1.1.7 window
 * therefore keeps it indefinitely - updating to v1.1.8 does not clear it,
 * because a desktop auto-update swaps bytes without a register cycle and
 * the CLI now refuses to touch the plist rather than removing it. Both jobs
 * are `RunAtLoad`, so every login starts two hosts against one data dir;
 * they start simultaneously, which is precisely the case the CLI
 * supervisor's incumbent probe cannot see (no `pid.json` exists yet).
 *
 * Two deliberate narrowings versus the register cycle:
 *
 *   1. Gated on SMAppService reporting `enabled`. Under `requires-approval`
 *      the user has disabled the login item and launchd will not spawn the
 *      agent; removing the CLI plist there would take away the machine's
 *      only auto-starting host. `not-registered` / `not-found` /
 *      `not-supported` fail into the same no-op. Same availability bias as
 *      `findLiveIncumbentHost` in the CLI: never leave a machine with no
 *      host to prevent a duplicate.
 *
 *      GAP CLOSED (formerly accepted): `enabled` proves the agent is
 *      REGISTERED and enabled, not that launchd can actually spawn it. An
 *      agent wedged by a stale BTM Lightweight Code Requirement (the LWCR
 *      / `EX_CONFIG` failure documented on `registerHostLoginItem` above)
 *      also reads `enabled` while every spawn is SIGKILLed inside dyld
 *      init - and on such a machine the CLI registration may be the only
 *      one that works (including one the user just installed with
 *      `service install --takeover`). The "real spawn observation this
 *      code has no access to" now exists: the agent's own `launchctl
 *      print` classified through the shared wedge predicate
 *      (`probeAgentWedgeForRetirement`). Positive wedge markers - or an
 *      unanswerable probe - skip the retirement: wrongly keeping a
 *      duplicate costs one more login of dual-host (which Layer 0 makes
 *      data-safe), wrongly deleting costs the machine its only working
 *      host.
 *   2. Removes the manifest but does NOT bootout the running job. Boot-out
 *      would kill a host that may be serving this session's tabs right now
 *      - and at launch we have no idea whether the competing host or the
 *      agent is the one `pid.json` currently names. Deleting the manifest
 *      is the durable half: the duplicate cannot return at the next login,
 *      and the machine converges to one host without anything being ripped
 *      away mid-session. The residual is that a machine already running two
 *      hosts keeps running two until the next login. The CLI's
 *      `retireCompetingRegistration` DOES bootout, because it only runs
 *      inside an explicit `host install` the user asked for.
 *
 * Best-effort and idempotent; safe to call on every launch. Serialized
 * through the same registration lock as the register cycle so the two can
 * never interleave on the CLI label.
 */
export function retireCompetingCliRegistrationAtLaunch(): Promise<LaunchCompetingRegistrationRepair> {
  return withHostLoginItemRegistrationLock(async () => {
    const outcome = await retireCompetingCliRegistrationUnserialized(null);
    // The null arm is reachable only when a contender guard was supplied.
    // Keep this legacy no-guard API total without fabricating a retirement.
    return outcome ?? "not-applicable";
  });
}

/**
 * Contender-only variant. `null` means the capability disappeared while the
 * registration lock was queued; no manifest operation was performed.
 */
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
  // The same proof the register and uninstall paths demand: `rm(force)`
  // cannot tell "removed it" from "there was nothing there", and a manifest
  // recreated underneath us (a concurrent CLI install) must not be reported
  // `retired` — relapse-possible is exactly what `retire-failed` means.
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

/**
 * Whether `scripts/desktop-install-cloud.js` (internal repo) left a pending
 * LaunchAgent revision marker for `environment` - see `getHostFsLayout`'s
 * doc comment for the full cross-repo contract. Best-effort: a read error
 * (permissions, race) is treated as "no pending revision" so a transient FS
 * hiccup never blocks the ensure fast path.
 */
export async function hasPendingLoginItemRevision(
  environment: Environment,
): Promise<boolean> {
  return fileExists(getHostFsLayout(environment).pendingLoginItemRevisionFile);
}

// M-B (finding): `clearPendingLoginItemRevision` is best-effort - a failed
// unlink leaves the marker on disk AFTER a successful apply. A plain existence
// check would then re-run the disruptive SMAppService cycle on every monitor
// tick / convergeReady forever. Remember the mtime of a marker whose clear
// failed so a marker that still carries that exact mtime reads as
// already-resolved (suppress the redundant re-cycle), while a genuinely newer
// revision - the installer rewrites the file, bumping its mtime - re-arms and
// applies normally. In-memory only: a process restart re-reads the marker and
// re-applies, which is correct (it is still on disk).
let appliedPendingRevisionMtimeMs: number | null = null;

/**
 * Whether there is a pending LaunchAgent revision this process has NOT already
 * applied. Differs from `hasPendingLoginItemRevision` only when a prior
 * successful apply could not delete its marker (see M-B above): that lingering
 * marker reads as "nothing pending" here, so the controller never churns
 * re-registering an already-active plist.
 */
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

/**
 * Tear down the host's SMAppService login-item registration during an in-app
 * uninstall. The CLI's `host uninstall --all` boots out the launchd plist,
 * but on macOS 26+ the BTM entry the desktop registered via SMAppService
 * persists independently and would respawn the host at the next login. This
 * drops it: `launchctl bootout` flushes the BTM entry (the load-bearing step
 * on 26+) and `setLoginItemSettings({openAtLogin: false})` unregisters the
 * SMAppService record on older macOS. Best-effort and idempotent - a clean
 * machine (nothing registered) is a no-op.
 *
 * Caller must have confirmed `hostManagesHostLoginItem()` first; on every
 * other build there is no SMAppService registration to remove.
 */
export function unregisterHostLoginItem(): Promise<void> {
  return withHostLoginItemRegistrationLock(async () => {
    await unregisterHostLoginItemUnserialized(undefined);
  });
}

/**
 * Contender-aware variant used by the host update mutation facade. The guard
 * is evaluated while the registration serialization lock is held and just
 * before either bootout, so a capability that was released while queued
 * cannot remove a live registration.
 */
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
  // Both labels: the agent label is the live registration on post-split
  // builds; the CLI label covers machines mid-transition (a legacy/CLI job
  // still loaded, or an old-label SMAppService record not yet retired by a
  // register cycle).
  const primaryBootout = await bootoutStaleAgent(
    HOST_AGENT_LABEL,
    revalidateBeforeMutation,
  );
  if (primaryBootout === "authority-lost") {
    parkRegistrationAfterAuthorityLoss("primary uninstall bootout");
    return false;
  }
  // A failed bootout on TEARDOWN is a failed teardown, not best-effort: on
  // macOS 26+ bootout is the load-bearing BTM clear, so success here would
  // claim a deregistration the BTM store may still contradict at next login.
  // Not an authority loss — no park; the caller may retry.
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
  // A `not-found`/`not-supported` label has no SMAppService record to clear
  // (or no API to clear it with) — that leg's work is already done. The
  // bootouts above and the manifest retirement below still run for it; the
  // clear is the ONLY step those statuses make meaningless.
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
    // `false` means `setLoginItemSettings` THREW: the SMAppService/BTM
    // registration can still be present, and it is the PRIMARY one — the
    // exact "host comes back at next login" outcome the manifest comment
    // below calls a lie to report success over. Not an authority loss (no
    // park), but a failed teardown all the same.
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
  // The raw `RunAtLoad` manifest, retired with the same proof register
  // demands. Booting out the jobs and clearing the SMAppService records does
  // NOT remove this file, and while it is on disk launchd starts the host
  // again at next login - so reporting teardown success without it is a lie
  // that undoes the user's explicit deregistration one reboot later.
  //
  // Failure here is emphatically NOT cosmetic: it means the host WILL come
  // back. Returning false parks the teardown rather than claiming a success
  // the disk contradicts.
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

/**
 * Electron exposes no registration transaction/CAS. We therefore reject
 * states whose authoritative status cannot be read before the first
 * destructive edge; once authority is lost later, the caller parks rather
 * than attempting a stale restore against mutable bundle bytes.
 */
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
 * The entry guard for REMOVAL, which is a different question from the one
 * {@link canBeginDestructiveRegistration} answers.
 *
 * Registration is destructive-then-restorative: it boots out and re-registers,
 * so it must refuse any prior state it could not put back. `requires-approval`
 * is disqualifying there for exactly that reason — we have no primitive that
 * recreates a BTM approval state — and that refusal stays untouched.
 *
 * Removal has nothing to restore. `requires-approval` means REGISTERED with the
 * user's toggle off (`pollRegisterStatusUntilSettled` says so in as many
 * words: "both terminal: register succeeded; the only difference is whether the
 * user has the toggle on"). Sharing the registration guard here meant an
 * explicit deregister parked on precisely the state it exists to clear, and a
 * user who had toggled the login item off could never remove it — the
 * registration outlived the uninstall.
 *
 * `not-found` and `not-supported` are removable too, for the same "nothing to
 * restore" reason: both mean the SMAppService leg for that label has nothing
 * to clear — but the raw `RunAtLoad` manifest is a separate artifact that
 * those statuses say nothing about, and refusing here left it on disk to
 * start the host at the next login after an explicit deregistration. The
 * clear legs skip those statuses instead (see the caller); only `null` (a
 * status we could not read) and an `unreadable` legacy manifest still refuse,
 * because we cannot retire what we cannot see.
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

/**
 * Whether the SMAppService CLEAR leg has anything to act on for a label in
 * `status`. `not-found` has no registration to clear and `not-supported` has
 * no API to clear it with — skipping is that leg's success, not a shortcut:
 * the bootouts and the manifest retirement still run for both.
 */
function statusHasClearableRegistration(
  status: HostLoginItemStatus | null,
): boolean {
  // `null` cannot reach the clear legs (the entry guard refuses it); if it
  // ever did, attempting the clear is the conservative answer.
  return status !== "not-found" && status !== "not-supported";
}

function parkRegistrationAfterAuthorityLoss(edge: string): void {
  // Do not call SMAppService after the attempt capability disappears. The
  // registration may now belong to a newer holder and Electron exposes no
  // compare-and-swap/transaction that could restore the prior BTM record
  // without racing it. A later, freshly admitted repair reconstructs intent
  // from current authoritative status instead.
  log.warn("[host-login-item] registration parked after authority loss", {
    edge,
  });
}

async function pollRegisterStatusUntilSettled(): Promise<HostLoginItemStatus> {
  const deadline = Date.now() + REGISTER_STATUS_POLL_DEADLINE_MS;
  let last: HostLoginItemStatus = readHostLoginItemStatus();
  // `enabled` and `requires-approval` are both terminal: register succeeded;
  // the only difference is whether the user has the toggle on. `not-found`
  // and `not-supported` are also terminal failures - no amount of polling
  // changes those. Only `not-registered` is potentially transient (cold-BTM
  // commit lag), so that's the one we retry.
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
  // Electron exposes the SMAppService statuses by these exact strings on
  // macOS 13+. Anything else (older OS, `status` omitted on a non-agent
  // settings shape) falls through to `not-registered` so callers fail
  // closed and rerun the cycle.
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

/**
 * Time we let `launchctl bootout` run before killing it. Bootout is a
 * fast launchd RPC; observed wall-clock is <50ms on a healthy system.
 * The 5s ceiling exists to bound a launchd hang (rare, but seen during
 * launchd recovery after a wake-from-sleep) so the register cycle
 * isn't held hostage by a wedged subprocess.
 */
const BOOTOUT_TIMEOUT_MS = 5_000;

/**
 * Forcibly drop the job under `labelId` from launchd's GUI domain so BTM
 * releases its cached LWCR. On macOS 26+ this is the only path that
 * actually flushes BTM — see `registerHostLoginItem`'s docstring for
 * the mechanism. Safe to call on a clean machine: launchctl exits
 * non-zero with "not loaded" semantics (codes 3 / 5 / 113), which we
 * treat as success.
 *
 * The outcome distinguishes WHY nothing was (or may not have been)
 * cleared, because different callers owe different honesty:
 *   - "authority-lost" — the revalidation refused; the caller must park.
 *   - "bootout-failed" — launchctl errored, timed out, or exited with an
 *     unexpected code, so the BTM entry may still be present. A register
 *     cycle treats this as best-effort and proceeds (worst case is the
 *     pre-fix behavior for one call); a TEARDOWN must not report success
 *     over it — on macOS 26+ bootout is the load-bearing BTM clear, so a
 *     swallowed failure here is exactly "the host returns at next login".
 *   - "ok" — cleared, not loaded, or nothing to do on this platform.
 */
type BootoutOutcome = "ok" | "authority-lost" | "bootout-failed";

/**
 * The spawn implementation `bootoutStaleAgent` hands to
 * `runLaunchctlBootout`. Module state with a test-only setter rather
 * than a parameter, because `bootoutStaleAgent` is reached only through
 * the exported register/unregister flows and threading a spawn argument
 * through every public signature would put a test-only concern on the
 * production API. The seam exists for the same reason
 * `runLaunchctlBootout` takes `spawnFn` (see `BootoutChildProcess`):
 * vitest cannot reliably intercept `node:child_process` here, and a
 * mock that silently fails to intercept does not fail a test — it runs
 * a REAL `launchctl bootout` against the developer's live host agent.
 */
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
  // Wrap `spawn` so TypeScript resolves the (command, args, options)
  // overload here rather than against the `BootoutSpawnFn` alias.
  //
  // `runLaunchctlBootout` classifies async failures (error event, non-
  // zero exit, timeout); the try/catch here covers the synchronous
  // throw path from `spawn` itself (invalid arguments, no /bin/launchctl
  // at all) — the same "may still be registered" verdict.
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

/**
 * The minimal `child_process.spawn` surface `runLaunchctlBootout`
 * depends on. Pulled out so unit tests can pass a stub without mocking
 * `node:child_process` itself — vitest's jsdom environment doesn't
 * intercept `import { spawn } from "node:child_process"` reliably, and
 * passing the dependency explicitly is the cleanest way to keep the
 * spawn-side behavior (timeout, kill, exit-code classification)
 * testable in isolation.
 */
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

/**
 * Spawn `launchctl bootout <target>` and wait for it to exit, or kill
 * it once `BOOTOUT_TIMEOUT_MS` has elapsed. Resolves either way — the
 * BTM-clearing side effect is durable: a process that hangs after
 * issuing the bootout RPC still leaves BTM cleared.
 *
 * Exit-code classification:
 *   - 0 — bootout succeeded, agent was loaded and is now gone
 *   - 3 / 5 / 113 — agent was not loaded; nothing to clear (no-op
 *     success on a clean machine). Codes are macOS-version-dependent:
 *     observed 3 (ENOSRCH) on 14+, 5 ("Could not find service"), and
 *     113 ("Service is not loaded") historically.
 *   - anything else — a real launchctl failure (permission denied,
 *     corrupted launchd state). Logged at warn so a wedged BTM isn't
 *     silently swallowed and rediscovered as a downstream SIGKILL.
 *
 * `spawnFn` is injected so this function is testable in isolation;
 * the production call site passes the real `node:child_process.spawn`.
 * Exported for unit tests; never call this from new production code —
 * use `bootoutStaleAgent` instead.
 */
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
        // "Not loaded" — nothing to clear. Common on first install.
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
