import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerHostIpc(bridge: RunnerIpcBridge): void {
  // Renderer-driven host respawn.
  //
  // `HostController.respawn()` is the single shared entrypoint used by
  // every respawn surface - this IPC handler, the tray's "Restart Host",
  // and any menu-bar host command. Its mutation lane owns both the
  // in-flight dedupe (so concurrent Retry clicks can't interleave
  // SMAppService unregister/register cycles) and the routing between the
  // SMAppService cycle (macOS host-owned login item) and the CLI restart
  // path. `HostController` never rejects (wait-never-reject); this handler
  // re-throws a non-"ok" outcome so the renderer's existing catch-based
  // error handling for this invoke keeps working unchanged.
  bridge.handleInvoke(RunnerHostInvoke.requestHostRespawn, async () => {
    const outcome = await bridge.options.hostController.respawn();
    if (outcome.kind !== "ok") {
      throw new Error(outcome.message);
    }
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
