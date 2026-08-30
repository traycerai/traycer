/**
 * What the worker entry does once the bootstrap has landed: build the
 * composition root and install it.
 *
 * Separate from `epic-runtime-worker-entry.ts` for the reason that module's
 * header gives - an entry runs on import and cannot be exercised by any suite
 * in this package - and separate from `epic-runtime-worker-host.ts` because
 * the host is the BRIDGE and this is the RUNTIME. The host answers frames with
 * or without a core; this is what gives it one.
 *
 * Every live read is a function, never a captured value. The manifest and the
 * signed-in user are main-thread facts that arrive as pushes, so a composition
 * that captured them at build time would freeze whatever happened to be true
 * during the handshake - which for a session constructed before the auth
 * profile hydrates is "nobody is signed in", forever.
 */
import type { EpicDocRecordArms } from "../../projection-helpers";
import { createBatchingDelivery } from "../projection-delivery";
import { RelayedWriteCommandFailureError } from "../epic-write-command";
import {
  buildProxiedStreamFactories,
  createEpicRuntimeComposition,
} from "./epic-runtime-composition";
import { createEpicRuntimeWorkerCore } from "./epic-runtime-core";
import { buildEpicRuntimeCorePorts } from "./epic-runtime-core-ports";
import type { EpicRuntimeWorkerHost } from "./epic-runtime-worker-host";

/**
 * The doc arm to use before the first manifest push.
 *
 * The DOC stays on, matching `readEpicDocRecordArms`' own unknown answer: a
 * host whose capabilities are not yet known must not have its records hidden,
 * because the failure of guessing wrong in this direction is an epic that
 * renders empty.
 */
const DOC_ARM_BEFORE_MANIFEST: EpicDocRecordArms = {
  chats: true,
  tuiAgents: true,
};

