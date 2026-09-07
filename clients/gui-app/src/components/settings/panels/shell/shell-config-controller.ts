import type { QueryKey } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ConfigDetectedShell,
  ConfigEnvEntry,
  ConfigShellProbeResponse,
  ConfigShellSetRequest,
} from "@traycer/protocol/host/config/index";

/** Structurally `ConfigShellGetResponse` with `args` widened to `readonly` - the wire type's array is mutable
 * and the bridge's is not, and the panel only ever reads it. */
export interface ShellConfigSnapshot {
  readonly path: string;
  readonly args: readonly string[];
  readonly synthesised: boolean;
}

/** Local CLI bridge - reachable only when the selected host is this computer and its process cannot answer:
 * stopped, or a version predating these methods (`localConfigFallbackReason`). */
export interface ShellCommandCallbacks {
  readonly onSuccess: () => void;
  readonly onError: () => void;
}

export interface ShellConfigController {
  /** `undefined` while the effective shell is still loading. */
  readonly config: ShellConfigSnapshot | undefined;
  /** Without it a rejected `config.shell.get` is indistinguishable from loading, and the panel skeletons forever. */
  readonly configError: HostRpcError | null;
  readonly retryConfig: () => void;
  readonly shells: readonly ConfigDetectedShell[];
  /** Freshness is otherwise per-panel-visit (`refetchOnMount: "always"`), and deliberately not focus-driven. */
  readonly refreshShells: () => void;
  readonly shellsRefreshing: boolean;
  readonly overrides: readonly ConfigEnvEntry[];
  readonly shellPending: boolean;
  readonly envPending: boolean;
  readonly probeSource: ShellProbeSource;
  readonly setShell: (
    request: ConfigShellSetRequest,
    callbacks: ShellCommandCallbacks,
  ) => void;
  readonly resetShell: (callbacks: ShellCommandCallbacks) => void;
  readonly addShell: (path: string, callbacks: ShellCommandCallbacks) => void;
  readonly removeShell: (
    path: string,
    callbacks: ShellCommandCallbacks,
  ) => void;
  readonly revertShellArgs: (
    path: string,
    callbacks: ShellCommandCallbacks,
  ) => void;
  readonly setEnv: (
    entry: { readonly key: string; readonly value: string | null },
    callbacks: ShellCommandCallbacks,
  ) => void;
  readonly deleteEnv: (key: string, callbacks: ShellCommandCallbacks) => void;
  /** Chaining them through the set's per-`mutate` `onSuccess` put the delete on the far side of an unmount
   * boundary TanStack does not cross. */
  readonly renameEnv: (
    rename: {
      readonly oldKey: string;
      readonly newKey: string;
      readonly value: string | null;
    },
    callbacks: ShellCommandCallbacks,
  ) => void;
}

/** The query key travels with it: a bridge probe and a per-host RPC probe for the same path are different
 * answers and must never share a cache slot. */
export interface ShellProbeSource {
  readonly queryKeyFor: (path: string) => QueryKey;
  /** `signal` is the probing query's own `QueryFunctionContext.signal`, and it has to reach the transport rather
   * than stop here. */
  readonly probe: (
    path: string,
    signal: AbortSignal | undefined,
  ) => Promise<ConfigShellProbeResponse>;
  readonly pickProgramFile: (() => Promise<string | null>) | null;
}
