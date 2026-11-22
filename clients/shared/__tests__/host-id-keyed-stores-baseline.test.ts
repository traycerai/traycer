import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  findHostIdKeyedStores,
  scanHostIdKeyedStores,
  scannedSources,
} from "./host-id-keyed-store-scan";

// A process-memory store keyed by a host id as a plain string keeps a host's
// or a mint's answer past the host process that gave it: a restarted host
// would inherit the answer of the one before it. Every such store in the
// sources a host or mint answer reaches is either keyed by the process
// instance (an owner key, or a WeakMap on the instance, which this scan does
// not match) or listed below with the reason that its life may be the host id.
//
// The scan is the AST rule of the round V inventory (section 6): a `new Map`,
// `Set`, `WeakMap` or `WeakSet` declared as a variable or a class property,
// set on a class in a constructor, or held in an object literal, whose key is
// a string (or not named) and whose name, value type or written keys mark it
// as an answer. The baseline is keyed by `path::identifier`, never a line.
// An answer store that is owner-keyed is not listed: it passes by its key, and
// listing it here would hide a regression to a string key.

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENTS_ROOT = join(THIS_DIR, "..", "..");

type BaselineEntry =
  | {
      readonly class: "HOST-ID-LIFETIME";
      readonly reason: string;
      /** The 1.5.4 line that kept the same store per host id. */
      readonly ref: string;
    }
  | { readonly class: "NOT-AN-ANSWER"; readonly reason: string }
  | {
      /** The mints of asks that name no observed process; an owned ask joins one (hold-fixed). */
      readonly class: "NULL-OWNER-FLIGHT";
      readonly reason: string;
    }
  | { readonly class: "RULING"; readonly ruling: "G1" | "G3" | "G4" }
  | {
      /** No production caller of `constructor` exists; one that appears must key by owner first. */
      readonly class: "DORMANT";
      readonly constructor: string;
    };

const RULING_TEXT: Readonly<Record<"G1" | "G3" | "G4", string>> = {
  G1: "one cover per host, fed only fenced current-owner reports; cleared by any admission",
  G3: "authn's answer for the person and the host id, not a host process's",
  G4: "authn's answer for the person and the host id, not a host process's",
};

const HOST_ID_LIFETIME_REF = /^(?:desktop|cli)-v1\.5\.4:[^:]+:\d+(?:-\d+)?$/;

/** The stores round V keys by owner: none may be listed, or a string key would pass. */
const OWNER_KEYED: readonly string[] = [
  "shared/auth/host-token-lease.ts::byHost",
  "shared/auth/host-token-source.ts::observedFlights",
  "desktop/src/renderer-shell/desktop-host-tokens.ts::asking",
  "desktop/src/renderer-shell/desktop-host-tokens.ts::untilOwnTurn",
];

