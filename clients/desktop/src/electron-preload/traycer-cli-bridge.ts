import { ipcRenderer } from "electron";
import { RunnerHostInvoke } from "../ipc-contracts/ipc-channels";
import type {
  TraycerHostStatusSnapshot,
  TraycerDetectedShell,
  TraycerEnvOverride,
  TraycerShellConfig,
  TraycerShellConfigSetInput,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * Surface exposed under `runnerHost.traycerCli` in the preload bridge.
 * Each method maps to one `runnerHost:traycer:*` invoke channel handled by
 * `traycer-cli-ipc.ts` in main, which subprocess-invokes the `traycer` CLI.
 *
 * Kept browser-safe: no Electron types leak across `contextBridge`. The
 * renderer-side `DesktopRunnerHost` wraps this as `ITraycerCli`.
 */
export interface TraycerCliBridgeSurface {
  hostStatus(): Promise<TraycerHostStatusSnapshot>;
  shellConfigGet(): Promise<TraycerShellConfig>;
  shellConfigSet(input: TraycerShellConfigSetInput): Promise<void>;
  shellConfigReset(): Promise<void>;
  shellListDetected(): Promise<readonly TraycerDetectedShell[]>;
  envOverrideList(): Promise<readonly TraycerEnvOverride[]>;
  envOverrideSet(input: {
    readonly key: string;
    readonly value: string | null;
  }): Promise<void>;
  envOverrideDelete(input: { readonly key: string }): Promise<void>;
  cliLogin(input: {
    readonly token: string;
    readonly refreshToken: string;
  }): Promise<void>;
  cliLogout(): Promise<void>;
}

export function buildTraycerCliBridge(): TraycerCliBridgeSurface {
  return {
    hostStatus: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerHostStatus,
      ) as Promise<TraycerHostStatusSnapshot>,
    shellConfigGet: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigShellGet,
      ) as Promise<TraycerShellConfig>,
    shellConfigSet: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigShellSet,
        input,
      ) as Promise<void>,
    shellConfigReset: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigShellReset,
      ) as Promise<void>,
    shellListDetected: () =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerConfigShellList) as Promise<
        readonly TraycerDetectedShell[]
      >,
    envOverrideList: () =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerConfigEnvList) as Promise<
        readonly TraycerEnvOverride[]
      >,
    envOverrideSet: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigEnvSet,
        input,
      ) as Promise<void>,
    envOverrideDelete: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigEnvDelete,
        input,
      ) as Promise<void>,
    cliLogin: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerCliLogin,
        input,
      ) as Promise<void>,
    cliLogout: () =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerCliLogout) as Promise<void>,
  };
}
