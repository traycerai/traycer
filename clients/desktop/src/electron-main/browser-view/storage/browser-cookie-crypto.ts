import { safeStorage } from "electron";
import type {
  BrowserCookieCryptoReason,
  BrowserCookieCryptoState,
  BrowserCookieStorageBackend,
  BrowserPersistenceDecision,
  BrowserPersistencePlatform,
  BrowserPersistenceState,
} from "@traycer-clients/shared/platform/browser-view";
import { log } from "../../app/logger";
import {
  createBrowserPersistenceDecisionStore,
  UNDECIDED_BROWSER_PERSISTENCE_RECORD,
  type BrowserPersistenceDecisionStore,
  type BrowserPersistenceRecord,
} from "./browser-persistence-decision";

/**
 * Lazy persistence state machine (spec §6.1, ticket 01).
 *
 * The invariant this module exists to hold: **nothing here calls `safeStorage`
 * until the user has consented on this machine**, because on macOS
 * `isEncryptionAvailable()` is not a flag - it resolves the keychain item and
 * raises the OS ACL dialog. Boot reads the decision file and stops. The probe
 * runs only from `enableBrowserPersistence()` (an explicit user action), from
 * `initBrowserPersistence` when the file already says the user consented, or
 * on a platform where the probe is provably silent.
 */

/** One `safeStorage` interrogation. Never taken speculatively. */
export interface BrowserPersistenceProbe {
  readonly encryptionAvailable: boolean;
  readonly storageBackend: BrowserCookieStorageBackend;
}

export interface BrowserCookieCryptoDetectionInput {
  readonly platform: NodeJS.Platform | string;
  readonly decision: BrowserPersistenceDecision;
  /** `null` when the keystore has not been probed in this process. */
  readonly probe: BrowserPersistenceProbe | null;
  /** Backend recorded by a previous run's successful probe. */
  readonly recordedStorageBackend: BrowserCookieStorageBackend;
}

export interface BrowserPersistenceInit {
  readonly decisionFilePath: string;
  readonly platform: NodeJS.Platform | string;
  /** Product name the OS keychain dialog quotes; see `BrowserPersistenceState`. */
  readonly appName: string;
}

let platform: NodeJS.Platform | string = process.platform;
let appName = "Traycer";
let store: BrowserPersistenceDecisionStore | null = null;
let record: BrowserPersistenceRecord = UNDECIDED_BROWSER_PERSISTENCE_RECORD;
let probe: BrowserPersistenceProbe | null = null;
/** Denials seen in *this* process; the second one earns a relaunch. */
let denialCount = 0;

/**
 * Every state transition this module can make (spec decision #20, ticket 11).
 * The GUI reports the same funnel to PostHog; this is the local channel, so a
 * machine's own logs tell the whole story - card to keystore - with no
 * analytics and no network.
 */
type BrowserPersistenceTransition =
  /** `on-ready` settled: what the decision file said, and what it cost. */
  | "init"
  /** A user gesture is about to interrogate the keystore. */
  | "enable-attempt"
  | "enable-result"
  | "decline"
  /** A second denial in one process; the next launch re-probes. */
  | "relaunch-pending"
  /** A provably silent platform enabled itself at tile-open time. */
  | "auto-enable";

/**
 * One structured line per transition, in the SAME vocabulary the state itself
 * uses (decision kinds, crypto reasons, storage backends) so a log and a
 * PostHog breakdown read alike. Deliberately carries no cookie, domain, URL or
 * site count - a persistence log is about the machine, never about browsing.
 */
function logBrowserPersistenceTransition(
  transition: BrowserPersistenceTransition,
): void {
  const state = getBrowserCookieCryptoState();
  log.info("[browser-view] cookie crypto mode resolved", {
    transition,
    platform: persistencePlatform(),
    decision: record.decision.kind,
    mode: state.mode,
    persistence: state.persistence,
    reason: state.reason,
    storageBackend: state.storageBackend,
    encryptionAvailable: state.encryptionAvailable,
    probed: probe !== null,
    denialCount,
  });
}