const BASELINE: Readonly<Record<string, BaselineEntry>> = {
  "desktop/src/electron-main/app/support.ts::frozenEvidenceByKey": {
    class: "NOT-AN-ANSWER",
    reason:
      "Support-bundle evidence snapshot keyed by a local file key, not a host answer",
  },
  "desktop/src/electron-main/browser-sessions/browser-sessions-owner.ts::streamsByHost":
    {
      class: "NOT-AN-ANSWER",
      reason: "The desktop's own browser-session stream bookkeeping",
    },
  "desktop/src/electron-main/browser-sessions/browser-sessions-owner.ts::carriers":
    {
      class: "NOT-AN-ANSWER",
      reason: "The desktop's own browser-session stream bookkeeping",
    },
  "desktop/src/electron-main/browser-sessions/browser-sessions-owner.ts::addressed":
    {
      class: "NOT-AN-ANSWER",
      reason: "The desktop's own browser-session stream bookkeeping",
    },
  "desktop/src/electron-main/browser-sessions/browser-sessions-transport.ts::next":
    {
      class: "NOT-AN-ANSWER",
      reason: "Directory rows (registry), not a host answer",
    },
  "desktop/src/electron-main/browser-view/browser-session.ts::sessionsByPartition":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "Electron browser-view bookkeeping (partitions, windows, requests), not a host or mint answer",
    },
  "desktop/src/electron-main/browser-view/browser-view-manager.ts::releasedIsolatedSessionKeys":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "Electron browser-view bookkeeping (partitions, windows, requests), not a host or mint answer",
    },
  "desktop/src/electron-main/browser-view/debug/browser-frame-routes.ts::childSessionByTargetId":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "Electron browser-view bookkeeping (partitions, windows, requests), not a host or mint answer",
    },
  "desktop/src/electron-main/browser-view/debug/browser-frame-routes.ts::detachedChildSessionIds":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "Electron browser-view bookkeeping (partitions, windows, requests), not a host or mint answer",
    },
  "desktop/src/electron-main/browser-view/manager/browser-view-entry-factory.ts::sessionsByElectronRequestId":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "Electron browser-view bookkeeping (partitions, windows, requests), not a host or mint answer",
    },
  "desktop/src/electron-main/browser-view/manager/browser-view-find.ts::sessionsByElectronRequestId":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "Electron browser-view bookkeeping (partitions, windows, requests), not a host or mint answer",
    },
  "desktop/src/electron-main/browser-view/manager/browser-view-provisioning.ts::inFlightEnsures":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "Electron browser-view bookkeeping (partitions, windows, requests), not a host or mint answer",
    },
  "desktop/src/electron-main/browser-view/manager/browser-view-window-attachment.ts::hostWindowResetListenersByWindowId":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "Electron browser-view bookkeeping (partitions, windows, requests), not a host or mint answer",
    },
  "desktop/src/electron-main/host/host-controller.ts::inFlightMutations": {
    class: "NOT-AN-ANSWER",
    reason:
      "A desktop host-controller operation in flight, local to this process",
  },
  "desktop/src/electron-main/host/host-controller.ts::inFlightIntentPreflights":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "A desktop host-controller operation in flight, local to this process",
    },
  "desktop/src/electron-main/ipc/runner-ipc-bridge.ts::hostQuitListeningWindowIds":
    {
      class: "NOT-AN-ANSWER",
      reason: "Window ids of this app, not a host answer",
    },
  "desktop/src/electron-main/soundtrack/session-recordings.ts::recordings": {
    class: "NOT-AN-ANSWER",
    reason: "The app's own session recordings, local files",
  },
  "desktop/src/electron-main/windows/window-registry.ts::recordsByWindowId": {
    class: "NOT-AN-ANSWER",
    reason: "Window ids of this app, not a host answer",
  },
  "desktop/src/renderer-shell/desktop-host-tokens.ts::copy": {
    class: "RULING",
    ruling: "G3",
  },
  "desktop/src/renderer-shell/desktop-host-tokens.ts::delivered": {
    class: "RULING",
    ruling: "G3",
  },
  "desktop/src/renderer-shell/desktop-host-tokens.ts::held": {
    class: "RULING",
    ruling: "G3",
  },
  "gui-app/src/lib/host/compatibility-state.ts::compatAnchorAtFailure": {
    class: "HOST-ID-LIFETIME",
    reason: "The compatibility probe's anchor per host",
    ref: "desktop-v1.5.4:clients/gui-app/src/lib/host/compatibility-state.ts:67",
  },
  "gui-app/src/lib/host/host-directory-service.ts::seenHostIds": {
    class: "NOT-AN-ANSWER",
    reason: "Directory rows (registry), not a host answer",
  },
  "gui-app/src/lib/host/host-door-retry.ts::rebuildOwners": {
    class: "NOT-AN-ANSWER",
    reason: "Retry listeners; holds no answer",
  },
  "gui-app/src/lib/host/host-key-rotation-sweep.ts::lastKeyByHost": {
    class: "NOT-AN-ANSWER",
    reason: "Directory rows (registry), not a host answer",
  },
  "gui-app/src/lib/host/host-messenger.ts::belowMinimumHostIds": {
    class: "NOT-AN-ANSWER",
    reason: "Directory rows (registry), not a host answer",
  },
  "gui-app/src/lib/host/host-messenger.ts::remoteBindings": {
    class: "NOT-AN-ANSWER",
    reason: "Local binding bookkeeping of this viewer",
  },
  "gui-app/src/lib/host/host-messenger.ts::owedOrphanDetachByHost": {
    class: "NOT-AN-ANSWER",
    reason: "Local binding bookkeeping of this viewer",
  },
  "gui-app/src/lib/host/host-messenger.ts::terminalVerdictByHost": {
    class: "HOST-ID-LIFETIME",
    reason:
      "authn's grant verdict for the host id, with an expiry: the cloud's answer, not a process's",
    ref: "desktop-v1.5.4:clients/gui-app/src/lib/host/host-messenger.ts:389",
  },
  "gui-app/src/lib/host/host-stream-client-cache.ts::ready": {
    class: "NOT-AN-ANSWER",
    reason:
      "The ids of the viewer's already-connected streams, rebuilt from the stream cache on each read",
  },
  "gui-app/src/stores/host/host-door-state-store.ts::byHost": {
    class: "RULING",
    ruling: "G1",
  },
  "shared/auth/host-token-source.ts::mintedWith": {
    class: "RULING",
    ruling: "G4",
  },
  "shared/auth/host-token-source.ts::latestFlight": {
    class: "NULL-OWNER-FLIGHT",
    reason:
      "The latest mint per person, host, refresh and era, which an ask naming no observed process joins; owned asks start in observedFlights",
  },
  "shared/auth/host-token-source.ts::sharedFlights": {
    class: "NULL-OWNER-FLIGHT",
    reason:
      "The latest mint an ask naming no observed process started, which any ask joins",
  },
  "shared/auth/host-token-source.ts::storedIn": {
    class: "RULING",
    ruling: "G3",
  },
  "shared/auth/host-token-source.ts::tokens": { class: "RULING", ruling: "G3" },
  "shared/auth/host-token-store.ts::table": { class: "RULING", ruling: "G3" },
  "shared/auth/host-token-store.ts::forUser": { class: "RULING", ruling: "G3" },
  "shared/host-client/host-binding-authority-registry.ts::bindings": {
    class: "NOT-AN-ANSWER",
    reason: "Directory rows (registry), not a host answer",
  },
  "shared/host-client/host-client.ts::hostAvailabilitySweepGates": {
    class: "NOT-AN-ANSWER",
    reason: "Local sweep gating of this client",
  },
  "shared/host-client/host-client.ts::pendingHostScopeSweeps": {
    class: "NOT-AN-ANSWER",
    reason: "Local sweep gating of this client",
  },
  "shared/host-client/host-connection-registry.ts::records": {
    class: "HOST-ID-LIFETIME",
    reason: "One connection record and reconnect engine per host id",
    ref: "desktop-v1.5.4:clients/shared/host-client/host-connection-registry.ts:127",
  },
  "shared/host-selection/selection-authority-engine.ts::evidence": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:762",
  },
  "shared/host-selection/selection-authority-engine.ts::dialStalls": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:778",
  },
  "shared/host-selection/selection-authority-engine.ts::seenTombstoneIds": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:792",
  },
  "shared/host-selection/selection-authority-engine.ts::usableSince": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:802",
  },
  "shared/host-selection/selection-authority-engine.ts::sessions": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:976",
  },
  "shared/host-selection/selection-authority-engine.ts::sessionOrdinals": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:979",
  },
  "shared/host-selection/selection-authority-engine.ts::evictedOrdinalFloor": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:980",
  },
  "shared/host-selection/selection-authority-engine.ts::hostIds": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:1408",
  },
  "shared/host-selection/selection-authority-engine.ts::usable": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-authority-engine.ts:2356",
  },
  "shared/host-selection/selection-evidence-kernel.ts::sessions": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/selection-evidence-kernel.ts:145",
  },
  "shared/host-selection/selection-evidence-kernel.ts::retainedRestartIntents":
    {
      class: "HOST-ID-LIFETIME",
      reason:
        "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
      ref: "desktop-v1.5.4:clients/shared/host-selection/selection-evidence-kernel.ts:157",
    },
  "shared/host-selection/transport-evidence.ts::liveSessions": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/transport-evidence.ts:183",
  },
  "shared/host-selection/transport-evidence.ts::currentSessionIds": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/transport-evidence.ts:212",
  },
  "shared/host-selection/transport-evidence.ts::retainedRestartIntents": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Liveness evidence keyed by session inside the host id; a restart is itself an evidence event, so the per-host lifetime is the design",
    ref: "desktop-v1.5.4:clients/shared/host-selection/transport-evidence.ts:229",
  },
  "shared/host-transport/local-open-auth.ts::revisions": {
    class: "DORMANT",
    constructor: "createLocalOpenAuth",
  },
  "shared/host-transport/local-open-auth.ts::reprobeFatals": {
    class: "DORMANT",
    constructor: "createLocalOpenAuth",
  },
  "shared/host-transport/local-open-auth.ts::activeBarriers": {
    class: "DORMANT",
    constructor: "createLocalOpenAuth",
  },
  "shared/host-transport/local-open-auth.ts::challengedHosts": {
    class: "DORMANT",
    constructor: "createLocalOpenAuth",
  },
  "shared/host-transport/local-unary-session.ts::inFlight": {
    class: "NOT-AN-ANSWER",
    reason: "A call of this process in flight, dropped when it settles",
  },
  "shared/host-transport/negotiated-manifest-registry.ts::methodsByHostId": {
    class: "HOST-ID-LIFETIME",
    reason:
      "The negotiated manifest per host id, written only by a current-owner open ack",
    ref: "desktop-v1.5.4:clients/shared/host-transport/negotiated-manifest-registry.ts:55",
  },
  "shared/host-transport/negotiated-manifest-registry.ts::versionsByHostId": {
    class: "HOST-ID-LIFETIME",
    reason:
      "The negotiated manifest versions per host id, written only by a current-owner open ack",
    ref: "desktop-v1.5.4:clients/shared/host-transport/negotiated-manifest-registry.ts:56",
  },
  "shared/host-transport/negotiated-stream-version-registry.ts::versionsByHostId":
    {
      class: "HOST-ID-LIFETIME",
      reason:
        "The negotiated stream versions per host id, written only by a current-owner open ack",
      ref: "desktop-v1.5.4:clients/shared/host-transport/negotiated-stream-version-registry.ts:64",
    },
  "shared/host-transport/plain-terminal-list-stream-client.ts::v1TerminalsByIdentity":
    {
      class: "NOT-AN-ANSWER",
      reason:
        "The terminal list cache of one client, keyed by terminal identity",
    },
  "shared/host-transport/released-sign-on.ts::instances": {
    class: "NOT-AN-ANSWER",
    reason:
      "The owner registry itself: a local observation of the process, not a host answer",
  },
  "shared/host-transport/remote/active-remote-sessions.ts::hostIds": {
    class: "NOT-AN-ANSWER",
    reason: "The host ids of the active remote sessions, derived from them",
  },
  "shared/host-transport/remote/pool-session-presence.ts::holds": {
    class: "HOST-ID-LIFETIME",
    reason: "Pool presence holds per host id; a restart is an evidence event",
    ref: "desktop-v1.5.4:clients/shared/host-transport/remote/pool-session-presence.ts:26",
  },
  "shared/host-transport/remote/pool-session-presence.ts::seenTombstoneIds": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Pool presence tombstones per host id; a restart is an evidence event",
    ref: "desktop-v1.5.4:clients/shared/host-transport/remote/pool-session-presence.ts:30",
  },
  "shared/host-transport/stream-method-support-registry.ts::supportByHostId": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Method support per host id, written only by a current-owner open ack",
    ref: "desktop-v1.5.4:clients/shared/host-transport/stream-method-support-registry.ts:95",
  },
  "shared/host-transport/ws-rpc-client.ts::localRevisionByHost": {
    class: "DORMANT",
    constructor: "createLocalOpenAuth",
  },
  "shared/host-transport/ws-rpc-client.ts::openSocketsByHost": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Session announcement for evidence, keyed by session within the host",
    ref: "desktop-v1.5.4:clients/shared/host-transport/ws-rpc-client.ts:1135",
  },
  "shared/host-transport/ws-rpc-client.ts::announcedByHost": {
    class: "HOST-ID-LIFETIME",
    reason:
      "Session announcement for evidence, keyed by session within the host",
    ref: "desktop-v1.5.4:clients/shared/host-transport/ws-rpc-client.ts:1136",
  },
  "shared/host-transport/ws-stream-client.ts::countedStreamDialTimeoutThrough":
    {
      class: "NOT-AN-ANSWER",
      reason: "Telemetry dedupe of this client's own local dial timeouts",
    },
  "shared/host-transport/ws-stream-client.ts::provisionAttemptedHostIds": {
    class: "HOST-ID-LIFETIME",
    reason: "One credential provision attempt per host per client",
    ref: "desktop-v1.5.4:clients/shared/host-transport/ws-stream-client.ts:373",
  },
  "shared/host-transport/ws-stream-client.ts::lastHostCredentialState": {
    class: "HOST-ID-LIFETIME",
    reason:
      "The host's credential-state answer per host id, re-armed on a fresh edge; only current-owner frames write it",
    ref: "desktop-v1.5.4:clients/shared/host-transport/ws-stream-client.ts:386",
  },
  "shared/host-transport/ws-stream-client.ts::provisionRetryTimers": {
    class: "HOST-ID-LIFETIME",
    reason: "The provision retry timer per host",
    ref: "desktop-v1.5.4:clients/shared/host-transport/ws-stream-client.ts:395",
  },
  "shared/host-transport/ws-stream-client.ts::provisionGenerations": {
    class: "NOT-AN-ANSWER",
    reason:
      "Local counters of this client's own provisions and socket barriers; neither is set from a frame",
  },
  "shared/host-transport/ws-stream-client.ts::teamCredentialSocketBarriers": {
    class: "NOT-AN-ANSWER",
    reason:
      "Local counters of this client's own provisions and socket barriers; neither is set from a frame",
  },
  "shared/host-transport/ws-stream-client.ts::handedOffHostIds": {
    class: "HOST-ID-LIFETIME",
    reason: "The credential handoff per host",
    ref: "desktop-v1.5.4:clients/shared/host-transport/ws-stream-client.ts:412",
  },
  "shared/host-transport/ws-stream-client.ts::pendingProvisions": {
    class: "HOST-ID-LIFETIME",
    reason: "Provisioning in flight per host",
    ref: "desktop-v1.5.4:clients/shared/host-transport/ws-stream-client.ts:424",
  },
  "shared/host-transport/ws-stream-client.ts::noProgressHostId": {
    class: "HOST-ID-LIFETIME",
    reason:
      "The no-progress unauthorized redial bound (ruling G4): 1.5.4 bounded unauthorized redials per stream across process restarts",
    ref: "desktop-v1.5.4:clients/shared/host-transport/ws-stream-client.ts:1640",
  },
  "shared/view-replica/store.ts::records": {
    class: "NOT-AN-ANSWER",
    reason: "The replica's own stored records, not a host answer",
  },
  "traycer-cli/src/commands/profile-login.ts::recorded": {
    class: "NOT-AN-ANSWER",
    reason: "Local record of what this command already wrote",
  },
  "traycer-cli/src/internal/cli-host-tokens.ts::leases": {
    class: "NOT-AN-ANSWER",
    reason: "An object cache of bearer sources",
  },
  "traycer-cli/src/internal/cli-host-tokens.ts::streamBearers": {
    class: "NOT-AN-ANSWER",
    reason: "An object cache of bearer sources",
  },
};

