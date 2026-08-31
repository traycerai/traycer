/**
 * The `.catch` on `onLocalDocUpdate`'s `body/update` call (`store.ts`,
 * `createMainThreadBodyDocStore({ onLocalDocUpdate: ... })`).
 *
 * That callback fires on every LOCAL Yjs edit to a resident artifact body and
 * posts it as `void runtime.port.call("body/update", ...).catch(...)`. The
 * verdict is deliberately discarded - a refused body update is not a failed
 * user action - but a `.catch` on a `void`ed chain that RETHROWS mints a new,
 * unhandled rejection instead of reaching a logger: nobody awaits the outer
 * chain, so the rethrow has no catcher. It fires once per keystroke, so one
 * broken worker handler used to produce one unhandled rejection per edit for
 * as long as the person kept typing. The fix logs via `appLogger.error`
 * instead of rethrowing, and leaves the `BridgeDisposedError` early-return
 * (teardown, not a fault) unchanged.
 *
 * Reached through the REAL `createOpenEpicStore`, over a REAL
 * `createMainBridgeEndpoint`/`createFakeBridgePair` pair - not a hand-typed
 * `RuntimeWorkerPort` fake, which cannot express a rejection without either
 * fighting `call`'s generic signature or reimplementing the endpoint's own
 * settle/abort semantics (both of which this repo already has: `abortAll`
 * rejects every outstanding call with `BridgeDisposedError` on `dispose()`,
 * and an `{ outcome: "error" }` result rejects with `BridgeCallError`). Same
 * harness `artifact-body-lease-bridge.test.ts` already drives against this
 * exact bridge pair, pointed at `createOpenEpicStore` instead so the closure
 * under test is `store.ts`'s own, not a reimplementation of it.
 *
 * Getting a LOCAL edit to fire at all requires a resident body doc, which
 * requires an `acquireResidentArtifactBodyLease` round trip through
 * `body/materialize` - there is no lighter seam that reaches the real
 * closure. `installedArm: "lanes"` (pushed via the store's own `projection`
 * handle) is what lets the materialize fixture answer with
 * `docKey === artifactId` and skip fabricating an `artifacts.byId` entry:
 * `getArtifactBodyDocKey` returns the artifact id directly on that arm.
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createMainBridgeEndpoint } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  createFakeBridgePair,
  type FakeBridgePair,
} from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import { stubMainCallHandlers } from "@traycer-clients/shared/replica-runtime/worker/test-support/stub-main-call-handlers";
import { isMainToWorkerFrame } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import {
  createOpenEpicStore,
  type EpicRuntimeBinding,
} from "@/stores/epics/open-epic/store";
import { createProcessBackedAccountingPort } from "@/stores/epics/open-epic/runtime/process-backed-accounting-port";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { appLogger } from "@/lib/logger";

const EPIC_ID = "epic-body-update-refusal";
const ARTIFACT_ID = "artifact-1";

/**
 * Rejections are asserted through Node's own `process` event rather than
 * `window.addEventListener("unhandledrejection")`: `vitest.config.ts` sets
 * `dangerouslyIgnoreUnhandledErrors` and the setup file registers a
 * process-level swallow, so an empty-array assertion taken off the DOM event
 * reads the same whether nothing rejected or nothing fired at all. Mirrors
 * `epic-title-write-settlement.test.ts` / `sidebar-reparent-commit-routing.test.ts`'s
 * helpers of the same names.
 */