/**
 * `on-ready`. Reads the decision file only. Probes exactly when the file says
 * the user already consented (`enabled`) or asked us to retry after a restart
 * (`relaunch-pending`) - in both cases the prompt, if any, is expected.
 */
export async function initBrowserPersistence(
  input: BrowserPersistenceInit,
): Promise<BrowserCookieCryptoState> {
  platform = input.platform;
  appName = input.appName;
  store = createBrowserPersistenceDecisionStore(input.decisionFilePath);
  probe = null;
  denialCount = 0;
  record = await store.read();

  const kind = record.decision.kind;
  if (kind === "enabled" || kind === "relaunch-pending") {
    const result = runProbe();
    if (isProbePersistent(result)) {
      record = {
        decision:
          kind === "enabled"
            ? record.decision
            : { kind: "enabled", decidedAt: Date.now() },
        storageBackend: result.storageBackend,
      };
      if (kind === "relaunch-pending") await persistRecord(record);
    } else {
      denialCount = result.encryptionAvailable ? 0 : 1;
    }
  }

  logBrowserPersistenceTransition("init");
  return getBrowserCookieCryptoState();
}

/**
 * The one path that may raise an OS prompt on macOS. On success the decision
 * is durable, so the next launch probes eagerly instead of asking again.
 */
export async function enableBrowserPersistence(): Promise<BrowserCookieCryptoState> {
  logBrowserPersistenceTransition("enable-attempt");
  const result = runProbe();
  if (isProbePersistent(result)) {
    denialCount = 0;
    record = {
      decision: { kind: "enabled", decidedAt: Date.now() },
      storageBackend: result.storageBackend,
    };
    await persistRecord(record);
    logBrowserPersistenceTransition("enable-result");
    return getBrowserCookieCryptoState();
  }

  // A `basic_text` Linux backend is a permanent verdict, not a cached denial:
  // relaunching changes nothing, so it never escalates to relaunch-pending.
  if (result.encryptionAvailable) {
    logBrowserPersistenceTransition("enable-result");
    return getBrowserCookieCryptoState();
  }

  denialCount += 1;
  if (denialCount >= 2 && record.decision.kind !== "relaunch-pending") {
    record = {
      decision: { kind: "relaunch-pending", decidedAt: Date.now() },
      storageBackend: record.storageBackend,
    };
    await persistRecord(record);
    logBrowserPersistenceTransition("relaunch-pending");
    return getBrowserCookieCryptoState();
  }
  logBrowserPersistenceTransition("enable-result");
  return getBrowserCookieCryptoState();
}

export async function declineBrowserPersistence(): Promise<BrowserCookieCryptoState> {
  record = {
    decision: { kind: "declined", decidedAt: Date.now() },
    storageBackend: record.storageBackend,
  };
  await persistRecord(record);
  logBrowserPersistenceTransition("decline");
  return getBrowserCookieCryptoState();
}

export function getBrowserPersistenceDecision(): BrowserPersistenceDecision {
  return record.decision;
}

export function getBrowserPersistenceState(): BrowserPersistenceState {
  return {
    decision: record.decision,
    cryptoState: getBrowserCookieCryptoState(),
    // "Would the OS ask?" is exactly the inverse of "may we probe unasked",
    // so the card and the silent auto-enable can never disagree.
    promptsOnEnable: !canAutoEnableSilently(),
    appName,
    platform: persistencePlatform(),
  };
}

function persistencePlatform(): BrowserPersistencePlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return platform;
  }
  return "other";
}

export function getBrowserCookieCryptoState(): BrowserCookieCryptoState {
  return resolveBrowserCookieCryptoStateFromInputs({
    platform,
    decision: record.decision,
    probe,
    recordedStorageBackend: record.storageBackend,
  });
}

