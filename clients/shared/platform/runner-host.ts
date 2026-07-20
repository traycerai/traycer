import type { Disposable } from "./uri-callback";
import type { AuthIdentityValidationResult } from "../auth/auth-validation-types";

/**
 * Composite runner-host surface consumed by `gui-app` on standalone desktop
 * and mobile shells.
 *
 * `IRunnerHost` intentionally stays platform-agnostic: the shared module must
 * not import Electron or Capacitor types. Concrete implementations live under
 * `clients/desktop/` (Electron preload bridge - `contextBridge` +
 * `ipcRenderer.invoke`) and `clients/mobile/`
 * (`Capacitor.Plugins.RunnerHost.get()`).
 *
 * Methods that may cross a process boundary are promise-returning so the
 * Electron preload can implement them via `ipcRenderer.invoke` without
 * needing a synchronous shim. Subscriptions return a synchronous
 * `Disposable` because the underlying `ipcRenderer.on` registration is
 * synchronous in the renderer.
 *
 * Capability semantics:
 * - `tray`, `notifications`, and `workspaceFolders` are always present.
 *   Shells without a native capability install a no-op implementation whose
 *   event emitters never fire or whose picker returns an empty selection.
 *   Callers never branch on `null`.
 * - `onLocalHostChange(handler)` is the only way to observe the bundled
 *   local host. The handler is invoked synchronously on subscribe with
 *   the current snapshot (or `null` when no host is running), and again
 *   on every subsequent transition. There is no separate `getLocalHost()`.
 * - `hostPicker` lets `gui-app` request shell-owned picker UX
 *   (e.g. a menu-bar popover on desktop, a sheet on mobile) without the
 *   shell leaking implementation details.
 * - `workspaceFolders` lets `gui-app` ask the shell for native folder-picker
 *   UX. Shells without native folder access return an empty selection.
 *
 * The concrete `IRunnerHost` is constructed by each shell at bootstrap and
 * passed explicitly into `<TraycerApp />`. Shared code does not resolve or
 * register it through module-level globals.
 */
export interface IRunnerHost {
  /**
   * Browser-safe sign-in URL the shell wants `gui-app` to open when the
   * user initiates auth. Shells embed their own callback scheme (custom
   * protocol on desktop, universal link on mobile), so the URL is
   * shell-owned and read-only here.
   */
  readonly signInUrl: string;

  /**
   * Browser-safe base URL for the AuthnV3 service. Parity with `signInUrl`:
   * shell-owned, browser-safe, read-only. Used both for sign-in URL
   * composition and by host-side token validation against
   * `${authnBaseUrl}/api/v3/user`.
   */
  readonly authnBaseUrl: string;

  /**
   * Validates a Traycer bearer token against the shell-owned AuthnV3 base URL
   * and projects the minimum profile shape the GUI needs for signed-in state.
   * If the user lookup fails but the bundled refresh token is still accepted,
   * implementations return a valid result with `refreshedToken`.
   *
   * Desktop shells perform this in Electron main so renderer-origin CORS does
   * not decide auth success. Browser-only test/dev shells may satisfy the same
   * contract with a direct HTTP fetch.
   */
  validateAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenValidationResult>;

  /**
   * Validates a Traycer bearer token and returns the full AuthnV3 identity
   * shape required to mint a client `RequestContext`. Desktop shells perform
   * this in Electron main so renderer CSP/CORS cannot turn a valid OAuth
   * callback into a false invalid-token result. Browser-only test/dev shells
   * may call the shared HTTP helper directly.
   */
  validateAuthTokenIdentity(
    token: string,
    refreshToken: string,
  ): Promise<AuthIdentityValidationResult>;

  /**
   * Force-refreshes the access token against authn's `POST /api/v3/auth/refresh`
   * WITHOUT a prior `/api/v3/user` validation, rotating both the bearer and the
   * refresh token. The proactive refresh scheduler calls this shortly before the
   * ~4h TTL so a long-open session never carries a dead bearer into a live host
   * call. Desktop shells run this in Electron main so renderer-origin CORS does
   * not block the authn request; browser/test shells may call the shared
   * `refreshAuthTokenViaHttp` helper directly.
   */
  refreshAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenRefreshResult>;

  openExternalLink(url: string): Promise<void>;