describe("host-id-keyed stores of host and mint answers", () => {
  const found = scanHostIdKeyedStores(CLIENTS_ROOT);

  it("lists every string-keyed answer store, so a new one needs a reason", () => {
    const unlisted = found
      .filter((store) => !(store.key in BASELINE))
      .map((store) => `${store.key} (line ${store.line})`);
    expect(unlisted).toEqual([]);
  });

  it("lists no store that no longer exists, or that is keyed by owner now", () => {
    const present = new Set(found.map((store) => store.key));
    expect(Object.keys(BASELINE).filter((key) => !present.has(key))).toEqual(
      [],
    );
  });

  it("never lists a store that round V keys by owner", () => {
    expect(OWNER_KEYED.filter((key) => key in BASELINE)).toEqual([]);
  });

  it("gives every host-id-lifetime entry the 1.5.4 line that kept it per host id", () => {
    const bad = Object.entries(BASELINE)
      .filter(
        ([, entry]) =>
          entry.class === "HOST-ID-LIFETIME" &&
          !HOST_ID_LIFETIME_REF.test(entry.ref),
      )
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("holds the three rulings to the owner's sentence they record", () => {
    const rulings = new Set(
      Object.values(BASELINE).flatMap((entry) =>
        entry.class === "RULING" ? [entry.ruling] : [],
      ),
    );
    expect([...rulings].sort()).toEqual(["G1", "G3", "G4"]);
    expect(RULING_TEXT.G1).toBe(
      "one cover per host, fed only fenced current-owner reports; cleared by any admission",
    );
  });

  it("fails a dormant store when its constructor gains a production caller", () => {
    const constructors = new Set(
      Object.values(BASELINE).flatMap((entry) =>
        entry.class === "DORMANT" ? [entry.constructor] : [],
      ),
    );
    const callers: string[] = [];
    for (const file of scannedSources(CLIENTS_ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const name of constructors) {
        const call = new RegExp(`\\b${name}\\s*\\(`);
        const defines = new RegExp(`function\\s+${name}\\b`);
        if (call.test(text) && !defines.test(text)) {
          callers.push(`${relative(CLIENTS_ROOT, file)}: ${name}`);
        }
      }
    }
    expect(constructors.size).toBeGreaterThan(0);
    expect(callers).toEqual([]);
  });

  describe("the scan's rule", () => {
    const scan = (source: string): string[] =>
      findHostIdKeyedStores("probe.ts", source).map(
        (store) => store.identifier,
      );

    it("finds a string-keyed store of an answer, in a variable, a class property and a constructor", () => {
      expect(
        scan(`
          const refusalByHost = new Map<string, FatalErrorDetails>();
          class A {
            private readonly admitted = new Set<string>();
            private minted: Map<string, number>;
            constructor() { this.minted = new Map(); }
          }
        `).sort(),
      ).toEqual(["admitted", "minted", "refusalByHost"]);
    });

    it("finds a store whose name does not say host but whose keys are host ids", () => {
      expect(
        scan(`
          const table = new Map<string, number>();
          function note(hostId: string) { table.set(hostId, 1); }
        `),
      ).toEqual(["table"]);
    });

    it("finds the scalar pair of a host id kept beside a count", () => {
      expect(
        scan(`
          class A { private noProgressHostId: string | null = null; }
        `),
      ).toEqual(["noProgressHostId"]);
    });

    it("passes a store keyed by the process instance or by the owner key", () => {
      expect(
        scan(`
          const marks = new WeakMap<HostInstance, Marks>();
          const held = new Map<HostInstance, Marks>();
          const flights = new Map<string, Promise<HostTokenMintOutcome>>();
          function ask(owner: HostInstance) { flights.set(ownerKey(owner), p); }
        `),
      ).toEqual([]);
    });

    it("finds a store once any write to it is not owner-keyed", () => {
      expect(
        scan(`
          const flights = new Map<string, Promise<HostTokenMintOutcome>>();
          function a(owner: HostInstance) { flights.set(ownerKey(owner), p); }
          function b(hostId: string) { flights.set(hostId, p); }
        `),
      ).toEqual(["flights"]);
    });

    it("passes a constant table and a copy, which start from an argument", () => {
      expect(
        scan(`
          const REFUSAL_CODES = new Set(["a", "b"]);
          function f(rows: string[]) { const hosts = new Set(rows); return hosts; }
        `),
      ).toEqual([]);
    });
  });
});