/**
 * Called when a tile is about to pick its partition. On platforms where the
 * probe is provably silent (Windows DPAPI, and Linux once a real keyring
 * backend was recorded) an `undecided` machine auto-enables here, so those
 * users get Chrome parity with no card (spec #21).
 */
export function ensureBrowserPersistenceForTileOpen(): BrowserCookieCryptoState {
  if (probe !== null || record.decision.kind !== "undecided") {
    return getBrowserCookieCryptoState();
  }
  if (!canAutoEnableSilently()) return getBrowserCookieCryptoState();

  const result = runProbe();
  if (isProbePersistent(result)) {
    record = {
      decision: { kind: "enabled", decidedAt: Date.now() },
      storageBackend: result.storageBackend,
    };
    void persistRecord(record);
  }
  logBrowserPersistenceTransition("auto-enable");
  return getBrowserCookieCryptoState();
}

export function resolveBrowserCookieCryptoStateFromInputs(
  input: BrowserCookieCryptoDetectionInput,
): BrowserCookieCryptoState {
  const probeResult = input.probe;
  if (probeResult === null) {
    // Nothing was asked of the OS, so nothing is known about it. The only
    // honest reasons are "we never enabled this" and, before init, "unknown".
    return {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "not-enabled",
      storageBackend: input.recordedStorageBackend,
      encryptionAvailable: false,
    };
  }
  const persistent =
    input.decision.kind === "enabled" &&
    isPersistentProbe(input.platform, probeResult);
  return {
    mode: persistent ? "real" : "degraded",
    persistence: persistent ? "persistent" : "ephemeral",
    reason: probeReason(input, probeResult),
    storageBackend: probeResult.storageBackend,
    encryptionAvailable: probeResult.encryptionAvailable,
  };
}

function probeReason(
  input: BrowserCookieCryptoDetectionInput,
  probeResult: BrowserPersistenceProbe,
): BrowserCookieCryptoReason {
  if (!probeResult.encryptionAvailable) {
    return input.platform === "darwin"
      ? "keychain-denied"
      : "encryption-unavailable";
  }
  if (isLinuxBasicText(input.platform, probeResult)) return "linux-basic-text";
  return input.decision.kind === "enabled" ? "os-backed" : "not-enabled";
}

function isPersistentProbe(
  probePlatform: NodeJS.Platform | string,
  probeResult: BrowserPersistenceProbe,
): boolean {
  return (
    probeResult.encryptionAvailable &&
    !isLinuxBasicText(probePlatform, probeResult)
  );
}

function isLinuxBasicText(
  probePlatform: NodeJS.Platform | string,
  probeResult: BrowserPersistenceProbe,
): boolean {
  return (
    probePlatform === "linux" && probeResult.storageBackend === "basic_text"
  );
}

function isProbePersistent(probeResult: BrowserPersistenceProbe): boolean {
  return isPersistentProbe(platform, probeResult);
}

function canAutoEnableSilently(): boolean {
  if (platform === "win32") return true;
  if (platform !== "linux") return false;
  const recorded = record.storageBackend;
  return recorded !== null && recorded !== "basic_text";
}

function runProbe(): BrowserPersistenceProbe {
  const result: BrowserPersistenceProbe = {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    storageBackend: readSelectedStorageBackend(),
  };
  probe = result;
  if (!isProbePersistent(result)) {
    log.warn("[browser-view] cookie persistence probe failed", {
      platform,
      encryptionAvailable: result.encryptionAvailable,
      storageBackend: result.storageBackend,
    });
  }
  return result;
}

async function persistRecord(next: BrowserPersistenceRecord): Promise<void> {
  const target = store;
  if (target === null) return;
  try {
    await target.write(next);
  } catch (err) {
    log.warn("[browser-view] persistence decision write failed", {
      decision: next.decision.kind,
      err,
    });
  }
}

function readSelectedStorageBackend(): BrowserCookieStorageBackend {
  if (platform !== "linux") return null;
  return safeStorage.getSelectedStorageBackend();
}