  /**
   * Given a set of bare URL-scheme names (e.g. `"vscode"`, `"cursor"`), returns
   * the subset that has a registered handler on THIS machine - the same OS
   * scheme-handler registry the shell consults when launching `scheme://…`
   * (LaunchServices on macOS, the registry on Windows, xdg on Linux). The query
   * is by scheme only: it never matches an application name or bundle path, so a
   * renamed or relocated install is still detected as long as it still registers
   * its scheme. Used to hide "Open in <editor>" options that would fail to
   * launch. Shells with no native scheme registry (mobile, web, tests) resolve
   * an empty list; callers treat that as "offer nothing native".
   */
  getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]>;

  /**
   * Ensures OS microphone access before voice capture. On macOS this triggers
   * the native permission prompt when the status is undetermined, and returns
   * the existing decision otherwise (macOS never re-prompts a denied app - the
   * caller then routes to `openMicrophoneSettings`). Shells without a native
   * gate resolve `"granted"` and let `getUserMedia` drive the prompt.
   */
  requestMicrophoneAccess(): Promise<MicrophoneAccessStatus>;

  /**
   * Opens the OS Privacy → Microphone settings pane so the user can re-grant
   * mic access (used by the voice-input "denied" affordance). Desktop opens the
   * native pane; shells without a settings deep link (mobile/web/tests)
   * implement this as a resolved no-op.
   */
  openMicrophoneSettings(): Promise<void>;

  /**
   * Called by the GUI auth controller immediately before
   * `openExternalLink(...)`.
   * Implementations close the previous attempt window (so any callback URL
   * still pending from the previous attempt is treated as stale) and start a
   * fresh attempt window. After this signal, every subsequent `appUrlOpen`
   * (or equivalent shell-delivered callback event) is unambiguously part of
   * the new attempt. Shells whose callback delivery does not require URL
   * dedupe MAY implement this as a no-op.
   */
  beginAuthAttempt(): void;

  /**
   * Subscribes to the browser-return signal the shell delivers when the user
   * comes back from the device-approval browser tab (the `traycer://` deep
   * link on desktop). The signal is **payload-free**: device flow is the only
   * interactive login, so the shell carries no token or code here - it only
   * tells the renderer "the browser returned" so the in-flight device poll can
   * fire immediately instead of waiting out its interval. The token always
   * arrives through the device-flow poll (`IDeviceFlowHost`), never here, and
   * sign-in still completes poll-only if this never fires.
   */
  onAuthCallback(handler: () => void): Disposable;

  /**
   * OAuth 2.0 Device Authorization Grant (RFC 8628) controller, owned by the
   * shell's privileged process. On desktop the authorize call AND the
   * `/device/token` poll loop run in Electron main so they are CORS-safe (the
   * authn endpoints don't allow the renderer origin) and survive renderer
   * window close / sleep - the renderer only observes the terminal outcome.
   * Shells with no device-flow
   * backend (mobile, web, in-browser dev) install a no-op whose `start()`
   * resolves `null`. Always present; callers never branch on `null`.
   */
  readonly deviceFlow: IDeviceFlowHost;

  readonly secureStorage: ISecureStorage;
  readonly notifications: INotificationHost;
  readonly tray: ITrayState;
  readonly hostPicker: IHostPicker;
  readonly workspaceFolders: IWorkspaceFoldersHost;
  readonly fileDrops: IFileDropHost;
  /**
   * Desktop display-zoom surface. Present on desktop shells and `null` on
   * shells that do not own a native app-scale control.
   */
  readonly zoom: IZoomHost | null;

  /**
   * Typed token-storage capability shared across shells. Always present -
   * same convention as `tray` and `notifications`. Callers never branch on
   * `null`. Desktop backs this with the OS keychain via the Electron
   * preload bridge; mobile backs it with the native secure store; in-memory
   * implementations (dev runner, tests) keep a single round-trippable entry.
   */
  readonly tokenStore: ITokenStore;

  /**
   * Declares whether this shell actually exposes a local-host stream.
   *
   * `true` on shells that bundle and spawn a local host (desktop). `false`
   * on shells that have no local-host concept at all (mobile, web). The
   * LocalHostGate keys off this so the signed-in host-wait UX only drives
   * on shells that actually have a local host to wait for; shells that
   * set this to `false` pass through to shell-specific UX
   * (e.g. `<MobileHostGate />`) without seeing the desktop "Retry" card.
   *
   * Shells that set this to `false` MUST still honour the
   * `onLocalHostChange(...)` contract - the handler is invoked synchronously
   * on subscribe with `null` - so downstream consumers that do observe the
   * stream are not exposed to a branch on capability.
   */
  readonly hasLocalHost: boolean;

  /**
   * Subscribes to local-host snapshot changes. The handler fires
   * synchronously on subscribe with the current snapshot (or `null`), then
   * again whenever the snapshot transitions. Mobile shells emit a single
   * `null` snapshot on subscribe and never transition.
   */
  onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable;

  /**
   * Subscribes to OS wake events (device resume / screen unlock). The handler
   * fires shortly after the machine wakes from sleep - the signal `gui-app`
   * uses to force-reconnect its host streams so an open epic recovers from
   * offline within seconds instead of waiting out the stream heartbeat.
   *
   * Desktop bridges Electron `powerMonitor` `resume`/`unlock-screen` through
   * the preload IPC bridge. Shells with no OS wake signal (mobile, web, tests)
   * install a no-op whose handler never fires; consumers still pair this with
   * the cross-platform `window` `online` event, so wake recovery degrades
   * gracefully where no native signal exists.
   */
  onSystemResumed(handler: () => void): Disposable;

  /**
   * Asks the shell to re-spawn its detached local host. Desktop delegates
   * to `HostLifecycle.respawn()` via the preload IPC bridge; mobile shells
   * (and any shell without a local host) implement this as a resolved
   * no-op. `gui-app` drives this from the host-Retry UX so the renderer
   * never touches the lifecycle process directly.
   */
  requestHostRespawn(): Promise<void>;

  /**
   * OS-service control surface used by the Service Health settings pane.
   * Present on shells that manage the host as a system service
   * (LaunchAgent / systemd-user / Scheduled Task on desktop) and `null`
   * everywhere else. Callers branch once on `null` to gate the UI.
   */
  readonly service: IServiceHost | null;

  /**
   * Surface to the local `traycer` CLI subprocess. Used by the renderer
   * for two host-independent concerns:
   *   1. Reading bootstrap status (pid metadata + recent bootstrap.log
   *      markers) when the host is unreachable, so the failure card
   *      can show what was attempted and why.
   *   2. Editing bootstrap config (shell path/args + env overrides) the
   *      host's launchd wrapper consumes on next start.
   *
   * Present on shells where the CLI ships (desktop) and `null` everywhere
   * else (mobile, web, in-browser dev). Each call corresponds to a single
   * `traycer` subcommand invocation; failures bubble as rejected promises
   * with the CLI's stderr in the message.
   */
  readonly traycerCli: ITraycerCli | null;

  /**
   * Cross-window migration-run channel. Used by the migration controller to
   * announce running state transitions so every other Electron window mounts
   * the blocking modal in lockstep. Present on shells that support multiple
   * windows (desktop) and `null` everywhere else (mobile, web).
   */
  readonly migration: IMigrationHost | null;

  /**
   * Host-management surface for the local Traycer host. Backed by NDJSON
   * subcommand invocations against the `traycer` CLI subprocess on desktop;
   * `null` on shells that don't ship the CLI (mobile, web). Settings → Host
   * and the Doctor failure card consume this surface; long-running operations
   * (install / update / register-service) call `onProgress` for every NDJSON
   * `progress` event while the terminal `result.data` resolves the promise.
   */
  readonly hostManagement: IHostManagement | null;

  /**
   * Tray-side host command channel forwarded from the shell tray to the
   * renderer. Present on shells that surface a native tray (desktop) and
   * `null` everywhere else. The renderer keeps a subscription mounted so
   * `openSettingsHost` / `restartHost` / `openLogs` / `installUpdate`
   * tray clicks route through the same host-management surface as Settings.
   */
  readonly hostTray: IHostTray | null;
}

