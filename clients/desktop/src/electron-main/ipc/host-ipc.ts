import { randomUUID } from "node:crypto";
import { respawnHost } from "../app/host-respawn";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import { runTrackedHostOperation } from "./host-management-ipc";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerHostIpc(bridge: RunnerIpcBridge): void {
  // Renderer-driven host respawn.
  //
  // `respawnHost` (in `app/host-respawn.ts`) is the single shared
  // entrypoint used by every respawn surface - this IPC handler, the
  // tray's "Restart Host", and any menu-bar host command. It owns
  // both the in-flight dedupe (so concurrent Retry clicks can't interleave
  // SMAppService unregister/register cycles) and the routing between the
  // SMAppService cycle (macOS host-owned login item) and the CLI restart path.
  // The outer process-wide tracker coordinates this entrypoint with Settings,
  // tray, and Doctor restart-class operations and publishes the same status to
  // every renderer window.
  bridge.handleInvoke(RunnerHostInvoke.requestHostRespawn, async () => {
    await runTrackedHostOperation(bridge, "restart", randomUUID(), async () =>
      respawnHost(bridge.options.host),
    );
  });

  const onHostChange = (snapshot: DesktopLocalHostSnapshot | null): void => {
    bridge.fanOut(RunnerHostEvent.localHostChange, snapshot);
  };
  bridge.options.host.on("change", onHostChange);
  bridge.disposeFns.push(() => {
    bridge.options.host.off("change", onHostChange);
  });

  bridge.fanOut(
    RunnerHostEvent.localHostChange,
    bridge.options.host.getSnapshot(),
  );
}
