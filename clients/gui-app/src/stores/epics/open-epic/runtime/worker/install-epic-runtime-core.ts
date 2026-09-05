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

/**
 * Builds the four typed stream clients over the worker's proxied client.
 *
 * Production's builder, named so it can be PASSED rather than assumed - see
 * {@link installEpicRuntimeCore}'s second parameter.
 */
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
      // `unknown` for a method the manifest does not name, which is the same
      // answer the relay's client gives forever and which selection already
      // treats as "not a selection". Not `unsupported`: that would be a
      // claim, and this is an absence.
      return entry === undefined ? "unknown" : entry.support;
    },
    subscribeSupport: (listener) => host.streams.subscribeManifest(listener),
    unaries: {
      getWorkspaceContext: async () => {
        const outcome = await host.main.call("main/lane-unary", {
          kind: "workspace-context",
        });
        // REJECT rather than answer an empty context. The refresh policy
        // distinguishes a failed read from a delivered one - it retries the
        // first on its next trigger and projects the second into
        // `snapshotMeta` - and a synthesised empty payload would be projected
        // as authoritative, wiping a context an earlier read had established.
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

/**
 * The runtime-to-port mapping the core ports are built over.
 *
 * EXPORTED rather than left inline, and not for reuse's own sake: the accounting
 * equality pin drives the SAME ports twice, once in-process and once across the
 * bridge, and the only variable it is allowed to have is the bridge. A mapping
 * hand-written in that suite would be a second implementation of this one, so a
 * defect here (a call wired to the wrong runtime method) would sit on one side
 * of the comparison only - and the pin would read green while comparing
 * production's mapping against the test's own.
 *
 * Every entry is a call-through, never a captured value, for the same reason the
 * module header gives: the runtime's answers change over a session's life.
 */
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
 * @param buildFactories How to construct the four typed stream clients.
 *
 * EXPLICIT, and this is the seam `epic-runtime-composition.ts` already
 * documents: "The factories are an option rather than something this module
 * derives, and that is one seam with two users rather than a testing
 * convenience: the production bootstrap passes the proxy-built ones, and a
 * caller that supplies its own stream (the provider's override seam, and
 * `store.test.ts`'s fake) passes those." The composition took them all along;
 * this root simply did not pass through what its callee already accepted.
 *
 * A PARAMETER rather than a module-scoped override slot, deliberately: this
 * module is on the worker entry's value graph, where a module-scoped `let` is
 * process state and the graph ratchet says so - correctly, since it cannot
 * know the slot is only written by a test.
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
      // No auth error route from here. `onAuthError` exists so a MAIN-side
      // surface can re-drive sign-in, and the worker has no such surface; a
      // callback that emitted a log line instead would look like handling.
      onAuthError: null,
      commandIdFactory: { next: () => crypto.randomUUID() },
      writeCommandSender: {
        // The BOOTSTRAP's host id, which this session is bound to for life.
        //
        // This returned `null` unconditionally, under the comment "`null` is
        // the honest answer, and the send below is what actually fails or
        // succeeds." The second half was false, and it is the whole defect:
        // `epic-replica-runtime.ts`'s send gate reads this value and throws
        // `EpicWriteCommandTransportUnavailableError` when it is null BEFORE
        // reaching `send`, so "the send below" was unreachable and every write
        // command a worker-hosted runtime enqueued - rename, delete, reparent,
        // epic title - sat in `queued` forever.
        //
        // Worth naming as a shape rather than a one-off: the comment reasoned
        // correctly about its OWN module (the worker genuinely did not know the
        // host) and was wrong about the consequence, because the code that
        // decides lives one layer up. A claim about what happens NEXT cannot be
        // verified from inside the module that makes it.
        currentHostId: () => facts.hostId,
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
        buildEpicRuntimeCorePorts(epicRuntimeCorePortSourceOf(runtime), {
          onDocUpdate: (docKey, update) => {
            // The return leg: a resident body's updates go to main's live
            // doc. No origin filter on this side - see `observeBodyDoc`.
            host.publishBodyDocUpdate(docKey, update);
          },
          onAwareness: (docKey, frame) => {
            // Presence's return leg. The filter that matters here already
            // ran at the source (`observeBodyAwareness` drops what main
            // relayed in), so this is a straight forward.
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
  /**
   * The composed runtime, or `null` before the bootstrap lands.
   *
   * Production ignores this. It exists for the ONE in-process harness
   * (`openStoreForTest`), which constructed this host and this composition and
   * so may look inside them - a suite reaching a doc it built itself is not
   * the same as production reaching across a thread boundary.
   */
  return () => composed;
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