/** Outcome of `IRunnerHost.requestMicrophoneAccess()`. */
export type MicrophoneAccessStatus = "granted" | "denied";

export interface IFileDropHost {
  resolveDroppedFilePaths(files: readonly File[]): Promise<readonly string[]>;
  /**
   * Return durable paths for drops that expose only a `file://` URL with no
   * `File` object. Stable workspace paths pass through unchanged. Known
   * ephemeral sources (e.g. the macOS screenshot thumbnail staging path) are
   * copied into an app-managed temp location before the OS can reclaim them.
   * Implementations that cannot copy return the original path so the caller is
   * never worse off.
   */
  copyDroppedFilePaths(paths: readonly string[]): Promise<readonly string[]>;
  /**
   * Reads file paths from the native clipboard formats that Chromium does not
   * surface through `ClipboardEvent`. Callers only use this from a direct
   * paste event whose DOM clipboard has no usable content.
   */
  readNativeClipboardFilePaths(): Promise<readonly string[]>;
}

/**
 * Native app display-zoom capability. Desktop exposes this through Electron
 * IPC; unsupported shells set `IRunnerHost.zoom` to `null`.
 */
export interface IZoomHost {
  readonly ladder: readonly number[];
  get(): Promise<number>;
  set(percent: number): Promise<number>;
  stepIn(): Promise<number>;
  stepOut(): Promise<number>;
  reset(): Promise<number>;
  onChange(handler: (percent: number) => void): Disposable;
}

export interface MigrationRunningSnapshot {
  readonly running: boolean;
  readonly originWindowId: string | null;
}

export interface IMigrationHost {
  announceRunning(snapshot: MigrationRunningSnapshot): Promise<void>;
  getSnapshot(): Promise<MigrationRunningSnapshot>;
  onChange(handler: (snapshot: MigrationRunningSnapshot) => void): Disposable;
}

/**
 * Renderer-facing view of `traycer host status` output. Mirrors the JSON
 * the CLI prints on stdout. Field semantics:
 *   - `running`: `true` iff `~/.traycer/host.pid.json` exists and parsed.
 *     A stale PID file (process gone, file not yet cleaned up) still reads
 *     as `running: true` here - the renderer pairs this with its own
 *     `LocalHostSnapshot` stream to reconcile.
 *   - `pidMetadata`: same shape the host writes; mirrored locally so
 *     `gui-app` does not import from `traycer-host` directly.
 *   - `bootstrapMarkers`: most-recent N entries from `~/.traycer/bootstrap.log`,
 *     newest last. Lines that aren't structured markers (raw host stdout
 *     captured into the same file) are filtered out by the CLI.
 *   - `bootstrapLogPath`: absolute path the user can `tail` to debug.
 */
export interface TraycerHostStatusSnapshot {
  readonly running: boolean;
  readonly pidMetadata: TraycerPidMetadata | null;
  readonly bootstrapMarkers: readonly BootstrapMarkerEntry[];
  readonly bootstrapLogPath: string;
  /**
   * Last ~80 lines of `~/.traycer/bootstrap.log` verbatim - includes both
   * structured markers and raw shell stdout/stderr captured into the same
   * file. The loading card renders this live so users see what their shell
   * is doing during a slow init (sourcing zshrc, fzf prompts, asdf shim
   * resolution, …).
   */
  readonly bootstrapLogTail: string;
}

export interface TraycerPidMetadata {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
}

export type BootstrapPhase =
  "starting" | "exited" | "crashed" | "killed" | "failed-to-spawn";

export interface BootstrapMarkerEntry {
  readonly timestamp: string;
  readonly phase: BootstrapPhase;
  readonly fields: Readonly<Partial<Record<string, string>>>;
}

/**
 * Effective shell config consumed by both host bootstrap and terminal
 * sessions. `synthesised: true` means no row exists in SQLite and the
 * defaults were filled in by the CLI - the settings UI surfaces this as
 * "(default - not stored)".
 */
export interface TraycerShellConfig {
  readonly path: string;
  readonly args: readonly string[];
  readonly synthesised: boolean;
}

