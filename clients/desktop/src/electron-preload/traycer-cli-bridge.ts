import { ipcRenderer } from "electron";
import { RunnerHostInvoke } from "../ipc-contracts/ipc-channels";
import type {
  TraycerDetectedShell,
  TraycerEnvOverride,
  TraycerHostStatusSnapshot,
  TraycerModelGroup,
  TraycerOrchestration,
  TraycerOrchestrationPrelude,
  TraycerOrchestrationRole,
  TraycerRoleModelInfo,
  TraycerShellConfig,
  TraycerShellConfigSetInput,
  TraycerShellProbeResult,
} from "../ipc-contracts/traycer-cli-types";

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
  shellConfigAdd(input: { readonly path: string }): Promise<void>;
  shellConfigRemove(input: { readonly path: string }): Promise<void>;
  shellRevertArgs(input: { readonly path: string }): Promise<void>;
  shellProbe(input: {
    readonly path: string;
  }): Promise<TraycerShellProbeResult>;
  pickShellProgramFile(): Promise<string | null>;
  shellListDetected(): Promise<readonly TraycerDetectedShell[]>;
  envOverrideList(): Promise<readonly TraycerEnvOverride[]>;
  envOverrideSet(input: {
    readonly key: string;
    readonly value: string | null;
  }): Promise<void>;
  envOverrideDelete(input: { readonly key: string }): Promise<void>;

  // ─── Orchestrations ─────────────────────────────────────────────────────
  orchestrationList(): Promise<readonly string[]>;
  orchestrationShow(input: {
    readonly name: string;
  }): Promise<TraycerOrchestration | null>;
  orchestrationRoles(input: {
    readonly name: string;
  }): Promise<readonly TraycerOrchestrationRole[]>;
  orchestrationModels(input: {
    readonly name: string;
    readonly roleId: string;
    readonly group: string | undefined;
  }): Promise<TraycerRoleModelInfo | null>;
  orchestrationResponsibility(input: {
    readonly name: string;
    readonly roleId: string;
  }): Promise<string | null>;
  orchestrationGroups(): Promise<readonly string[]>;
  orchestrationCreate(input: {
    readonly name: string;
    readonly description: string | undefined;
    readonly from: string | undefined;
  }): Promise<TraycerOrchestration | null>;
  orchestrationDelete(input: { readonly name: string }): Promise<boolean>;
  orchestrationGroupShow(input: {
    readonly name: string;
  }): Promise<TraycerModelGroup | null>;
  orchestrationGroupSave(input: {
    readonly name: string;
    readonly group: TraycerModelGroup;
  }): Promise<boolean>;
  orchestrationGroupDelete(input: { readonly name: string }): Promise<boolean>;
  orchestrationPrelude(input: {
    readonly name: string;
    readonly roleId: string;
    readonly group: string | undefined;
  }): Promise<TraycerOrchestrationPrelude | null>;
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
    shellConfigAdd: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigShellAdd,
        input,
      ) as Promise<void>,
    shellConfigRemove: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigShellRemove,
        input,
      ) as Promise<void>,
    shellRevertArgs: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigShellRevertArgs,
        input,
      ) as Promise<void>,
    shellProbe: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigShellProbe,
        input,
      ) as Promise<TraycerShellProbeResult>,
    pickShellProgramFile: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerConfigShellPickProgramFile,
      ) as Promise<string | null>,
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

    // ─── Orchestrations ─────────────────────────────────────────────────
    orchestrationList: () =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerOrchestrationList) as Promise<
        readonly string[]
      >,
    orchestrationShow: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationShow,
        input,
      ) as Promise<TraycerOrchestration | null>,
    orchestrationRoles: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationRoles,
        input,
      ) as Promise<readonly TraycerOrchestrationRole[]>,
    orchestrationModels: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationModels,
        input,
      ) as Promise<TraycerRoleModelInfo | null>,
    orchestrationResponsibility: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationResponsibility,
        input,
      ) as Promise<string | null>,
    orchestrationGroups: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationGroups,
      ) as Promise<readonly string[]>,
    orchestrationCreate: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationCreate,
        input,
      ) as Promise<TraycerOrchestration | null>,
    orchestrationDelete: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationDelete,
        input,
      ) as Promise<boolean>,
    orchestrationGroupShow: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationGroupShow,
        input,
      ) as Promise<TraycerModelGroup | null>,
    orchestrationGroupSave: (input) =>
      ipcRenderer.invoke(RunnerHostInvoke.traycerOrchestrationGroupSave, {
        name: input.name,
        group: JSON.stringify(input.group),
      }) as Promise<boolean>,
    orchestrationGroupDelete: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationGroupDelete,
        input,
      ) as Promise<boolean>,
    orchestrationPrelude: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.traycerOrchestrationPrelude,
        input,
      ) as Promise<TraycerOrchestrationPrelude | null>,
  };
}
