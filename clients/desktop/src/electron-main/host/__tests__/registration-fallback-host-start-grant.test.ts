import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";

// #2267: `registerAgentInsteadOfRestart`'s SMAppService register (the
// no-launchd-job restart fallback) mints no CLI host-start adoption grant,
// so the supervisor it eventually starts finds its own admission proof
// absent and, under a non-Background lifecycle mode with no presence
// record, PARKS silently. Constructed regression (Linked mode + a forced
// launch-presence write failure), not a measured report. Full derivation
// and the real-vs-mocked boundary rationale: integration18/test-fixes.md.

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => join(process.env.HOME ?? "/tmp", "userData")),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
    getVersion: vi.fn(() => "9.9.9"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// The CLI subprocess wrapper: `registerAgentInsteadOfRestart`'s own route
// never spawns the CLI at all (that is exactly the bug - it goes straight to
// SMAppService), but other paths this controller can take on construction
// reference it, so it is stubbed inert rather than left unmocked.
vi.mock("../../cli/traycer-cli", () => ({
  runBundledTraycerCliJson: vi.fn(async () => ({})),
  streamBundledTraycerCliJson: vi.fn(async () => ({ data: {} })),
  TraycerCliError: class extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("../../cli/cli-discovery", () => ({
  resolveBundledCliPath: vi.fn(async () => null),
  readCliManifest: vi.fn(async () => null),
}));

// The macOS SMAppService bindings - the one genuinely OS-native surface this
// test stubs. `registerHostLoginItem` succeeding is the premise: the bug is
// that a SUCCESSFUL registration still leaves the eventual supervisor with
// no grant to consume, not that registration itself fails.
vi.mock("../../app/host-login-item", () => ({
  hostManagesHostLoginItem: vi.fn(async () => true),
  registerHostLoginItem: vi.fn(async () => "enabled"),
  unregisterHostLoginItemGuarded: vi.fn(async () => true),
  retireCompetingCliRegistrationAtLaunchGuarded: vi.fn(
    async () => "not-applicable",
  ),
  hasUnappliedPendingLoginItemRevision: vi.fn(async () => false),
  readHostLoginItemStatus: vi.fn(() => "enabled"),
  readParkedRegistrationTakeover: vi.fn(async () => ({
    kind: "no-takeover",
    reason: "primary-manageable",
  })),
  readHostLaunchdJobs: vi.fn(async () => "neither-loaded"),
}));

// Shared with the `it` body below via `vi.hoisted` (this factory runs before
// ordinary top-level statements): the fallback's own admission result IS the
// gate here, not an unconditional "always ready" stub. Before registration,
// on the current unfixed `park`, or on an `admitSupervisorLifecycle` refusal,
// this stays `false`, so the mocked readiness/reachability observations
// cohere with the real admission outcome instead of contradicting it -
// "true" is earned only once the real captured admission is `"run"`.
const readinessGate = vi.hoisted(() => ({ admitted: false }));

vi.mock("../host-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-readiness")>();
  return {
    ...actual,
    waitForHostReady: vi.fn(async () => {
      if (!readinessGate.admitted) {
        return {
          ready: false,
          version: null,
          pid: null,
          startedAt: null,
          reason: "timeout",
        };
      }
      return {
        ready: true,
        version: "1.7.0",
        pid: 4242,
        startedAt: "2026-01-01T00:00:00.000Z",
        reason: "ready",
      };
    }),
  };
});

import { registerHostLoginItem } from "../../app/host-login-item";
import { HostController, type HostControllerHostLifecycle } from "../host-controller";
import { getHostFsLayout, cliLockPath } from "../host-paths";
import { DEV_DESKTOP_SLOT_ENV } from "../dev-desktop-slot";
import { HostLifecyclePolicyStore } from "../host-lifecycle-policy";
import { HostLifecycleService } from "../host-lifecycle-transitions";

// The real CLI lifecycle/adoption modules, imported directly across the
// package boundary (no package alias exists for this yet - the coordinator's
// own plan is to move these into shared after this RED lands). Every
// transitive import they make (protocol config, `@traycer-clients/shared/
// host-lock/process-identity`, `@traycer-clients/shared/host-update`) is
// already aliased in this project's vitest config for the desktop suites
// that use those packages directly.
//
// VALUE imports of this graph are deliberately NOT static (only the two pure
// types below are): `store/paths.ts` computes `TRAYCER_HOME`/`HOST_HOME` as
// MODULE-LEVEL constants from `homedir()` at import time (lines 55-57), once,
// never re-read. A static top-level import here would evaluate that module
// before `beforeEach`'s `sandboxHome()` ever runs, caching whatever HOME was
// ambient at file-load - not this test's sandbox - so every CLI-side
// admission/consume call would read/write a DIFFERENT directory than the one
// Desktop's `getHostFsLayout` (computed fresh on every call, no caching)
// publishes to. That split cannot be told apart from a genuinely absent
// grant by its symptom alone (soft assertions stuck failing, a real ack-wait
// timeout) - it must be imported fresh, after the sandbox is in effect, via
// `vi.resetModules()` + dynamic `import()` inside the `it` body below.
import type { SupervisorLifecycleGate } from "../../../../../traycer-cli/src/host/lifecycle-admission";
import type { HostStartAdoptionConsumeResult } from "../../../../../traycer-cli/src/host/host-start-adoption";
import {
  serviceLabelFor,
  smAppServiceAgentLabelId,
} from "../../../../../traycer-cli/src/service/label";
// `service/label.ts` is exempt from the dynamic-import requirement above: it
// imports `node:os`'s `homedir` only for a code path this file never reaches
// (`serviceLabelFor("production")` returns the static `PRODUCTION_LABEL`
// object without calling it), proven by direct read of `service/label.ts`,
// not assumed.

const ENVIRONMENT = "production" as const;
// The real SMAppService agent label id this registration publishes under -
// `hostStartAdoptionLabel`'s own resolution once a desktop agent owns the
// registration (`smAppServiceAgentLabelId(serviceLabelFor(environment))`,
// clients/traycer-cli/src/service/{label,platforms/macos}.ts), not a guessed
// string: the future publisher must key its grant under this same label for
// the launched supervisor's `admitSupervisorLifecycle` call to find it.
const SERVICE_LABEL = smAppServiceAgentLabelId(serviceLabelFor(ENVIRONMENT));

// Gated on the same `readinessGate` the mocked readiness/reachability read:
// `publishReachableHostSnapshot()` (`host-controller.ts`) only ever calls
// this AFTER `waitForHostReady` reports ready, so on the current unfixed
// tree it is never reached at all (the RED there is the readiness timeout
// itself); the non-null snapshot shape below matches
// `host-controller.test.ts`'s own `fakeHostLifecycle` success fixture, for
// the fixed-behavior path where readiness genuinely flips true.
function fakeHostLifecycle(): HostControllerHostLifecycle {
  return {
    notifyRespawning: () => undefined,
    ensureWatcherInstalled: () => undefined,
    reloadSnapshotFromDisk: async () =>
      readinessGate.admitted
        ? {
            hostId: "host-1",
            websocketUrl: "ws://127.0.0.1:55555/rpc",
            version: "1.7.0",
            pid: 4242,
            systemHostName: "test-host",
            displayName: "Test Host",
            availability: "available",
          }
        : null,
  };
}

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-2267-red-"));
  sandboxHome(workHome);
  delete process.env[DEV_DESKTOP_SLOT_ENV];
  // `withDesktopCliLock`'s `open(path, "wx", ...)` needs the real
  // cross-process CLI lock file's parent directory to already exist -
  // production always has it (the CLI slot setup creates it early); a fresh
  // sandboxed HOME does not. Derived from the same real, exported helper
  // `HostController` itself uses to compute `this.lockPath`
  // (`cliLockPath(environment)`, `../host-paths`), not a hand-typed
  // `.traycer/cli` literal.
  mkdirSync(dirname(cliLockPath(ENVIRONMENT)), { recursive: true });
  readinessGate.admitted = false;
  vi.mocked(registerHostLoginItem).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("#2267: registering the login item as a restart fallback must mint a host-start grant (RED)", () => {
  it("registering the fallback mints a desktop grant that the eventual supervisor admits", async () => {
    // Fresh, post-sandbox import of the whole CLI admission/adoption graph:
    // `beforeEach` has already run `sandboxHome(workHome)` by this point, so
    // `store/paths.ts`'s module-level `TRAYCER_HOME`/`HOST_HOME` compute
    // against THIS test's sandbox rather than whatever HOME was ambient when
    // this file first loaded. `resetModules()` first, so nothing reuses an
    // instance a prior test (or the file's own static type-only imports,
    // which carry no runtime module) already evaluated.
    vi.resetModules();
    const { hostHomeDir } = await import(
      "../../../../../traycer-cli/src/store/paths"
    );
    const {
      readDesktopPresence,
      probeDesktopPresenceLiveness,
      readHostLifecyclePolicy,
      writeHostLifecyclePolicyFromCli,
    } = await import("../../../../../traycer-cli/src/host/lifecycle-files");
    const { admitSupervisorLifecycle } = await import(
      "../../../../../traycer-cli/src/host/lifecycle-admission"
    );
    const { consumeHostStartAdoption, readHostStartAdoptionNonce } =
      await import("../../../../../traycer-cli/src/host/host-start-adoption");

    // ---- World: packaged macOS, no launchd job, no host serving --------
    const layout = getHostFsLayout(ENVIRONMENT);

    // The explicit split-detector the coordinator asked for, BEFORE anything
    // that depends on the two sides agreeing: the CLI's own real home
    // resolver against Desktop's own real layout root, both freshly computed
    // for this exact test. A future regression here fails immediately and
    // legibly, instead of manifesting as a `consumed.kind === "absent"` that
    // is indistinguishable from a genuinely unminted grant.
    expect(hostHomeDir(ENVIRONMENT)).toBe(layout.rootDir);

    mkdirSync(layout.installDir, { recursive: true });
    writeFileSync(
      layout.installRecordFile,
      JSON.stringify({
        installId: "install-1",
        version: "1.7.0",
        runtimeVersion: "1.7.0",
        installedAt: "2026-01-01T00:00:00.000Z",
        archiveSha256: "a".repeat(64),
        platform: process.platform,
        arch: process.arch,
        source: { kind: "registry", value: "1.7.0" },
        signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
        signatureKeyId: "test-key",
        sizeBytes: 1,
        executablePath: join(layout.installDir, "traycer-host"),
      }),
    );

    // ---- Constructed mode: Linked, not Background. Background never parks
    // regardless of presence/adoption (`decideUnattendedStart`), so Linked
    // is what makes an unfixed absent grant observable as a park - written
    // with the real CLI writer, the same one `traycer host lifecycle set`
    // uses.
    await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "linked",
      new Date("2026-09-29T00:00:00.000Z"),
    );

    // ---- Step 1 (real): the desktop launch-presence write, with this
    // process's own start identity unreadable - "identity-unavailable", a
    // constructed "no prior presence" regression.
    // `readOwnStartIdentity` returning null IS the existing dependency seam
    // `HostLifecyclePolicyStore` exposes for this - not a mocked admission,
    // not a fabricated store: the same constructor option
    // `desktop-startup.ts` wires to a real OS probe in production.
    const presenceStore = new HostLifecyclePolicyStore({
      hostHomeDir: layout.rootDir,
      pidMetadataFile: layout.pidMetadataFile,
      ownPid: process.pid,
      readOwnStartIdentity: async () => null,
      now: () => new Date("2026-09-29T00:00:00.000Z"),
    });
    const lifecycleService = new HostLifecycleService({
      store: presenceStore,
      controller: {
        convergeReady: async () => ({ kind: "ok", value: { running: true, version: null } }),
        applyStaged: async () => ({
          kind: "ok",
          value: { appliedVersion: "1.7.0", runningActivated: true, applied: false },
        }),
        stopHost: async () => ({ kind: "stopped", forced: false }),
        refreshServiceDefinition: async () => ({
          kind: "ok",
          value: { result: "current", appliesAt: null },
        }),
        quiesce: () => undefined,
        holdAutomaticIntents: () => ({ release: () => undefined }),
        deferMutationsUntil: () => undefined,
      },
      records: {
        watchLifecycleRecords: async () => undefined,
        onLifecycleRecordsChanged: () => () => undefined,
      },
      localHostCapability: "managed",
      pollIntervalMs: 3_600_000,
    });

    await lifecycleService.holdLaneOnLaunchPresence();

    // Intermediate evidence 1/2, proven rather than assumed: the write really
    // failed and no presence record exists - not a vacuous "we never tried"
    // gap, and not something a later admission read could paper over.
    const presenceAfterFailedWrite = await readDesktopPresence(ENVIRONMENT);
    expect(presenceAfterFailedWrite.kind).toBe("absent");

    // ---- Step 2 (real): recoverIfDown falls through to the register
    // route, exactly the unfixed production path, and it reports success -
    // the SMAppService call itself is not what is broken.
    const controller = new HostController({
      environment: ENVIRONMENT,
      hostLifecycle: fakeHostLifecycle(),
      // Coherent with the mocked readiness poll above, not independently
      // `false`: down before registration, down under an unfixed park/
      // refusal, and only reachable once the real captured admission is
      // `"run"` - the exact state `readinessGate.admitted` tracks.
      reachabilityProbe: async () => readinessGate.admitted,
      desktopLockWaitMs: 100,
      desktopLockPollIntervalMs: 10,
      supervisorRun: {
        readSupervisorRun: async () => ({
          state: "not-running",
          supervisorPid: null,
          admittedAs: null,
        }),
      },
    });

    // The service launch happens as part of the successful register/start
    // seam. Admit it there: a grant is single-use and must remain claimed
    // through its acknowledgement, before `recoverIfDown` releases the
    // publisher's capability/lease.
    //
    // Object-property holders, not bare `let`s: a closure-only-assigned
    // `let X | null` narrows to `never` at later reads under this file's
    // tsconfig (the same TS2349 class fixed in integration15's
    // provider-login-runner.test.ts). A `const` object with optional
    // properties does not.
    const captured: {
      consumed?: HostStartAdoptionConsumeResult;
      admission?: SupervisorLifecycleGate;
    } = {};
    vi.mocked(registerHostLoginItem).mockImplementationOnce(async () => {
      // The real nonce, not `null`: a nonce-less labelled consume against a
      // LIVE, non-expired, non-orphaned proof is unconditionally REFUSED
      // (`shared/host-start-adoption/index.ts`'s labelled-consume path -
      // `expectedNonce === null` refuses whenever the pending proof is
      // still valid), never `absent` and never a `grant`. The real launcher
      // (`desktop/scripts/prepack/inject-host-launch-agent.cjs`) discovers
      // this same nonce via the CLI's `adoption-nonce` command before it
      // ever calls `host start --adoption-nonce <nonce>` (forwarded into
      // admission at `commands/host-start.ts`), so this mock must do the
      // same real discovery to match the actual admitted path.
      const adoptionNonce = await readHostStartAdoptionNonce(
        ENVIRONMENT,
        SERVICE_LABEL,
      );
      const admission = await admitSupervisorLifecycle(
        {
          environment: ENVIRONMENT,
          serviceLaunch: { serviceLabel: SERVICE_LABEL, adoptionNonce },
        },
        {
          readPolicy: readHostLifecyclePolicy,
          readPresence: readDesktopPresence,
          probePresence: probeDesktopPresenceLiveness,
          consumeAdoption: async (environment, serviceLabel, adoptionNonce) => {
            const consumed = await consumeHostStartAdoption(
              environment,
              serviceLabel,
              adoptionNonce,
            );
            captured.consumed = consumed;
            if (consumed.kind === "grant") {
              await consumed.grant.acknowledgeSpawn();
            }
            return consumed;
          },
          now: () => new Date().toISOString(),
        },
      );
      captured.admission = admission;
      // Earn readiness/reachability from the SAME real captured admission,
      // not a fixture-independent flag: on the current unfixed tree
      // `admission.kind` is `"park"`, so this stays `false` and the RED
      // shows up as the actual causal chain (no grant -> parked admission ->
      // the host never becomes observably ready) rather than a downstream
      // artifact of a fixture that told readiness "true" while telling
      // reachability "false".
      readinessGate.admitted = admission.kind === "run";
      return "enabled";
    });

    const recovery = await controller.recoverIfDown();

    // Soft assertions FIRST, so all RED evidence - the absent consumption,
    // the parked admission, and (via the readiness gate above) the
    // downstream readiness/recovery failure - is retained together rather
    // than the run stopping at whichever fails first. The hard recovery
    // assertion below runs regardless, since `expect.soft` never throws.
    expect.soft(captured.consumed?.kind).toBe("grant");
    expect.soft(captured.admission?.kind).toBe("run");
    expect
      .soft(
        captured.consumed?.kind === "grant"
          ? captured.consumed.grant.origin
          : null,
      )
      .toBe("desktop");

    expect(recovery).toEqual({ kind: "ok", value: { activated: true } });
    expect(registerHostLoginItem).toHaveBeenCalledTimes(1);
  });
});