/**
 * An entry in the Settings → Shell picker list: a detected shell binary or a
 * user-added program. `path` is absolute (except an OS default that may be a
 * bare command name, e.g. Windows `powershell.exe`); `isDefault` marks the
 * OS-default shell; `source` tells the UI which rows the user may remove
 * (`"added"`) versus which are detected and permanent. `missing` is `true` only
 * for an `"added"` row whose file is gone (a list-time probe, never persisted),
 * so the UI can flag a customised-but-uninstalled shell while keeping its ✕;
 * detected rows are always `false`.
 */
export interface TraycerDetectedShell {
  readonly name: string;
  readonly path: string;
  readonly isDefault: boolean;
  readonly source: "detected" | "added";
  readonly missing: boolean;
}

/**
 * Result of probing a candidate shell path (Settings → Shell "Add a shell"
 * live validation). `exists` is `F_OK`; `executable` is `X_OK`. The desktop
 * shell answers this natively (fs access in Electron main), mirroring the
 * protocol's detection check rather than spawning the CLI per keystroke.
 */
export interface TraycerShellProbeResult {
  readonly exists: boolean;
  readonly executable: boolean;
}

// Host-process env overrides (Settings → Shell), applied to the local host
// at its next start. Per-harness env overrides live per-provider in the
// host's provider-overrides (Settings → Providers), set over the
// `providers.*` RPC - not through this CLI bridge.
export interface TraycerEnvOverride {
  readonly key: string;
  readonly value: string | null;
}

export interface TraycerShellConfigSetInput {
  /** New shell path; null preserves the stored value (or default). */
  readonly path: string | null;
  /**
   * Ordered shell flags. `null` preserves the stored value (or falls back to
   * the synthesised default); `[]` writes an explicit empty list - passed
   * straight through as a native `string[]` rather than JSON-encoded text.
   */
  readonly args: readonly string[] | null;
}

export interface ITraycerCli {
  hostStatus(): Promise<TraycerHostStatusSnapshot>;
  shellConfigGet(): Promise<TraycerShellConfig>;
  shellConfigSet(input: TraycerShellConfigSetInput): Promise<void>;
  shellConfigReset(): Promise<void>;
  /**
   * Remembers a program in `shell.entries` and selects it (`config shell add`).
   * The backend re-validates it is absolute + executable and rejects otherwise,
   * so callers should gate on {@link shellProbe} first for a clean UX.
   */
  shellConfigAdd(input: { readonly path: string }): Promise<void>;
  /**
   * Forgets a previously-added program (`config shell remove`). If it was the
   * selected shell, the selection falls back to the OS default. Removing a path
   * that was never added is a no-op success.
   */
  shellConfigRemove(input: { readonly path: string }): Promise<void>;
  /**
   * Restores a remembered shell's flags to its family default
   * (`config shell revert-args`) by clearing its stored deviation while keeping
   * the shell remembered. A no-op when the shell has no entry.
   */
  shellRevertArgs(input: { readonly path: string }): Promise<void>;
  /**
   * Native (non-subprocess) existence + executability probe backing the picker's
   * live "Add a shell" validation. Implemented with fs access in the shell's
   * privileged process so it can run debounced per keystroke.
   */
  shellProbe(input: {
    readonly path: string;
  }): Promise<TraycerShellProbeResult>;
  /**
   * Opens the shell's native "choose a program file" dialog, resolving the
   * chosen absolute path or `null` on cancel. `null` (not a method) on shells
   * with no native file dialog - the picker hides its Browse affordance then.
   */
  readonly pickShellProgramFile: (() => Promise<string | null>) | null;
  shellListDetected(): Promise<readonly TraycerDetectedShell[]>;
  envOverrideList(): Promise<readonly TraycerEnvOverride[]>;
  envOverrideSet(input: {
    readonly key: string;
    readonly value: string | null;
  }): Promise<void>;
  envOverrideDelete(input: { readonly key: string }): Promise<void>;
  /**
   * Seeds the CLI's stored credentials from a captured bearer + refresh token so
   * the CLI keeps using them for host comms (and can self-refresh on a 401).
   * The host pipes a JSON `{ token, refreshToken }` payload to the CLI over
   * stdin (never argv) to keep the secrets out of the process list. Resolves
   * once the credentials file has been written; rejects if the token was
   * rejected by the authn service.
   */
  cliLogin(token: string, refreshToken: string): Promise<void>;
  /**
   * Deletes the machine-local CLI credentials so the host's owner-binding
   * gate falls back to deny-by-default. Mirrors `cliLogin`: invoked at sign-out
   * to deprovision the host on this machine.
   */
  cliLogout(): Promise<void>;
}

/**
 * Snapshot of the OS-managed host service, mirrored from the shell's
 * `ServiceController.status()` call. Field semantics:
 *   - `state`: `running` when the service is registered AND its PID
 *     metadata describes a live process; `stopped` when registered but the
 *     PID is missing or stale; `not-installed` when the manifest is absent.
 *   - `version`: value the running host wrote into PID metadata.
 *   - `listenUrl`: WS URL the renderer should connect to.
 *   - `pid`: OS process id, useful for log tail correlation.
 */
export interface ServiceStatusSnapshot {
  readonly state: "running" | "stopped" | "not-installed";
  readonly version: string | null;
  readonly listenUrl: string | null;
  readonly pid: number | null;
}

export interface IServiceHost {
  status(): Promise<ServiceStatusSnapshot>;
  install(): Promise<void>;
  uninstall(purge: boolean): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  upgrade(): Promise<void>;
  /**
   * Linux-only. Calls `loginctl enable-linger $USER` so the systemd-user
   * instance starts before any interactive login. Throws on non-Linux.
   */
  enableLinger(): Promise<void>;
  /**
   * Reads the last `maxLines` lines of the host's log file. Returns
   * `null` when the log file is missing or unreadable.
   */
  getLogTail(maxLines: number): Promise<string | null>;
}