function captureUnhandledRejections(): {
  readonly seen: unknown[];
  readonly stop: () => void;
} {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => {
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

/** Two macrotasks: one for the `.catch` to run, one for Node to judge it. */
async function drainRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A hand-written worker side over the fake pair: answers `body/materialize`
 * immediately (granted, empty doc), and hands `body/update` calls to the test
 * so it can choose per-call how the worker answers - the two arms this file
 * pins.
 */
function createWorkerSide(pair: FakeBridgePair): {
  readonly pendingBodyUpdateCallIds: number[];
  respondBodyUpdateError(name: string, message: string): void;
  unsubscribe(): void;
} {
  const pendingBodyUpdateCallIds: number[] = [];
  const unsubscribe = pair.worker.subscribe((message) => {
    if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
    const { callId, call } = message;
    if (call.kind === "body/materialize") {
      const seed = new Y.Doc();
      const update = Y.encodeStateAsUpdate(seed);
      seed.destroy();
      pair.worker.post(
        {
          frame: "result",
          callId,
          result: {
            outcome: "ok",
            value: {
              // The "lanes" arm keys a body doc by the artifact id itself -
              // see this file's header.
              docKey: call.request.artifactId,
              update,
              docGuid: `guid-${call.request.artifactId}`,
              seedMode: "full",
              hostStateVector: null,
              awarenessFrames: [],
            },
          },
        },
        [],
      );
      return;
    }
    if (call.kind === "body/update") {
      pendingBodyUpdateCallIds.push(callId);
    }
  });
  return {
    pendingBodyUpdateCallIds,
    respondBodyUpdateError(name, message): void {
      const callId = pendingBodyUpdateCallIds.shift();
      if (callId === undefined) {
        throw new Error("no outstanding body/update call to answer");
      }
      pair.worker.post(
        {
          frame: "result",
          callId,
          result: { outcome: "error", name, message },
        },
        [],
      );
    },
    unsubscribe,
  };
}

/** One paragraph of text, inserted through the live fragment - a LOCAL edit. */
function typeInto(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [paragraph]);
}

describe("the local body/update refusal's .catch (open-epic store.ts)", () => {
  it("logs a non-disposal refusal once and never as an unhandled rejection; a disposed-bridge refusal is silent and also never unhandled", async () => {
    const capture = captureUnhandledRejections();
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
    const pair = createFakeBridgePair("sync");
    const worker = createWorkerSide(pair);
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));
    const binding: EpicRuntimeBinding = {
      port: main,
      command: () => {},
      awarenessOut: () => {},
      currentUser: () => {},
      detach: () => {},
      dispose: () => {},
    };
    const handle = createOpenEpicStore({
      epicId: EPIC_ID,
      userId: null,
      runtime: binding,
      accounting: createProcessBackedAccountingPort({
        hostId: "test-host",
        epicId: EPIC_ID,
        environment: createRendererRuntimeEnvironment(),
      }),
    });

    try {
      handle.projection.apply({ installedArm: "lanes" }, 1);

      const lease = handle.store
        .getState()
        .acquireResidentArtifactBodyLease(ARTIFACT_ID);
      await lease.resident;

      const fragment = handle.store.getState().getArtifactFragment(ARTIFACT_ID);
      if (fragment === null) {
        throw new Error("artifact body did not become resident");
      }

      // ── Arm 1: a genuine worker-side fault ─────────────────────────────
      typeInto(fragment, "typed");
      worker.respondBodyUpdateError("Error", "worker handler blew up");
      await drainRejections();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "[open-epic] body update refused by the runtime worker",
        { docKey: ARTIFACT_ID },
        expect.any(Error),
      );

      errorSpy.mockClear();

      // ── Arm 2 (CONTROL): the bridge disposed underneath the call ───────
      // Teardown, not a failure - the edit is already in main's live doc, so
      // this must NOT log. Without this half, an unconditional "always log"
      // would pass arm 1 and read identically to the fix.
      typeInto(fragment, "more");
      // A second, INDEPENDENT body/update call really is outstanding here -
      // this is not "nothing happened, so nothing was logged" wearing the
      // assertion below's clothes. Without this check, a stale fragment or a
      // replaced doc would leave every negative assertion in this arm
      // vacuously true.
      expect(worker.pendingBodyUpdateCallIds).toHaveLength(1);
      main.dispose();
      await drainRejections();

      expect(errorSpy).not.toHaveBeenCalled();
      // Neither rejection ever escaped as an unhandled one, in EITHER arm -
      // the actual defect this fix closes (a rethrow inside a `.catch` on a
      // `void`ed chain mints a fresh, unhandled rejection instead of
      // reaching the logger this test just pinned).
      expect(capture.seen).toEqual([]);
    } finally {
      capture.stop();
      errorSpy.mockRestore();
      worker.unsubscribe();
      handle.dispose();
    }
  });
});
