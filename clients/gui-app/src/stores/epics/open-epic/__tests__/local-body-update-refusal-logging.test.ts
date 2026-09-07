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
 * A hand-written worker side over the fake pair: answers `body/materialize` immediately (granted,
 * empty doc), and hands `body/update` calls to the test so it can choose per-call how the worker
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

      // A later worker projection cannot erase the main-only refusal while the doc still exists.
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

      // ── Arm 3 (CONTROL): the bridge disposed underneath the call ─────── Teardown, not a failure -
      // the edit is already in main's live doc, so this must NOT log.
      typeInto(fragment, "more");
      // A second, INDEPENDENT body/update call really is outstanding here - this is not "nothing
      // happened, so nothing was logged" wearing the assertion below's clothes.
      expect(worker.pendingBodyUpdateCallIds).toHaveLength(1);
      main.dispose();
      await drainRejections();

      expect(errorSpy).not.toHaveBeenCalled();
      // Neither rejection ever escaped as an unhandled one, in EITHER arm - the actual defect this fix
      // closes (a rethrow inside a `.catch` on a `void`ed chain mints a fresh, unhandled rejection
      expect(capture.seen).toEqual([]);

      // Retirement is the proof-based clearing point.
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

        // The distinct replacement was resident before settlement, so this is not a vacuous "nothing
        // remained to dirty" assertion.
        expect(replacement.fragment.doc).toBe(replacement.doc);
        expect(handle.store.getState().isDirty).toBe(false);
      } finally {
        worker.unsubscribe();
        handle.dispose();
      }
    },
  );

  it("latches isDirty the instant a body edit posts, before the worker answers either way", async () => {
    // Codex, #1694: the cap's data-loss gate reads `isDirty` synchronously on every prune walk, but
    // until this fix `onLocalDocUpdate` only latched it on a PROVEN refusal - the window between
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
      epicId: `${EPIC_ID}-in-flight`,
      userId: null,
      hostId: "test-host",
      onRetryTransport: () => {},
      runtime: binding,
      accounting: createProcessBackedAccountingPort({
        hostId: "test-host",
        epicId: `${EPIC_ID}-in-flight`,
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
      expect(handle.store.getState().isDirty).toBe(false);

      typeInto(fragment, "in flight");
      // The call is genuinely outstanding, not "nothing happened" wearing the
      // assertion below's clothes - the worker has not been told to answer it.
      expect(worker.pendingBodyUpdateCallIds).toHaveLength(1);
      // SYNCHRONOUS: no await, no drain. This is the exact tick a prune walk
      // would read if it ran right now.
      expect(handle.store.getState().isDirty).toBe(true);

      handle.projection.apply(
        {
          artifactRooms: { stateByArtifactId: { [ARTIFACT_ID]: "ready" } },
          isDirty: false,
        },
        2,
      );
      expect(handle.store.getState().isDirty).toBe(true);

      // Settling it - here, as a drop - releases the pending latch; the refusal arms above already pin
      // what happens to `isDirty` from there.
      worker.respondBodyUpdateDropped("closing the in-flight window");
      await drainRejections();
      expect(handle.store.getState().isDirty).toBe(true);
    } finally {
      worker.unsubscribe();
      handle.dispose();
    }
  });
});