export function installEpicRuntimeCore(host: EpicRuntimeWorkerHost): void {
  host.onBootstrap((facts) => {
    const factories = buildProxiedStreamFactories({
      streams: host.streams.client,
      support: (method) => {
        const manifest = host.streams.manifest();
        if (manifest === null) return "unknown";
        const entry = manifest.methodSupport.find(
          (candidate) => candidate.method === method,
        );
        // `unknown` for a method the manifest does not name, which is the same
        // answer the relay's client gives forever and which selection already
        // treats as "not a selection". Not `unsupported`: that would be a
        // claim, and this is an absence.
        return entry === undefined ? "unknown" : entry.support;
      },
      subscribeSupport: (listener) => host.streams.subscribeManifest(listener),
    });

    const runtime = createEpicRuntimeComposition({
      epicId: facts.epicId,
      environment: host.environment,
      factories,
      delivery: createBatchingDelivery((patch) => {
        host.publishProjection(patch);
      }),
      getCurrentUserId: () => host.currentUserId(),
      getDocArm: () => readDocArm(host.streams.manifest()?.docArm),
      // No auth error route from here. `onAuthError` exists so a MAIN-side
      // surface can re-drive sign-in, and the worker has no such surface; a
      // callback that emitted a log line instead would look like handling.
      onAuthError: null,
      commandIdFactory: { next: () => crypto.randomUUID() },
      writeCommandSender: {
        // The worker does not know which host is active - 4e left host
        // identity on main. `null` is the honest answer, and the send below is
        // what actually fails or succeeds.
        currentHostId: () => null,
        async send(commandId, intent) {
          const outcome = await host.main.call("main/write-command", {
            commandId,
            intent,
          });
          // Re-thrown as the classifier's own union, never as a reconstructed
          // `Error`: an `Error` does not survive structured clone, so main
          // classifies and this side's `classifyFailure` unwraps.
          if (!outcome.ok) {
            throw new RelayedWriteCommandFailureError(outcome.failure);
          }
          return { hostId: outcome.hostId };
        },
      },
      accounting: host.accounting,
    });

    host.installCore(
      createEpicRuntimeWorkerCore(
        buildEpicRuntimeCorePorts({
          hasAttachmentBytes: (hash) => runtime.hasAttachmentBytes(hash),
          readAttachmentBytes: (hash, signal) =>
            runtime.readAttachmentBytes(hash, signal),
          acquireBodyLease: (artifactId) =>
            runtime.acquireArtifactBodyLease(artifactId),
          bodyDocKey: (artifactId) => runtime.getArtifactBodyDocKey(artifactId),
          encodeColdState: (docKey) =>
            runtime.encodeArtifactBodyColdState(docKey),
          settleColdState: (docKey, update, expectedDocGuid) =>
            runtime.settleArtifactBodyColdState(
              docKey,
              update,
              expectedDocGuid,
            ),
          sendBodyUpdate: (docKey, update) =>
            runtime.sendArtifactBodyUpdate(docKey, update),
          renameArtifact: (artifactId, nextTitle) =>
            runtime.renameArtifact(artifactId, nextTitle),
          deleteArtifact: (artifactId) => runtime.deleteArtifact(artifactId),
          reparentArtifact: (artifactId, newParentId) =>
            runtime.reparentArtifact(artifactId, newParentId),
          beginRenameMutation: (nodeId, nextTitle) =>
            runtime.beginRenameMutation(nodeId, nextTitle),
          beginEpicTitleMutation: (nextTitle) =>
            runtime.beginEpicTitleMutation(nextTitle),
          beginReparentMutation: (nodeId, newParentId) =>
            runtime.beginReparentMutation(nodeId, newParentId),
          retirePendingMutation: (requestId, outcome) =>
            runtime.retirePendingMutation(requestId, outcome),
          isLatestRenameStamp: (nodeId, requestId) =>
            runtime.isLatestRenameStamp(nodeId, requestId),
          applyChatRecords: (records, issuedAtSeq) =>
            runtime.applyChatRecords(records, issuedAtSeq),
          applyChatRecordDelta: (delta) => runtime.applyChatRecordDelta(delta),
          applyTuiAgentRecords: (records, issuedAtSeq) =>
            runtime.applyTuiAgentRecords(records, issuedAtSeq),
          applyTuiAgentRecordDelta: (delta) =>
            runtime.applyTuiAgentRecordDelta(delta),
          markChatRecordListAuthoritative: () =>
            runtime.markChatRecordListAuthoritative(),
          markChatRecordListNotAuthoritative: () =>
            runtime.markChatRecordListNotAuthoritative(),
          beginPendingChatCreation: (pending) =>
            runtime.beginPendingChatCreation(pending),
          clearPendingChatCreation: (chatId) =>
            runtime.clearPendingChatCreation(chatId),
          republishRecordsForCurrentUser: () =>
            runtime.republishRecordsForCurrentUser(),
          reprojectForViewerChange: () => runtime.reprojectForViewerChange(),
          discardUnsyncedEdits: () => runtime.discardUnsyncedEdits(),
          requestFreshSnapshot: () => runtime.requestFreshSnapshot(),
          retryMigration: () => runtime.retryMigration(),
          retryWriteCommand: (commandId) =>
            runtime.retryWriteCommand(commandId),
          discardWriteCommand: (commandId) =>
            runtime.discardWriteCommand(commandId),
          detachTransport: () => {
            runtime.detachTransport();
          },
          dispose: () => {
            runtime.dispose();
          },
        }),
      ),
    );

    // Last, exactly as the store does it: the first projection must land after
    // everything that consumes it exists.
    runtime.start();
  });
}

/**
 * The manifest's doc arm, narrowed.
 *
 * It crosses as `unknown` because the predicate's input is main-thread state
 * and the snapshot's shape belongs to `projection-helpers`. Built as a literal
 * so a field added to {@link EpicDocRecordArms} fails to compile here.
 */
function readDocArm(value: unknown): EpicDocRecordArms {
  if (typeof value !== "object" || value === null) {
    return DOC_ARM_BEFORE_MANIFEST;
  }
  return {
    chats: readArm(value, "chats"),
    tuiAgents: readArm(value, "tuiAgents"),
  };
}

function readArm(value: object, key: string): boolean {
  const read: unknown = Reflect.get(value, key);
  // Anything that is not an explicit `false` keeps the doc on, for the same
  // reason the pre-manifest default does.
  return read !== false;
}