/**
 * Authorization details returned by `/device/authorize`, surfaced to the GUI so
 * it can display the human-handled `userCode` + `verificationUri` (or rely on
 * the shell opening `verificationUriComplete`) and show poll progress / expiry.
 * `expiresInSeconds` is the device_code TTL; the GUI scopes its device-attempt
 * timeout to it.
 */
export interface DeviceFlowAuthorization {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

/**
 * Terminal outcome of a device-flow attempt, emitted once by the shell's
 * controller after its poll loop settles:
 *   - `authorized` carries the minted `{ token, refreshToken }` pair.
 *   - `denied`     the user denied the request in the browser.
 *   - `expired`    the device_code TTL elapsed before approval.
 *   - `error`      a terminal/unrecoverable failure (invalid grant, or the
 *                  loop gave up after persistent network/5xx failures).
 * Non-terminal poll states (`authorization-pending` / `slow-down`) are handled
 * entirely inside the controller and never surface here.
 */
export type DeviceFlowResult =
  | {
      readonly kind: "authorized";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "error" };

/**
 * Handle to a single in-flight device-flow attempt. `authorization` is the
 * `/device/authorize` response (already resolved by the time the session
 * exists). `onResult` fires exactly once with the terminal `DeviceFlowResult`;
 * implementations replay a result that settled before the subscription so a
 * fast poll can't be missed. `pollNow()` nudges the shell-side loop to poll
 * `/device/token` immediately rather than waiting out the current interval -
 * the GUI calls it on the browser-return signal so approval is picked up at
 * once. `cancel()` stops the shell-side poll loop and frees its resources - the
 * GUI calls it when the attempt is superseded (retry), on sign-out, and on
 * dispose; it must never invoke `onResult` synchronously, so a caller can safely
 * cancel from inside a teardown path without re-entering its own finalizer.
 */
export interface DeviceFlowSession {
  readonly authorization: DeviceFlowAuthorization;
  onResult(handler: (result: DeviceFlowResult) => void): Disposable;
  /**
   * Nudges the shell-side poll loop to dispatch a `/device/token` poll
   * immediately (collapsing the remaining interval wait). Best-effort and
   * idempotent: it never delivers a token itself - the result still arrives
   * through `onResult` - and is a no-op once the attempt has settled.
   */
  pollNow(): void;
  cancel(): void;
}

export interface IDeviceFlowHost {
  /**
   * Starts a device-authorization attempt: the shell runs `/device/authorize`
   * and immediately begins the `/device/token` poll loop in its privileged
   * process. Resolves with a `DeviceFlowSession` once authorization succeeds,
   * or `null` when authorization itself fails (network/5xx) or the shell has no
   * device-flow backend - the caller surfaces a launch-style failure and may
   * retry. The shell supplies its own `client_id` (`"desktop"`) and host label.
   */
  start(): Promise<DeviceFlowSession | null>;
}

export interface AuthValidationProfile {
  readonly userId: string;
  readonly userName: string;
  readonly email: string;
}

export type AuthTokenValidResult =
  | {
      readonly kind: "valid";
      readonly profile: AuthValidationProfile;
    }
  | {
      readonly kind: "valid";
      readonly profile: AuthValidationProfile;
      // A refresh rotates BOTH the bearer (`refreshedToken`) and the refresh
      // token (`refreshedRefreshToken`); callers must persist both.
      readonly refreshedToken: string;
      readonly refreshedRefreshToken: string;
    };

export type AuthTokenValidationResult =
  | AuthTokenValidResult
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" };

/**
 * Outcome of a forced access-token refresh (`POST /api/v3/auth/refresh`),
 * independent of any `/api/v3/user` validation. `refreshed` rotates BOTH the
 * bearer and the refresh token; `rejected` means the refresh credential is dead
 * (revoked / expired) and the session must sign out; `network-error` is
 * transient and leaves the current credential untouched so a retry can follow.
 */
export type AuthTokenRefreshResult =
  | {
      readonly kind: "refreshed";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" };

export interface ISecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The auth credential persisted per shell: the JWS bearer (`token`) plus the
 * separately-delivered `refreshToken`. Post raw-JWS cutover these are two
 * distinct strings (no AES "combined token"); both must be stored so refresh
 * (`POST /api/v3/auth/refresh`, which requires `refreshToken` in the body) works.
 */
export interface StoredAuthTokens {
  readonly token: string;
  readonly refreshToken: string;
}

/**
 * Typed credential store owned by the shell. Narrower than `ISecureStorage` on
 * purpose: there is a single logical entry per shell, so callers never pick a
 * key. Desktop and mobile implementations back this with their native keychain;
 * in-memory implementations keep a single slot that round-trips through
 * `set` / `get` / `delete`.
 */
export interface ITokenStore {
  get(): Promise<StoredAuthTokens | null>;
  set(tokens: StoredAuthTokens): Promise<void>;
  delete(): Promise<void>;
}

export interface INotificationHost {
  show(
    title: string,
    body: string,
    payload: unknown,
    replaceKey: string | null,
    deliveryKey: string | null,
  ): Promise<void>;
  onClick(handler: (payload: unknown) => void): Disposable;
}

export interface ITrayState {
  setEpics(epics: readonly TrayEpic[]): Promise<void>;
  setIndicator(state: TrayIndicatorState): Promise<void>;
  /**
   * Subscribes to tray epic-click events. Shells without a tray install
   * a no-op implementation whose handler never fires.
   */
  onEpicSelected(handler: (epicId: string) => void): Disposable;
}

export type TrayIndicatorState = "idle" | "active" | "attention";

/**
 * A recent epic projected into the native tray menu. Sourced from the same
 * history store that backs the in-app epic list, so the tray mirrors the most
 * recent epics. `subtitle` carries the relative recency label ("2 hours ago")
 * rendered as the menu item's secondary line.
 */
export interface TrayEpic {
  readonly epicId: string;
  readonly title: string;
  readonly subtitle: string;
}

/**
 * Shell-owned host-picker UX controller. `gui-app` asks the shell to open
 * or close the picker and observes the resulting open/closed transitions;
 * the shell owns layout and dismissal affordances.
 */
export interface IHostPicker {
  readonly isOpen: boolean;
  requestOpen(): void;
  requestClose(): void;
  onChange(handler: (isOpen: boolean) => void): Disposable;
}

export interface IWorkspaceFoldersHost {
  pickFolders(): Promise<readonly string[]>;
}

/**
 * Metadata the desktop runner publishes once the bundled host is running.
 *
 * `websocketUrl` is the browser-consumable localhost URL that binds to
 * `127.0.0.1` only. After the T4 WS-only cutover the host no longer
 * exposes an HTTP endpoint - `WsRpcClient` dials `websocketUrl` directly
 * for every request.
 */
export interface LocalHostSnapshot {
  readonly hostId: string;
  readonly websocketUrl: string;
  readonly version: string;
  readonly pid: number;
  readonly systemHostName: string;
  readonly displayName: string;
}

/**
 * Host-management types crossing the shell↔renderer boundary.
 *
 * Mirrors the NDJSON `result.data` payloads emitted by the `traycer host …`
 * subcommands. Renderer-facing copy of `clients/desktop/src/
 * ipc-contracts/host-management-types.ts` so `gui-app` can import the
 * shapes from the platform contract instead of reaching across into the
 * desktop workspace.
 */
export interface HostProgressEvent {
  readonly operationId: string;
  readonly stage: string;
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
  readonly message: string | null;
}

export type HostOperationKind =
  | "install"
  | "update"
  | "register-service"
  | "ensure"
  | "restart"
  | "free-port-and-restart";

/**
 * Canonical cross-surface snapshot of the single host mutation currently
 * running (if any), mirrored from Desktop main to every renderer window via
 * `hostOperationStatusChange`. Unlike `HostProgressEvent` - which is scoped to
 * the `operationId` of the caller that started it - this is the single source
 * of truth every UI surface (landing-page banner, Settings → Host, a second
 * window) reads to disable its trigger and render progress, regardless of
 * which surface (or the background auto-update reconciler) started the
 * operation. `null` means no host mutation is in flight.
 */
export interface HostOperationStatus {
  readonly operationId: string;
  readonly kind: HostOperationKind;
  readonly stage: string | null;
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
  readonly message: string | null;
  readonly startedAt: string;
}

export interface HostInstallSourceTag {
  readonly kind: "registry" | "local-file";
  readonly value: string;
}

export interface HostInstallResult {
  readonly version: string;
  readonly installedAt: string;
  readonly executablePath: string;
  readonly source: HostInstallSourceTag;
  readonly archiveSha256: string;
  readonly signatureKeyId: string;
  readonly sizeBytes: number;
  readonly previousVersion: string | null;
  readonly serviceLifecycle: {
    readonly priorServiceState:
      "running" | "stopped" | "not-installed" | "externally-managed";
    readonly stoppedBeforeSwap: boolean;
    readonly postSwapAction: "install" | "restart" | "start" | "none";
    readonly postSwapError: string | null;
  };
}

// Result of the post-auth `ensureHost` provisioning call. `already-ready`
// means the persistent host was already reachable (fast no-op);
// `provisioned` means the CLI installed/registered/started it and it became
// reachable; `host-busy` means the running host had work in progress, so
// the CLI did not restart it and the desktop surfaced it for the renderer's
// compat probe (continue if compatible, else prompt Retry/Force restart);
// `removed` means the user uninstalled Traycer's background components from
// this device (see `uninstallTraycer`), so provisioning is intentionally
// skipped until they reinstall - the renderer shows the removed surface
// instead of reinstalling the host.
export interface HostEnsureResult {
  readonly action: "already-ready" | "provisioned" | "host-busy" | "removed";
  readonly running: boolean;
  readonly version: string | null;
}

// Whether the user has uninstalled Traycer's background components from this
// device via Settings → General → Danger Zone. Persisted by the desktop main
// process; gates every auto-provision / respawn path so a removed host is not
// silently reinstalled when it goes unreachable. Cleared by an explicit
// reinstall.
export interface HostRemovalState {
  readonly removedByUser: boolean;
}

// Result of the in-app "Remove Traycer" action. The desktop stops + removes
// the host service, the host install, and (on macOS) the SMAppService login
// item, while preserving all `~/.traycer` user data. Each flag reports what
// the teardown actually accomplished so the renderer can confirm.
export interface TraycerUninstallResult {
  readonly removedHost: boolean;
  readonly deregisteredService: boolean;
  readonly removedLoginItem: boolean;
}

export interface HostInstalledRecord {
  readonly version: string;
  readonly installedAt: string;
  readonly executablePath: string;
  readonly source: HostInstallSourceTag;
  readonly archiveSha256: string;
  readonly signatureKeyId: string;
  readonly sizeBytes: number;
  readonly signatureVerifiedAt: string | null;
  readonly platform: "darwin" | "win32" | "linux";
  readonly arch: "arm64" | "x64";
}

export interface HostAvailableVersionAsset {
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly signatureUrl: string;
  readonly publicKeyId: string;
}

export interface HostAvailableVersionEntry {
  readonly version: string;
  readonly releasedAt: string;
  readonly releaseNotesUrl: string;
  readonly yanked: boolean;
  readonly deprecationReason: string | null;
  readonly platformAsset: HostAvailableVersionAsset | null;
}

export interface HostAvailableSnapshot {
  readonly generatedAt: string;
  readonly latest: string;
  readonly platformKey: string;
  readonly manifestUrl: string;
  readonly versions: readonly HostAvailableVersionEntry[];
}

/**
 * Desktop's user-facing Host update channel intentionally admits only stable
 * SemVer releases and the project's exact `rc.N` form. The CLI keeps its
 * broader operator-facing prerelease inspection surface.
 */
const SEMVER_NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const SEMVER_CORE = `${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}`;
const SEMVER_BUILD_METADATA = "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const CONSENTED_HOST_CHANNEL_VERSION = new RegExp(
  `^${SEMVER_CORE}(?:-rc\\.${SEMVER_NUMERIC_IDENTIFIER})?${SEMVER_BUILD_METADATA}$`,
);
const RELEASE_CANDIDATE_HOST_VERSION = new RegExp(
  `^${SEMVER_CORE}-rc\\.${SEMVER_NUMERIC_IDENTIFIER}${SEMVER_BUILD_METADATA}$`,
);

export function isConsentedHostChannelVersion(version: string): boolean {
  return CONSENTED_HOST_CHANNEL_VERSION.test(version);
}

export function isReleaseCandidateHostVersion(version: string): boolean {
  return RELEASE_CANDIDATE_HOST_VERSION.test(version);
}

interface HostSemanticVersion {
  readonly core: readonly number[];
  readonly prerelease: readonly string[];
}

const SEMVER_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const HOST_SEMVER = new RegExp(
  `^${SEMVER_CORE}(?:-(${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function parseHostSemanticVersion(version: string): HostSemanticVersion | null {
  const match = HOST_SEMVER.exec(version);
  if (match === null) return null;
  const coreEnd = version.search(/[-+]/);
  const core = (coreEnd === -1 ? version : version.slice(0, coreEnd))
    .split(".")
    .map((identifier) => Number.parseInt(identifier, 10));
  const prerelease = match[1]?.split(".") ?? [];
  return { core, prerelease };
}

/**
 * Whether a version is a complete SemVer identifier. This is intentionally
 * broader than the app-facing stable/RC consent policy: CLI operator commands
 * may address other valid prerelease labels.
 */
export function isHostSemanticVersion(version: string): boolean {
  return parseHostSemanticVersion(version) !== null;
}

/**
 * Full SemVer precedence comparison (spec §11), including prereleases and
 * excluding build metadata. Invalid input returns 0 so discovery callers do
 * not advertise an update they cannot justify; callers that need validation
 * should pair this with {@link isHostSemanticVersion}.
 */
export function compareHostVersions(a: string, b: string): number {
  const left = parseHostSemanticVersion(a);
  const right = parseHostSemanticVersion(b);
  if (left === null || right === null) return 0;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1;
    }
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.prerelease.length) return -1;
    if (index >= right.prerelease.length) return 1;
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftNumber = Number.parseInt(leftIdentifier, 10);
      const rightNumber = Number.parseInt(rightIdentifier, 10);
      if (leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? 1 : -1;
      }
    } else if (leftNumeric) {
      return -1;
    } else if (rightNumeric) {
      return 1;
    } else if (leftIdentifier !== rightIdentifier) {
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
  }
  return 0;
}

export interface HostAvailableVersionsInput {
  readonly includePreReleases: boolean;
}

export type HostDoctorSeverity = "info" | "warning" | "error" | "fatal";

export interface HostDoctorIssue {
  readonly code: string;
  readonly severity: HostDoctorSeverity;
  readonly title: string;
  readonly message: string;
  readonly fixAction: string | null;
  readonly terminalCommand: string | null;
  readonly details: Record<string, unknown> | null;
}

export interface HostDoctorReport {
  readonly issues: readonly HostDoctorIssue[];
  readonly ranAt: string;
}

export interface HostRegistryUpdateState {
  readonly checkedAt: string | null;
  readonly latestVersion: string | null;
  readonly installedVersion: string | null;
  readonly updateAvailable: boolean;
  readonly reachable: boolean;
  readonly errorMessage: string | null;
  // The release channel this state was resolved under. A push-based consumer
  // must file the state against the channel that *produced* it rather than
  // whichever channel the consumer currently believes is active - the two
  // broadcasts that follow a channel change (the app-update snapshot, then
  // this) are separate events, so a consumer can observe this one before it
  // has re-rendered with the new channel.
  readonly includePreReleases: boolean;
}

export interface HostUninstallResult {
  readonly removedInstallDir: boolean;
  readonly deregisteredService: boolean;
}

export interface HostLogsTailResult {
  readonly path: string | null;
  readonly tail: string;
}

export interface HostNameSettings {
  readonly systemName: string;
  readonly customName: string | null;
  readonly effectiveName: string;
}

export interface FreePortAndRestartInput {
  readonly port: number;
  readonly pid: number | null;
  readonly processName: string | null;
}

export type HostTrayCommand =
  | { readonly kind: "openSettingsHost" }
  | { readonly kind: "restartHost" }
  | { readonly kind: "openLogs" }
  | { readonly kind: "installUpdate"; readonly version: string };

/**
 * Snapshot of the CLI install manifest exposed to the renderer. Used by the
 * Settings → Host and Doctor panels to surface the staged-but-not-applied
 * `pendingUpgrade` state recorded by `traycer cli upgrade` when the live
 * binary was locked at upgrade time, plus the Desktop-driven launch-time
 * reconciliation hint for package-manager-owned installs that are older than
 * the bundled CLI. `null` when no manifest or reconciliation hint exists yet.
 */
export interface CliInstallManifestSnapshot {
  readonly version: string;
  readonly installedAt: string;
  readonly binaryPath: string;
  readonly source:
    | "desktop"
    | "homebrew"
    | "npm"
    | "winget"
    | "scoop"
    | "apt"
    | "rpm"
    | "manual";
  readonly pendingUpgrade: {
    readonly version: string;
    readonly stagedBinaryPath: string;
    readonly stagedAt: string;
    readonly reason: "binary-locked" | "awaiting-service-restart";
  } | null;
  /**
   * Set by Desktop's launch-time CLI reconciliation when an installed
   * package-manager CLI is older than the bundled CLI: we never overwrite a
   * package-manager-owned binary; instead we surface the source-specific
   * upgrade command for Settings/Doctor to render. Cleared once the user
   * upgrades (the next reconcile observes the new version and drops the
   * hint). `null` when no hint applies.
   */
  readonly packageManagerUpgrade: {
    readonly source: "homebrew" | "npm" | "winget" | "scoop" | "apt" | "rpm";
    readonly installedVersion: string;
    readonly bundledVersion: string;
    readonly upgradeCommand: string;
    readonly recordedAt: string;
  } | null;
}

/**
 * Renderer-facing host management surface. Each method either resolves
 * with the CLI's final NDJSON `result.data` payload (query commands), or -
 * for long-running operations - accepts an `onProgress` callback that fires
 * for every NDJSON `progress` event the CLI emits along the way.
 */
export interface IHostManagement {
  readonly installHost: (input: {
    readonly version: string | null;
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }) => Promise<HostInstallResult>;
  // `expectedVersion` is the exact host version the surface that triggered
  // this update was showing the user ("Update to 1.4.2", the Updates row's
  // `v1.4.2`, the banner). The shell re-resolves the registry target under the
  // *current* release channel and refuses when the two disagree, so a channel
  // switch racing the click can never install a version the user never
  // confirmed. `null` only for callers with no version on screen.
  readonly updateHost: (input: {
    readonly expectedVersion: string | null;
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }) => Promise<HostInstallResult>;
  readonly uninstallHost: (input: {
    readonly all: boolean;
  }) => Promise<HostUninstallResult>;
  // In-app "Remove Traycer" (Settings → General → Danger Zone). Marks the
  // device as removed-by-user (suppressing auto-reinstall), tears down the
  // host service + install + macOS login item, and preserves all user data.
  readonly uninstallTraycer: () => Promise<TraycerUninstallResult>;
  // Reads the persisted removal sentinel so the renderer can short-circuit to
  // the removed surface before attempting any provisioning.
  readonly getRemovalState: () => Promise<HostRemovalState>;
  // Clears the removal sentinel so a subsequent `ensureHost` reinstalls the
  // host (the Reinstall escape hatch on the removed surface).
  readonly clearRemoval: () => Promise<void>;
  readonly restartHost: () => Promise<void>;
  readonly getHostLogs: (input: {
    readonly tailLines: number;
  }) => Promise<HostLogsTailResult>;
  readonly runDoctor: () => Promise<HostDoctorReport>;
  readonly availableVersions: (
    input: HostAvailableVersionsInput,
  ) => Promise<HostAvailableSnapshot>;
  readonly installedRecord: () => Promise<HostInstalledRecord | null>;
  readonly registerService: (input: {
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
  }) => Promise<void>;
  // Post-auth provisioning: idempotently ensure the host is installed,
  // registered, and running. The desktop delegates the whole lifecycle to
  // the CLI (`traycer host ensure`) and streams progress; a fast no-op
  // when the persistent host is already reachable.
  readonly ensureHost: (input: {
    readonly onProgress: ((event: HostProgressEvent) => void) | null;
    // `true` = the desktop "Force restart" (skip the busy check and restart a
    // running host unconditionally). Normal/Retry ensures pass `false`.
    readonly force: boolean;
  }) => Promise<HostEnsureResult>;
  readonly deregisterService: () => Promise<void>;
  readonly registryCheck: (input: {
    readonly force: boolean;
  }) => Promise<HostRegistryUpdateState>;
  // Current cross-surface host operation status (or `null` when idle), read
  // once on mount to prime the shared query cache; live updates arrive via
  // the desktop-only `hostOperationStatus` push bridge (see
  // `HostOperationStatusListener`).
  readonly getOperationStatus: () => Promise<HostOperationStatus | null>;
  readonly freePortAndRestart: (
    input: FreePortAndRestartInput,
  ) => Promise<FreePortAndRestartInput>;
  readonly cliManifest: () => Promise<CliInstallManifestSnapshot | null>;
  readonly getHostName: () => Promise<HostNameSettings>;
  readonly setHostName: (input: {
    readonly customName: string | null;
  }) => Promise<HostNameSettings>;
}

/**
 * Tray-side host command channel. Shells that surface a native tray
 * forward `HostTrayCommand` payloads through `onCommand`; the renderer
 * routes each one through `IHostManagement` or via navigation.
 */
export interface IHostTray {
  onCommand(handler: (command: HostTrayCommand) => void): Disposable;
}
