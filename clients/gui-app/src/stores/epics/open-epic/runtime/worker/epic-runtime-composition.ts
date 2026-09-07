/** The composition root, as it is built inside the worker. Two halves, deliberately separable: */
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
  type EpicLaneUnaries,
  type EpicReplicaRuntime,
} from "../epic-replica-runtime";
import type { EpicStreamClientFactory } from "../legacy-epic-stream-adapter";
import type { EpicRuntimeDelivery } from "../projection-delivery";
import type { EpicWriteCommandSender } from "../epic-write-command";
import type { EpicRuntimeAccountingPort } from "../epic-runtime-accounting-port";

/** The four factories, as one value. */
export interface EpicRuntimeStreamFactories {
  readonly streamClientFactory: EpicStreamClientFactory;
  readonly laneSelection: EpicLaneSelectionSources | null;
}

export interface ProxiedStreamFactoryOptions {
  /** The proxy. Its frames cross the bridge; the socket never left main. */
  readonly streams: IStreamClient<HostStreamRpcRegistry>;
  /**
   * This connection's negotiated support, read from the pushed manifest. On main this is
   * `wsStreamClient.getMethodSupport(method)` with a cast to the registry's key type.
   */
  readonly support: (method: string) => "unknown" | "supported" | "unsupported";
  /** Fires when a manifest push lands. */
  readonly subscribeSupport: (listener: () => void) => () => void;
  /** The two lane unaries, already crossing the bridge. */
  readonly unaries: EpicLaneUnaries;
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
        // CLIENT ONLY, exactly as on main.
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
      // One client per BODY, all on the same proxied client.
      artifactStreamClientFactory: ({
        epicId,
        artifactId,
        authorityEpoch,
        callbacks,
        seedOfferProvider,
      }) =>
        new ArtifactStreamClient({
          wsStreamClient: streams,
          epicId,
          artifactId,
          authorityEpoch,
          callbacks,
          seedOfferProvider,
        }),
      unaries: options.unaries,
    },
  };
}

export interface EpicRuntimeCompositionOptions {
  readonly epicId: string;
  /** No `hostId`, matching `EpicReplicaRuntimeOptions`. */
  readonly environment: RuntimeEnvironment;
  /** EXPLICIT, never derived here - see this module's header. */
  readonly factories: EpicRuntimeStreamFactories;
  readonly delivery: EpicRuntimeDelivery;
  /** The signed-in user, read live from the pushed replica. */
  readonly getCurrentUserId: () => string | null;
  /**
   * The doc-arm verdict, read live from the pushed manifest. This was ruled worker-resident while
   * the transport was moving, on the grounds that pushing it would create two deciders.
   */
  readonly getDocArm: () => EpicDocRecordArms;
  readonly onAuthError: (() => void) | null;
  readonly writeCommandSender: EpicWriteCommandSender;
  readonly commandIdFactory: CommandIdFactory;
  /** Where the composed runtime reports its bytes. */
  readonly accounting: EpicRuntimeAccountingPort;
}

export function createEpicRuntimeComposition(
  options: EpicRuntimeCompositionOptions,
): EpicReplicaRuntime {
  return createEpicReplicaRuntime({
    epicId: options.epicId,
    environment: options.environment,
    streamClientFactory: options.factories.streamClientFactory,
    delivery: options.delivery,
    accounting: options.accounting,
    getCurrentUserId: options.getCurrentUserId,
    getDocArm: options.getDocArm,
    onAuthError: options.onAuthError,
    commandIdFactory: options.commandIdFactory,
    writeCommandSender: options.writeCommandSender,
    laneSelection: options.factories.laneSelection,
  });
}
