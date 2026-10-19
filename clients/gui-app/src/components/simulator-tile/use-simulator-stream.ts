import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  createSimulatorStreamController,
  type SimulatorStreamController,
  type SimulatorStreamState,
} from "@/lib/simulator-view/simulator-stream-controller";
import {
  createAttachableFrameSink,
  type AttachableFrameSink,
} from "@/components/simulator-tile/simulator-frame-sink";

export interface SimulatorStreamHandle {
  readonly controller: SimulatorStreamController | null;
  readonly state: SimulatorStreamState;
  readonly sink: AttachableFrameSink;
}

const IDLE_STATE: SimulatorStreamState = {
  lifecycle: "idle",
  detail: null,
  terminal: false,
  config: null,
  plane: "canvas",
  frameSize: null,
  input: { connected: false, detail: null },
};

const noop = (): void => undefined;

/**
 * One controller per (client, epic, simulator), started while the tile body
 * is on screen and stopped while it is not: a concealed keep-alive body
 * decodes nothing and holds no stream, and reopens when it is shown again
 * (the host answers with a fresh config and keyframe). `client` is the tab
 * host's stream client; `null` while the host is not dialable yet.
 *
 * The controller is the external store its state is read from: building it
 * allocates and subscribes to nothing, so it can be memoised in render, and
 * `start` / `stop` - the side effects - run in effects.
 */
export function useSimulatorStream(args: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly epicId: string;
  readonly simulatorId: string;
  readonly platform: SimulatorPlatform;
  readonly visible: boolean;
}): SimulatorStreamHandle {
  const { client, epicId, simulatorId, platform, visible } = args;
  const sink = useMemo(() => createAttachableFrameSink(), []);
  const controller = useMemo(
    () =>
      client === null
        ? null
        : createSimulatorStreamController({
            epicId,
            simulatorId,
            platform,
            client,
            sink,
            preferMjpeg: false,
            decoderRuntime: null,
          }),
    [client, epicId, platform, simulatorId, sink],
  );

  useEffect(() => {
    if (controller === null) return;
    return () => controller.stop();
  }, [controller]);

  useEffect(() => {
    if (controller === null) return;
    if (visible) controller.start();
    else controller.stop();
  }, [controller, visible]);

  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? noop,
    [controller],
  );
  const getSnapshot = useCallback(
    () => controller?.getState() ?? IDLE_STATE,
    [controller],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { controller, state, sink };
}
