import type { QueryKey } from "@tanstack/react-query";
import type {
  ConfigDetectedShell,
  ConfigEnvEntry,
  ConfigShellProbeResponse,
  ConfigShellSetRequestV10,
} from "@traycer/protocol/host/config/index";

/**
 * The effective shell, as either transport reports it.
 *
 * Structurally `ConfigShellGetResponse` with `args` widened to `readonly` — the
 * wire type's array is mutable and the bridge's is not, and the panel only ever
 * reads it. Naming the read shape here is what lets one editor consume both
 * without a cast.
 */
export interface ShellConfigSnapshot {
  readonly path: string;
  readonly args: readonly string[];
  readonly synthesised: boolean;
}

/**
 * What the Shell panel needs from whatever is answering for the selected host.
 *
 * Two transports implement it and the panel cannot tell them apart:
 *
 *   - **host RPC** (`config.*`) — the path for every host that can be dialled,
 *     local or remote. One code path for both is the point of the whole track.
 *   - **the local CLI bridge** — reachable only when the selected host is THIS
 *     computer and its process cannot answer: stopped, or a version predating
 *     these methods (`localConfigFallbackReason`). Kept because RPC-only would
 *     take shell editing away exactly while someone is debugging a host that
 *     will not start, and for the whole window in which the app has updated
 *     and the host it manages has not.
 *
 * The panel is presentational against this interface, so the two paths cannot
 * drift into two different editors. Editor commands take callbacks for
 * transient per-control save flashes, which TanStack correctly drops after
 * unmount. Multi-write operations await completion instead, so navigation
 * cannot discard a required continuation.
 */
export interface ShellCommandCallbacks {
  readonly onSuccess: () => void;
  /** Called with the save's error. */
  readonly onError: (error: unknown) => void;
}

export interface ShellConfigController {
  /** `undefined` while the effective shell is still loading. */
  readonly config: ShellConfigSnapshot | undefined;
  /**
   * A failed shell or environment read. The panel offers the same retry for
   * both, so an initial environment failure cannot leave editing disabled
   * without a way to load the rows.
   */
  readonly configError: Error | null;
  /** Re-issue the failed reads. */
  readonly retryConfig: () => void;
  readonly shells: readonly ConfigDetectedShell[];
  /**
   * Re-run shell detection on the target machine. Freshness is otherwise
   * per-panel-visit (`refetchOnMount: "always"`), and deliberately NOT
   * focus-driven - this desktop shell's focus/online signals are unreliable
   * around sleep/wake (see `createAppQueryClient`), detection spawns a
   * `wsl.exe` probe on Windows, and window focus says nothing about a REMOTE
   * host's state. The explicit control is what lets a user who just ran
   * `wsl --install` verify the picker now agrees.
   */
  readonly refreshShells: () => void;
  /** A `refreshShells` (or mount) fetch of the list is in flight. */
  readonly shellsRefreshing: boolean;
  readonly overrides: readonly ConfigEnvEntry[];
  /** Any shell-config write is in flight. */
  readonly shellPending: boolean;
  /** Environment rows have not loaded yet, or a write is in flight. */
  readonly envPending: boolean;
  readonly probeSource: ShellProbeSource;
  readonly setShell: (
    request: ConfigShellSetRequestV10,
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
  /** Completion for multi-write operations that must survive panel unmount. */
  readonly setEnvAsync: (entry: {
    readonly key: string;
    readonly value: string | null;
  }) => Promise<void>;
  readonly deleteEnv: (key: string, callbacks: ShellCommandCallbacks) => void;
  /**
   * Rename an override as a SINGLE operation: write `newKey`, then drop
   * `oldKey`.
   *
   * Not `setEnv` followed by `deleteEnv` at the call site. Chaining them
   * through the set's per-`mutate` `onSuccess` put the delete on the far side
   * of an unmount boundary TanStack does not cross - close Settings or switch
   * host while the set is in flight and the observer is gone, so the delete
   * never fires and the rename leaves two live variables that both reach the
   * next host and agent launch.
   *
   * Order is deliberate and unchanged: create first, so a failed delete leaves
   * a harmless duplicate rather than a lost value. `oldKey` of `""` means
   * there is nothing to drop (a newly added row).
   */
  readonly renameEnv: (
    rename: {
      readonly oldKey: string;
      readonly newKey: string;
      readonly value: string | null;
    },
    callbacks: ShellCommandCallbacks,
  ) => void;
}

/**
 * Where the "Add a shell" validation asks its questions.
 *
 * The probe MUST run on the machine whose shell is being configured — that is
 * the whole reason `config.shell.probe` exists — so the picker takes its source
 * from the panel rather than reaching for the local bridge itself. The query
 * key travels with it: a bridge probe and a per-host RPC probe for the same
 * path are different answers and must never share a cache slot.
 *
 * `pickProgramFile` is the native file dialog, and it is `null` for every
 * target machine that is not this one. A local dialog can only name local
 * paths, so offering it for a remote host would hand that host a path it has
 * never heard of — the plan's degrade is a typed path, which the picker
 * already supports for every target.
 */
export interface ShellProbeSource {
  readonly queryKeyFor: (path: string) => QueryKey;
  /**
   * `signal` is the probing query's own `QueryFunctionContext.signal`, and it
   * has to reach the transport rather than stop here. The status line reprobes
   * on every keystroke of a typed path, so an abandoned probe is the common
   * case, not the rare one: without the signal each obsolete call keeps its
   * slot in the request coordinator until the host answers a question no
   * surface is still asking.
   */
  readonly probe: (
    path: string,
    signal: AbortSignal | undefined,
  ) => Promise<ConfigShellProbeResponse>;
  readonly pickProgramFile: (() => Promise<string | null>) | null;
}
