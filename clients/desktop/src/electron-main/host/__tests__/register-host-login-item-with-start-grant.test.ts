import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  verifyUpdateMutationCapability,
  withUpdateContender,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import { sandboxHome } from "../../__tests__/sandbox-home";

const loginItemMocks = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  retire: vi.fn(),
}));

vi.mock("../../app/host-login-item", () => ({
  registerHostLoginItem: loginItemMocks.register,
  unregisterHostLoginItemGuarded: loginItemMocks.unregister,
  retireCompetingCliRegistrationAtLaunchGuarded: loginItemMocks.retire,
}));

import { registerHostLoginItemWithStartGrant } from "../update-mutation";
import { getHostFsLayout } from "../host-paths";
// VALUE imports of the CLI admission/adoption graph are deliberately NOT
// static (only the two pure types below are): `store/paths.ts` computes
// `TRAYCER_HOME`/`HOST_HOME` as MODULE-LEVEL constants from `homedir()` at
// import time (lines 55-57), once, never re-read. A static top-level import
// here would evaluate that module before `beforeEach`'s `sandboxHome()` ever
// runs, caching whatever HOME was ambient at file-load - not this test's
// sandbox - so test 1's admission/consume calls would read/write a
// DIFFERENT directory than the one `layout.rootDir` (computed fresh, no
// caching) both `getHostFsLayout` and `registerHostLoginItemWithStartGrant`
// use. That split cannot be told apart from a genuinely absent grant by its
// symptom alone. Test 1 imports this graph fresh, per-test, inside its own
// body; test 2 never touches it (it verifies rejection/release only), so it
// is unaffected and untouched.
import type { SupervisorLifecycleGate } from "../../../../../traycer-cli/src/host/lifecycle-admission";
import type { HostStartAdoptionConsumeResult } from "../../../../../traycer-cli/src/host/host-start-adoption";
import {
  serviceLabelFor,
  smAppServiceAgentLabelId,
} from "../../../../../traycer-cli/src/service/label";
// `service/label.ts` is exempt: it imports `node:os`'s `homedir` only for a
// code path this file never reaches (`serviceLabelFor("production")` returns
// the static `PRODUCTION_LABEL` object without calling it), proven by direct
// read of `service/label.ts`, not assumed.

// `registerHostLoginItemWithStartGrant` in isolation (`update-mutation.ts`),
// not through the whole `HostController`: the real contender +
// `publishHostStartAdoption`/`consumeHostStartAdoption`/`admitSupervisorLifecycle`
// seams are exercised directly, with only the OS-native `registerHostLoginItem`
// binding stubbed. This is the production fix the #2267 regression
// (`registration-fallback-host-start-grant.test.ts`) demanded; that file keeps
// covering the end-to-end `HostController.recoverIfDown()` route, this one
// covers the helper's own two edges: the grant surviving a real supervisor
// that admits and acknowledges AFTER `register` returns but before the
// mutation completes, and the lease timing out and releasing everything when
// no supervisor ever does.
//
// The CLI's admission/adoption functions used here (`consumeHostStartAdoption`,
// `readDesktopPresence`, `writeHostLifecyclePolicyFromCli`, ...) resolve their
// own home directory from `process.env.HOME` (`hostHomeDir(environment)`),
// while `registerHostLoginItemWithStartGrant` takes an explicit `hostHomeDir`
// string. The two must be the SAME directory for a proof either side writes
// to be visible to the other - the documented path-parity fact between
// Desktop's `getHostFsLayout("production").rootDir` and the CLI's
// `hostHomeDir("production")` - so this suite sandboxes `HOME` via
// `sandboxHome()` and reads `layout.rootDir` from it, rather than an
// unrelated temp directory.

const ENVIRONMENT = "production" as const;
const SERVICE_LABEL = smAppServiceAgentLabelId(serviceLabelFor(ENVIRONMENT));

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "register-with-start-grant-"));
  sandboxHome(workHome);
  loginItemMocks.register.mockReset();
});

afterEach(() => {
  loginItemMocks.unregister.mockReset();
  loginItemMocks.retire.mockReset();
});

/** One extra macrotask turn: lets a just-resolved promise's `.then` chain
 * (here, `registerHostLoginItemWithAttempt`'s own post-register work and the
 * `if (result === "enabled") await lease.waitForSpawn()` transition) actually
 * run before the next assertion, rather than merely having been scheduled. */
function nextTimerTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registerHostLoginItemWithStartGrant", () => {
  it("register resolving enabled does not itself complete the mutation: a real supervisor admitting and acknowledging afterward still lets it finish and releases the lease", async () => {
    // Fresh, post-sandbox import of the whole CLI admission/adoption graph:
    // `beforeEach` has already run `sandboxHome(workHome)` by this point, so
    // `store/paths.ts`'s module-level `TRAYCER_HOME`/`HOST_HOME` compute
    // against THIS test's sandbox rather than whatever HOME was ambient when
    // this file first loaded. `resetModules()` first, so nothing reuses an
    // instance a prior test (or this file's own static type-only imports,
    // which carry no runtime module) already evaluated.
    vi.resetModules();
    const { hostHomeDir } =
      await import("../../../../../traycer-cli/src/store/paths");
    const {
      readDesktopPresence,
      probeDesktopPresenceLiveness,
      readHostLifecyclePolicy,
      writeHostLifecyclePolicyFromCli,
    } = await import("../../../../../traycer-cli/src/host/lifecycle-files");
    const { admitSupervisorLifecycle } =
      await import("../../../../../traycer-cli/src/host/lifecycle-admission");
    const { consumeHostStartAdoption, readHostStartAdoptionNonce } =
      await import("../../../../../traycer-cli/src/host/host-start-adoption");

    const layout = getHostFsLayout(ENVIRONMENT);

    // The explicit split-detector: the CLI's own real home resolver against
    // Desktop's own real layout root, both freshly computed for this exact
    // test, asserted BEFORE anything that depends on the two sides agreeing.
    // A future regression of the import-time caching bug fails immediately
    // and legibly here, instead of manifesting as a `consumed.kind ===
    // "absent"` indistinguishable from a genuinely unminted grant.
    expect(hostHomeDir(ENVIRONMENT)).toBe(layout.rootDir);

    // Linked, not Background: `admitSupervisorLifecycle` reads the policy
    // before it ever consumes anything, and Background short-circuits to
    // `run` with `consumed: null` (`consumeAdoption` is never called - see
    // `lifecycle-admission.ts` lines 124-127) - which would leave nothing for
    // this test's admission call to observe. Any non-Background mode reaches
    // the real consume, and a `"grant"` consumption always runs regardless of
    // mode (`decideUnattendedStart` is never asked once the proof is live).
    await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "linked",
      new Date("2026-09-29T00:00:00.000Z"),
    );

    // An explicit register-RETURN signal, not the proof file: the proof is
    // published BEFORE `registerHostLoginItemWithAttempt` calls this mock
    // (`registerHostLoginItemWithStartGrant`'s own order - publish, then
    // register), so the proof existing proves nothing about whether register
    // has even been called yet, let alone returned.
    //
    // A typed holder for the resolver, not a closure-only-assigned `let`:
    // this repo's lint bans that pattern (TS2349/never-narrowing) even where
    // the assignment is provably synchronous, as it is inside a `Promise`
    // executor.
    const registerSignal: { resolve?: () => void } = {};
    const registerCalled = new Promise<void>((resolve) => {
      registerSignal.resolve = resolve;
    });
    loginItemMocks.register.mockImplementation(async () => {
      registerSignal.resolve?.();
      return "enabled";
    });

    const captured: {
      capability?: UpdateMutationCapability;
      consumed?: HostStartAdoptionConsumeResult;
      admission?: SupervisorLifecycleGate;
    } = {};
    let settled = false;
    const operation = withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "register-host-login-item-with-start-grant-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      (capability) => {
        captured.capability = capability;
        return registerHostLoginItemWithStartGrant(
          capability,
          layout.rootDir,
          SERVICE_LABEL,
        );
      },
    );
    operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      await registerCalled;
      // One more turn past register's own return, so execution is genuinely
      // past the `if (result === "enabled") await lease.waitForSpawn()`
      // branch and into the wait itself, not merely about to take it.
      await nextTimerTurn();

      expect(loginItemMocks.register).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      const capability = captured.capability;
      if (capability === undefined) {
        throw new Error("the contender never handed the callback a capability");
      }
      await expect(
        verifyUpdateMutationCapability(capability, layout.rootDir),
      ).resolves.toEqual({ kind: "live" });

      // The real nonce, not `null`: a nonce-less labelled consume against a
      // LIVE, non-expired, non-orphaned proof is unconditionally REFUSED
      // (`shared/host-start-adoption/index.ts`'s labelled-consume path), never
      // `absent` and never a `grant`. The real launcher discovers this same
      // nonce via the CLI's `adoption-nonce` command before calling
      // `host start --adoption-nonce <nonce>`, so this must match.
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
            return consumed;
          },
          now: () => new Date().toISOString(),
        },
      );
      captured.admission = admission;

      expect(captured.consumed?.kind).toBe("grant");
      expect(captured.admission?.kind).toBe("run");
      expect(
        captured.consumed?.kind === "grant"
          ? captured.consumed.grant.origin
          : null,
      ).toBe("desktop");

      // The real acknowledgement - the one thing `waitForSpawn()` is polling
      // for - lets the still-pending mutation resolve.
      if (captured.consumed?.kind === "grant") {
        await captured.consumed.grant.acknowledgeSpawn();
      }

      await expect(operation).resolves.toEqual({
        kind: "ran",
        result: "enabled",
      });

      // The concrete released verdict, not an inferred absence: the outer
      // contender's own `finally { await acquisition.handle.release(); }`
      // has run, so a fresh check against the SAME capability object now
      // reports `released`, never merely "not live for some other reason".
      await expect(
        verifyUpdateMutationCapability(capability, layout.rootDir),
      ).resolves.toEqual({ kind: "released" });
    } finally {
      // Guaranteed drain: if an assertion above threw while the mutation was
      // still parked in `waitForSpawn()`, acknowledge the real grant (if one
      // was ever consumed) and await the operation to settle either way, so
      // a failing assertion never leaves a dangling timer/promise to bleed
      // into a later test.
      if (captured.consumed?.kind === "grant") {
        await captured.consumed.grant.acknowledgeSpawn().catch(() => undefined);
      }
      await operation.catch(() => undefined);
    }
  });

  it("no supervisor ever acknowledges: the real ack-wait bound times out, the lease cancels, and the mutation rejects instead of hanging", async () => {
    const layout = getHostFsLayout(ENVIRONMENT);
    loginItemMocks.register.mockResolvedValue("enabled");

    // The existing constant, not a new one: `HOST_START_ADOPTION_ACK_WAIT_MS`
    // (`@traycer-clients/shared/host-start-adoption/spawn-edge-bounds.ts`) is
    // 50s in production. `start-retry-refused-live-supervisor.test.ts` and
    // `start-retry-after-parked-exit.test.ts` establish the precedent this
    // test follows rather than `vi.useFakeTimers()`: both tried fake timers
    // first and document a real deadlock (the lease's own `setTimeout`-based
    // poll never fires while timers sit un-advanced, and advancing them only
    // after the fact races the deadline computation). Shrinking the real,
    // already-exported constant keeps every wait on the real clock, just
    // against a budget this test can afford.
    vi.resetModules();
    vi.doMock(
      "@traycer-clients/shared/host-start-adoption/spawn-edge-bounds",
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import("@traycer-clients/shared/host-start-adoption/spawn-edge-bounds")
          >();
        return { ...actual, HOST_START_ADOPTION_ACK_WAIT_MS: 300 };
      },
    );
    try {
      const { registerHostLoginItemWithStartGrant: registerWithShortAckWait } =
        await import("../update-mutation");
      // Both from the SAME freshly re-evaluated module instance: `resetModules()`
      // means the capability this test's `withUpdateContender` issues is
      // tracked in THIS module's own `issuedCapabilities`/`capabilityStates`
      // WeakMaps, not the ones the top-level `verifyUpdateMutationCapability`
      // import (bound before `resetModules()`) closes over. Verifying with
      // the stale top-level import would read an unrecognized capability and
      // report `not-issued`, never the real `released` verdict this test
      // means to prove.
      const {
        withUpdateContender: withUpdateContenderFreshModule,
        verifyUpdateMutationCapability:
          verifyUpdateMutationCapabilityFreshModule,
      } = await import("@traycer-clients/shared/host-update");
      const { SpawnAcknowledgementTimeoutError } =
        await import("@traycer-clients/shared/host-start-adoption/spawn-acknowledgement-error");

      const proofPath = join(layout.rootDir, ".host-start-adoption.json");
      const captured: { capability?: UpdateMutationCapability } = {};
      const operation = withUpdateContenderFreshModule(
        {
          hostHomeDir: layout.rootDir,
          reason: "register-host-login-item-with-start-grant-timeout-test",
          waitMs: 0,
          pollIntervalMs: 10,
          admission: "recovery-maintenance",
        },
        (capability) => {
          captured.capability = capability;
          return registerWithShortAckWait(
            capability,
            layout.rootDir,
            SERVICE_LABEL,
          );
        },
      );

      await expect(operation).rejects.toBeInstanceOf(
        SpawnAcknowledgementTimeoutError,
      );

      // Nothing hung, and the lease's own `finally` still ran: the proof (and
      // any ack file, though none was ever written) is gone.
      expect(existsSync(proofPath)).toBe(false);

      // The concrete released verdict for the SAME capability the mutation
      // ran under, read through the SAME fresh module instance that issued
      // it: the outer contender's own
      // `finally { await acquisition.handle.release(); }` ran despite `run`
      // throwing, so this is `released`, not merely inferred from the proof
      // file's absence.
      const capability = captured.capability;
      if (capability === undefined) {
        throw new Error("the contender never handed the callback a capability");
      }
      await expect(
        verifyUpdateMutationCapabilityFreshModule(capability, layout.rootDir),
      ).resolves.toEqual({ kind: "released" });
    } finally {
      // In `finally` so a failing assertion above still unmocks the shared
      // leaf and resets modules - otherwise the shrunk
      // `HOST_START_ADOPTION_ACK_WAIT_MS` would poison every later test's
      // module registry in this file/worker.
      vi.doUnmock(
        "@traycer-clients/shared/host-start-adoption/spawn-edge-bounds",
      );
      vi.resetModules();
    }
  });
});
