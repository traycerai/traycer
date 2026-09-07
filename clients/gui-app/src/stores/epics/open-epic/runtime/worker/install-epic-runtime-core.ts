/**
 * What the worker entry does once the bootstrap has landed: build the composition root and install
 * it.
 */
import type { EpicDocRecordArms } from "../../projection-helpers";
import { createBatchingDelivery } from "../projection-delivery";
import {
  readWriteCommandIntent,
  RelayedWriteCommandFailureError,
} from "../epic-write-command";
import {
  buildProxiedStreamFactories,
  createEpicRuntimeComposition,
  type EpicRuntimeStreamFactories,
} from "./epic-runtime-composition";
import { createEpicRuntimeWorkerCore } from "./epic-runtime-core";
import {
  buildEpicRuntimeCorePorts,
  type EpicRuntimeCorePortSource,
} from "./epic-runtime-core-ports";
import type { EpicRuntimeWorkerHost } from "./epic-runtime-worker-host";
import type { EpicReplicaRuntime } from "../epic-replica-runtime";

/** The doc arm to use before the first manifest push. */
const DOC_ARM_BEFORE_MANIFEST: EpicDocRecordArms = {
  chats: true,
  tuiAgents: true,
};

export function buildProxiedRuntimeFactories(
  host: EpicRuntimeWorkerHost,
): EpicRuntimeStreamFactories {
  return buildProxiedStreamFactories({
    streams: host.streams.client,
    support: (method) => {
      const manifest = host.streams.manifest();
      if (manifest === null) return "unknown";
      const entry = manifest.methodSupport.find(
        (candidate) => candidate.method === method,
      );
      // `unknown` for a method the manifest does not name, which is the same answer the relay's client
      // gives forever and which selection already treats as "not a selection".
      return entry === undefined ? "unknown" : entry.support;
    },
    subscribeSupport: (listener) => host.streams.subscribeManifest(listener),
    unaries: {
      getWorkspaceContext: async () => {
        const outcome = await host.main.call("main/lane-unary", {
          kind: "workspace-context",
        });
        // REJECT rather than answer an empty context.
        if (!outcome.ok) throw new Error(outcome.reason);
        if (outcome.kind !== "workspace-context") {
          throw new Error(
            `epic.getWorkspaceContext answered a ${outcome.kind} outcome`,
          );
        }
        return outcome.context;
      },
      retryMigration: async () => {
        const outcome = await host.main.call("main/lane-unary", {
          kind: "retry-migration",
        });
        if (!outcome.ok) throw new Error(outcome.reason);
      },
    },
  });
}

/** The runtime-to-port mapping the core ports are built over. */
export function epicRuntimeCorePortSourceOf(
  runtime: EpicReplicaRuntime,
): EpicRuntimeCorePortSource {
  return {
    hasAttachmentBytes: (hash) => runtime.hasAttachmentBytes(hash),
    readAttachmentBytes: (hash, signal) =>
      runtime.readAttachmentBytes(hash, signal),
    acquireBodyLease: (artifactId) =>
      runtime.acquireArtifactBodyLease(artifactId),
    bodyDocKey: (artifactId) => runtime.getArtifactBodyDocKey(artifactId),
    encodeColdState: (docKey) => runtime.encodeArtifactBodyColdState(docKey),
    encodeForwardOnly: (docKey) =>
      runtime.encodeArtifactBodyForwardOnly(docKey),
    observeBodyDoc: (docKey, onUpdate) =>
      runtime.observeArtifactBodyDoc(docKey, onUpdate),
    applyBodyAwareness: (docKey, frame, localClientId) => {
      runtime.sendArtifactBodyAwareness(docKey, frame, localClientId);
    },
    observeBodyAwareness: (docKey, onFrame) =>
      runtime.observeArtifactBodyAwareness(docKey, onFrame),
    isBodyPinned: (docKey) => runtime.isArtifactBodyPinned(docKey),
    encodeBodyPeerAwareness: (docKey) =>
      runtime.encodeArtifactBodyPeerAwareness(docKey),
    settleColdState: (docKey, update, expectedDocGuid) =>
      runtime.settleArtifactBodyColdState(docKey, update, expectedDocGuid),
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
    enqueueWriteCommand: (intent) =>
      runtime.enqueueWriteCommand(intent)?.commandId ?? null,
    readWriteCommandIntent: (intent) => readWriteCommandIntent(intent),
    applyChatRecords: (records, issuedAtSeq) =>
      runtime.applyChatRecords(records, issuedAtSeq),
    applyChatRecordDelta: (delta) => runtime.applyChatRecordDelta(delta),
    applyConfirmedChatMutation: (mutation) =>
      runtime.applyConfirmedChatMutation(mutation),
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
    retryWriteCommand: (commandId) => runtime.retryWriteCommand(commandId),
    discardWriteCommand: (commandId) => runtime.discardWriteCommand(commandId),
    encodeRootState: () => runtime.encodeRootState(),
    applyRootUpdate: (update, asLocalEdit) =>
      runtime.applyRootUpdate(update, asLocalEdit),
    detachTransport: () => {
      runtime.detachTransport();
    },
    dispose: () => {
      runtime.dispose();
    },
  };
}

/**
 * EXPLICIT, and this is the seam `epic-runtime-composition.ts` already documents: "The factories
 * are an option rather than something this module derives, and that is one seam with two users
 */
export function installEpicRuntimeCore(
  host: EpicRuntimeWorkerHost,
  buildFactories: (host: EpicRuntimeWorkerHost) => EpicRuntimeStreamFactories,
): () => EpicReplicaRuntime | null {
  let composed: EpicReplicaRuntime | null = null;
  host.onBootstrap((facts) => {
    const factories = buildFactories(host);

    const runtime = createEpicRuntimeComposition({
      epicId: facts.epicId,
      environment: host.environment,
      factories,
      delivery: createBatchingDelivery((patch) => {
        host.publishProjection(patch);
      }),
      getCurrentUserId: () => host.currentUserId(),
      getDocArm: () => readDocArm(host.streams.manifest()?.docArm),
      // No auth error route from here.
      onAuthError: null,
      commandIdFactory: { next: () => crypto.randomUUID() },
      writeCommandSender: {
        // The BOOTSTRAP's host id, which this session is bound to for life.
        currentHostId: () => facts.hostId,
        async send(commandId, intent) {
          const outcome = await host.main.call("main/write-command", {
            commandId,
            intent,
          });
          // Re-thrown as the classifier's own union, never as a reconstructed `Error`: an `Error` does not
          // survive structured clone, so main classifies and this side's `classifyFailure` unwraps.
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
        buildEpicRuntimeCorePorts(epicRuntimeCorePortSourceOf(runtime), {
          onDocUpdate: (docKey, update) => {
            // The return leg: a resident body's updates go to main's live
            // doc. No origin filter on this side - see `observeBodyDoc`.
            host.publishBodyDocUpdate(docKey, update);
          },
          onAwareness: (docKey, frame) => {
            // Presence's return leg. The filter that matters here already ran at the source
            // (`observeBodyAwareness` drops what main relayed in), so this is a straight forward.
            host.publishBodyAwareness(docKey, frame);
          },
        }),
      ),
    );

    composed = runtime;

    // Last, exactly as the store does it: the first projection must land after
    // everything that consumes it exists.
    runtime.start();
  });
  /** The composed runtime, or `null` before the bootstrap lands. Production ignores this. */
  return () => composed;
}

/**
 * The manifest's doc arm, narrowed. It crosses as `unknown` because the predicate's input is
 * main-thread state and the snapshot's shape belongs to `projection-helpers`.
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
