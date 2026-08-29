/**
 * The composition root, as it is built inside the worker.
 *
 * Two halves, deliberately separable:
 *
 *   - {@link buildProxiedStreamFactories} constructs the four typed stream
 *     wrappers over a proxied `IStreamClient`. This is the code that moved out
 *     of `epic-session-provider.tsx` - and moving it is the POINT, because the
 *     method-typed zod decode lives in those wrappers and it is the CPU this
 *     relocation exists to shift.
 *   - {@link createEpicRuntimeComposition} takes those factories as an
 *     EXPLICIT option and constructs the runtime.
 *
 * The factories are an option rather than something this module derives, and
 * that is one seam with two users rather than a testing convenience: the
 * production bootstrap passes the proxy-built ones, and a caller that supplies
 * its own stream (the provider's override seam, and `store.test.ts`'s fake)
 * passes those. Before this cut those callers took an in-process bypass; there
 * is no bypass now, so they reach the real host, the real core and this module
 * through an in-process worker instead. One path, exercised by everyone.
 *
 * What this module does NOT do is decide where its live reads come from. The
 * negotiated manifest and the signed-in user are main-thread facts, pushed in
 * and read here as plain functions - see `stream-proxy-protocol.ts` for why the
 * transport stays where it is, and the protocol header for why `current-user`
 * is its own event rather than a field on the manifest.
 */
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import { EpicStreamClient } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { EpicStateStreamClient } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import { EpicStatusStreamClient } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import { ArtifactStreamClient } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime/runtime-environment";
import type { EpicDocRecordArms } from "../../projection-helpers";
import type { CommandIdFactory } from "@traycer-clients/shared/replica-runtime/command-overlay";
import {
  createEpicReplicaRuntime,
  type EpicLaneSelectionSources,
  type EpicReplicaRuntime,
} from "../epic-replica-runtime";
import type { EpicStreamClientFactory } from "../legacy-epic-stream-adapter";
import type { EpicRuntimeDelivery } from "../projection-delivery";
import type { EpicWriteCommandSender } from "../epic-write-command";

/**
 * The four factories, as one value.
 *
 * `laneSelection` is nullable as a whole rather than as three members, matching
 * `EpicReplicaRuntimeOptions`: a support reader with no stream clients cannot
 * open anything, and stream clients with no support reader could never be
 * selected. `null` is a fact about the CALLER.
 */
export interface EpicRuntimeStreamFactories {
  readonly streamClientFactory: EpicStreamClientFactory;
  readonly laneSelection: EpicLaneSelectionSources | null;
}

export interface ProxiedStreamFactoryOptions {
  /** The proxy. Its frames cross the bridge; the socket never left main. */
  readonly streams: IStreamClient<HostStreamRpcRegistry>;
  /**
   * This connection's negotiated support, read from the pushed manifest.
   *
   * On main this is `wsStreamClient.getMethodSupport(method)` with a cast to
   * the registry's key type. Here it is a lookup in a replicated snapshot, so
   * there is no cast: an unknown method answers `"unknown"`, which is the same
   * answer the relay's `RemoteStreamClient` gives forever and which selection
   * already treats as "not a selection".
   */
  readonly support: (method: string) => "unknown" | "supported" | "unsupported";
  /** Fires when a manifest push lands. */
  readonly subscribeSupport: (listener: () => void) => () => void;
}

export function buildProxiedStreamFactories(
  options: ProxiedStreamFactoryOptions,
): EpicRuntimeStreamFactories {
  const streams = options.streams;
  return {
    streamClientFactory: (epicId, callbacks, seedOfferProvider) => {
      const client = new EpicStreamClient({
        wsStreamClient: streams,
        epicId,
        callbacks,
        seedOfferProvider,
      });
      return {
        applyUpdate: (updateBytes) => client.applyUpdate(updateBytes),
        awareness: (awarenessBytes) => client.awareness(awarenessBytes),
        applyArtifactRoomUpdate: (artifactRoomId, updateBytes) =>
          client.applyArtifactRoomUpdate(artifactRoomId, updateBytes),
        artifactRoomAwareness: (artifactRoomId, awarenessBytes) =>
          client.artifactRoomAwareness(artifactRoomId, awarenessBytes),
        retryMigration: () => client.retryMigration(),
        // CLIENT ONLY, exactly as on main. `requestFreshSnapshot` calls this
        // between discarding the replica and re-subscribing, so closing the
        // socket here would turn a local reseed into a reconnect - and over the
        // proxy it would close a real session main still owns.
        close: () => {
          client.close();
        },
      };
    },
    laneSelection: {
      support: options.support,
      subscribeSupport: options.subscribeSupport,
      stateStreamClientFactory: (epicId, callbacks, resumeProvider) =>
        new EpicStateStreamClient({
          wsStreamClient: streams,
          epicId,
          callbacks,
          resumeProvider,
        }),
      statusStreamClientFactory: (epicId, callbacks) =>
        new EpicStatusStreamClient({
          wsStreamClient: streams,
          epicId,
          callbacks,
        }),
      // One client per BODY, all on the same proxied client. `artifact.subscribe`
      // is a method on the session's one durable socket, so a canvas with twelve
      // open tiles multiplexes twelve subscriptions - it does not dial twelve
      // times, and over the proxy it does not open twelve proxy hosts either.
      artifactStreamClientFactory: (
        epicId,
        artifactId,
        authorityEpoch,
        callbacks,
        seedOfferProvider,
      ) =>
        new ArtifactStreamClient({
          wsStreamClient: streams,
          epicId,
          artifactId,
          authorityEpoch,
          callbacks,
          seedOfferProvider,
        }),
    },
  };
}

export interface EpicRuntimeCompositionOptions {
  readonly epicId: string;
  readonly hostId: string;
  readonly environment: RuntimeEnvironment;
  /** EXPLICIT, never derived here - see this module's header. */
  readonly factories: EpicRuntimeStreamFactories;
  readonly delivery: EpicRuntimeDelivery;
  /**
   * The signed-in user, read live from the pushed replica.
   *
   * Live and not captured: a session constructed before the auth profile
   * hydrates must pick the id up on its next projection rather than freezing
   * the absence, which is the same reason main reads it live today.
   */
  readonly getCurrentUserId: () => string | null;
  /**
   * The doc-arm verdict, read live from the pushed manifest.
   *
   * This was ruled worker-resident while the transport was moving, on the
   * grounds that pushing it would create two deciders. The transport stayed, so
   * the manifest stayed with it and there is exactly one decider - main's. The
   * predicate reads a snapshot rather than negotiating anything.
   */
  readonly getDocArm: () => EpicDocRecordArms;
  readonly onAuthError: (() => void) | null;
  readonly writeCommandSender: EpicWriteCommandSender;
  readonly commandIdFactory: CommandIdFactory;
}

export function createEpicRuntimeComposition(
  options: EpicRuntimeCompositionOptions,
): EpicReplicaRuntime {
  return createEpicReplicaRuntime({
    epicId: options.epicId,
    hostId: options.hostId,
    environment: options.environment,
    streamClientFactory: options.factories.streamClientFactory,
    delivery: options.delivery,
    getCurrentUserId: options.getCurrentUserId,
    getDocArm: options.getDocArm,
    onAuthError: options.onAuthError,
    commandIdFactory: options.commandIdFactory,
    writeCommandSender: options.writeCommandSender,
    laneSelection: options.factories.laneSelection,
  });
}
