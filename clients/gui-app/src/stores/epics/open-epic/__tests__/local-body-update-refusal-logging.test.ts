/**
 * The refusal settlement on `onLocalDocUpdate`'s `body/update` call
 * (`store.ts`, `createMainThreadBodyDocStore({ onLocalDocUpdate: ... })`).
 *
 * That callback fires on every LOCAL Yjs edit to a resident artifact body and
 * posts it as `void runtime.port.call("body/update", ...)`. A dropped answer or
 * rejected call is not a failed user action, but it is observable state: the
 * main-thread doc is still the only proven holder and must keep `isDirty`
 * latched until that doc retires. The test also keeps the original
 * unhandled-rejection pin: rethrowing from a `.catch` on a `void`ed chain mints
 * a new rejection nobody awaits. It fires once per keystroke, so one broken
 * worker handler used to produce one unhandled rejection per edit for as long
 * as the person kept typing. The fix logs via `appLogger.error` instead of
 * rethrowing, and leaves the `BridgeDisposedError` early-return (teardown, not
 * a fault) unchanged.
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
 * so it can choose per-call how the worker answers - the dropped, rejected,
 * and bridge-disposed arms this file pins.
 */
function createWorkerSide(pair: FakeBridgePair): {
  readonly pendingBodyUpdateCallIds: number[];
  respondBodyUpdateDropped(reason: string): void;
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
    respondBodyUpdateDropped(reason): void {
      const callId = pendingBodyUpdateCallIds.shift();
      if (callId === undefined) {
        throw new Error("no outstanding body/update call to answer");
      }
      pair.worker.post(
        {
          frame: "result",
          callId,
          result: {
            outcome: "ok",
            value: { outcome: { kind: "dropped", reason } },
          },
        },
        [],
      );
    },
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

describe("local body/update refusal settlement (open-epic store.ts)", () => {
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
      hostId: "test-host",
      // Unreached: this suite never calls `retryTransport`. Answered anyway
      // rather than defaulted, so it stays a decision the option forces.
      onRetryTransport: () => {},
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
        .acquireResidentArtifactBodyLease(ARTIFACT_ID, "linger");
      await lease.resident;

      const fragment = handle.store.getState().getArtifactFragment(ARTIFACT_ID);
      if (fragment === null) {
        throw new Error("artifact body did not become resident");
      }

      // ── Arm 1: a worker-side dropped answer ────────────────────────────
      typeInto(fragment, "typed");
      worker.respondBodyUpdateDropped("worker holds no replica");
      await drainRejections();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "[open-epic] body update refused by the runtime worker",
        { docKey: ARTIFACT_ID },
        expect.any(Error),
      );
      typeInto(fragment, "fault");
      worker.respondBodyUpdateError("Error", "worker handler blew up");
      await drainRejections();

      // ── Arm 2: a rejected worker-side answer ───────────────────────────
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        "[open-epic] body update refused by the runtime worker",
        { docKey: ARTIFACT_ID },
        expect.any(Error),
      );
      // The edit remains visible in main's live doc, but the refusal is now
      // observable as a recovery obligation rather than only as a log.
      expect(handle.store.getState().isDirty).toBe(true);

      // A later worker projection cannot erase the main-only refusal while the
      // doc still exists. This is the class pin: projected `false` is only the
      // worker's verdict, not proof that main's bytes crossed the bridge.
      handle.projection.apply(
        {
          artifactRooms: {
            stateByArtifactId: { [ARTIFACT_ID]: "ready" },
          },
          isDirty: false,
        },
        2,
      );
      expect(handle.store.getState().isDirty).toBe(true);

      errorSpy.mockClear();

      // ── Arm 3 (CONTROL): the bridge disposed underneath the call ───────
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

      // Retirement is the proof-based clearing point. `handle.dispose()` drops
      // the main body docs and invokes the sink's `onDocRetired`; because the
      // worker verdict above was false, the latch can now restore false.
      handle.dispose();
      expect(handle.store.getState().isDirty).toBe(false);
    } finally {
      capture.stop();
      errorSpy.mockRestore();
      worker.unsubscribe();
      handle.dispose();
    }
  });

  it.each(["dropped", "error"] as const)(
    "does not let a delayed %s refusal dirty a replacement resident body",
    async (settlement) => {
      const pair = createFakeBridgePair("sync");
      const worker = createWorkerSide(pair);
      const main = createMainBridgeEndpoint(
        pair.main,
        stubMainCallHandlers({}),
      );
      const binding: EpicRuntimeBinding = {
        port: main,
        command: () => {},
        awarenessOut: () => {},
        currentUser: () => {},
        detach: () => {},
        dispose: () => {},
      };
      const handle = createOpenEpicStore({
        epicId: `${EPIC_ID}-lineage-${settlement}`,
        userId: null,
        hostId: "test-host",
        onRetryTransport: () => {},
        runtime: binding,
        accounting: createProcessBackedAccountingPort({
          hostId: "test-host",
          epicId: `${EPIC_ID}-lineage-${settlement}`,
          environment: createRendererRuntimeEnvironment(),
        }),
      });

      let revision = 1;
      const replaceResident = async (
        previousDoc: Y.Doc,
      ): Promise<{
        readonly fragment: Y.XmlFragment;
        readonly doc: Y.Doc;
      }> => {
        handle.projection.apply(
          {
            artifactRooms: {
              stateByArtifactId: { [ARTIFACT_ID]: "unavailable" },
            },
          },
          ++revision,
        );
        expect(handle.hotArtifactRoomIdsForTests()).toEqual([]);

        handle.projection.apply(
          {
            artifactRooms: {
              stateByArtifactId: { [ARTIFACT_ID]: "ready" },
            },
          },
          ++revision,
        );
        const lease = handle.store
          .getState()
          .acquireResidentArtifactBodyLease(ARTIFACT_ID, "linger");
        await lease.resident;

        const replacement = handle.store
          .getState()
          .getArtifactFragment(ARTIFACT_ID);
        if (replacement === null) {
          throw new Error("replacement artifact body did not become resident");
        }
        const replacementDoc = replacement.doc;
        if (replacementDoc === null) {
          throw new Error("replacement artifact body did not expose its doc");
        }
        expect(replacementDoc).not.toBe(previousDoc);
        expect(handle.hotArtifactRoomIdsForTests()).toEqual([ARTIFACT_ID]);
        return { fragment: replacement, doc: replacementDoc };
      };

      try {
        handle.projection.apply({ installedArm: "lanes" }, revision);
        const initialLease = handle.store
          .getState()
          .acquireResidentArtifactBodyLease(ARTIFACT_ID, "linger");
        await initialLease.resident;
        const initialFragment = handle.store
          .getState()
          .getArtifactFragment(ARTIFACT_ID);
        if (initialFragment === null || initialFragment.doc === null) {
          throw new Error("initial artifact body did not become resident");
        }

        typeInto(initialFragment, `${settlement} predecessor`);
        expect(worker.pendingBodyUpdateCallIds).toHaveLength(1);
        const replacement = await replaceResident(initialFragment.doc);
        expect(handle.store.getState().isDirty).toBe(false);
        expect(worker.pendingBodyUpdateCallIds).toHaveLength(1);

        if (settlement === "dropped") {
          worker.respondBodyUpdateDropped("predecessor retired");
        } else {
          worker.respondBodyUpdateError("Error", "late worker failure");
        }
        await drainRejections();

        // The distinct replacement was resident before settlement, so this is
        // not a vacuous "nothing remained to dirty" assertion. Ablation:
        // without the dispatched-generation fence, each parameterized case
        // independently latches the replacement's same docKey dirty.
        expect(replacement.fragment.doc).toBe(replacement.doc);
        expect(handle.store.getState().isDirty).toBe(false);
      } finally {
        worker.unsubscribe();
        handle.dispose();
      }
    },
  );
});
