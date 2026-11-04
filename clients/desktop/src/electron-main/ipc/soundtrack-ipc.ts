import {
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../ipc-contracts/ipc-channels";
import type { SoundtrackSetReadResult } from "../../ipc-contracts/soundtrack-types";
import {
  createSoundtrackSource,
  type SoundtrackSourceOptions,
} from "../soundtrack/soundtrack-source";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

const UNAVAILABLE: SoundtrackSetReadResult = { kind: "unavailable" };

/**
 * The flag is read synchronously at preload, because the renderer decides at
 * render whether to draw the toggle. The read speaks for the account, so it
 * asks for a session whose bearer main verified (`auth-ipc.ts`), as the jar
 * plane does. Verification happens at the set, and there is nothing for a
 * renderer-supplied bearer to add here: no server sees this call.
 */
export function registerSoundtrackIpc(
  bridge: Pick<RunnerIpcBridge, "authSession" | "handleInvoke" | "handleSync">,
  options: SoundtrackSourceOptions,
): void {
  const source = createSoundtrackSource(options);
  bridge.handleSync(
    RunnerHostSync.soundtrackSourceAvailable,
    () => source !== null,
  );
  bridge.handleInvoke(RunnerHostInvoke.readSoundtrackSet, () =>
    source === null || !bridge.authSession.get().verified
      ? Promise.resolve(UNAVAILABLE)
      : source.read(),
  );
}
