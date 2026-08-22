import type { Disposable } from "./uri-callback";
import type { AuthIdentityValidationResult } from "../auth/auth-validation-types";
import type {
  ListUserSessionsFetchResult,
  MintHostCredentialFetchResult,
  RevokeAllSessionsFetchResult,
  RevokeUserSessionFetchResult,
  StepUpChallengeFetchResult,
  RetainedStepUpVerifyFetchResult,
} from "../auth/devices-sessions-fetcher";
import type {
  LinkLoginStatusFetchResult,
  MintLinkLoginCodeFetchResult,
  RespondLinkLoginFetchResult,
} from "../auth/link-login";
import type { MintHostCredentialRequest } from "@traycer/protocol/auth/devices-sessions";
import type { HostListFetchResult } from "../host-client/remote-fetcher";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type { LiveHostAvailability } from "../host-client/host-directory";
import type {
  UpdateHostVersionPolicyFetchResult,
  UpdateHostVersionPolicyInput,
} from "../host-client/host-version-policy-fetcher";
import type { DeregisterHostFetchResult } from "../host-client/host-deregister-fetcher";
import type { SelectionAuthorityClient } from "../host-selection/selection-authority-contract";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type {
  HostDoctorIssue as MaintenanceDoctorIssue,
  HostGetInstallationInfoResponse,
  HostUpdateCheckResponse,
} from "@traycer/protocol/host/maintenance/index";

export type { StoredCredentials } from "@traycer/protocol/config/credentials";

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
   * Browser-safe WebSocket attach endpoint for the Remote Host Support relay
   * (Architecture §3/§4b, S2/T14), e.g. `wss://relay.traycer.ai/attach`.
   * Shell-owned, read-only, parity with `authnBaseUrl`. Populated onto a
   * connectable `RemoteHostDirectoryEntry.websocketUrl` so the existing
   * `kind === "remote"` transport branch (`createRemoteHostTransport`) can
   * dial it — the relay itself routes by the opaque `rendezvousId` carried
   * inside the CS-minted attach grant, so this URL never varies per host.
   */
  readonly relayBaseUrl: string;

  /**
   * Validates a Traycer bearer token and returns the full AuthnV3 identity
   * shape required to mint a client `RequestContext`. ACCESS-ONLY (tech plan
   * §3): a single `/api/v3/user` lookup with NO refresh-on-401 fallback, so it
   * can never spend a refresh token - a stale token comes back `rejected` and
   * the caller routes the spend through the locked `tokenStore.rotate`. Desktop
   * shells perform this in Electron main so renderer CSP/CORS cannot turn a
   * valid OAuth callback into a false invalid-token result.
   */
  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult>;

  /**
   * Fetches the signed-in user's host registry + live status from authn-v3's
   * `GET /api/v3/hosts` with the user bearer (Remote Host Support §7). Desktop
   * shells run this in Electron main so renderer-origin CORS does not block the
   * request — authn-v3's CORS allow-list is the web dashboard origin, not the
   * app renderer — exactly as the token-validation calls above do. Browser/dev
   * shells may call the shared `fetchRegisteredHostsViaHttp` helper directly.
   * Never throws: transport failures collapse into the discriminated result.
   */
  listRegisteredHosts(bearerToken: string): Promise<HostListFetchResult>;

  /**
   * Fetches the signed-in user's account sessions from authn-v3. Desktop shells
   * run this in Electron main for the same renderer-origin CORS reason as token
   * validation. Transport failures collapse into the result rather than
   * throwing; a cancellation via `signal` is the one case that may reject.
   *
   * `signal` is the reading TanStack query's cancellation. It matters beyond
   * saving a request: the caller's repair path spends a single-use refresh
   * rotation, so a list nobody is waiting on must stop before it gets there.
   * Shells that own the request in-process abort it for real; shells that run it
   * behind an IPC boundary settle the caller and let the bounded request finish.
   */
  listUserSessions(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<ListUserSessionsFetchResult>;

  /**
   * Revokes one session family. Callers pass the user's normal session bearer
   * plus whether the runner-host boundary should attach its retained step-up
   * credential. Renderer callers never pass the raw step-up bearer.
   */
  revokeUserSession(
    bearerToken: string,
    familyId: string,
    useStepUpCredential: boolean,
  ): Promise<RevokeUserSessionFetchResult>;

  /**
   * Revokes all other sessions and broadcasts host/session invalidation. This
   * is the panic lever: callers verify a fresh step-up challenge for every
   * invocation, then the runner-host boundary attaches the retained step-up
   * credential internally.
   */
  revokeAllSessions(bearerToken: string): Promise<RevokeAllSessionsFetchResult>;

  /**
   * Mints a device credential for a connected host, so the host can keep
   * working on the user's behalf after this client disconnects. The renderer
   * passes its ordinary bearer; there is no step-up variant, because the mint is
   * not step-up gated (see the mint route's doc comment).
   *
   * Unlike the revoke calls, the RESULT here carries live credentials (a
   * host-audience access JWS and a refresh JWE). They necessarily cross back
   * into the renderer, because the stream socket that must carry them to the
   * host lives there.
   */
  mintHostCredential(
    bearerToken: string,
    request: MintHostCredentialRequest,
  ): Promise<MintHostCredentialFetchResult>;

  requestStepUpChallenge(
    bearerToken: string,
  ): Promise<StepUpChallengeFetchResult>;

  /**
   * Mints a one-time link-login code under the user bearer — the "Link a
   * phone" QR surface. The RESULT carries the raw code back into the renderer
   * by necessity: the QR that must display it renders there. The code is
   * short-lived and single-use, and the surface re-mints while open, so the
   * renderer never holds a long-lived secret.
   */
  mintLinkLoginCode(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<MintLinkLoginCodeFetchResult>;

  /**
   * The minting surface's view of its own code — whether a phone has claimed
   * it, and the server-observed claimant metadata for the confirmation
   * prompt. Owner-only on the server.
   */
  linkLoginStatus(
    bearerToken: string,
    code: string,
    signal: AbortSignal,
  ): Promise<LinkLoginStatusFetchResult>;

  /**
   * The minting surface's decision on a claimed code. Approval is the step
   * that authorizes the phone's session; a scan alone never does.
   */
  respondLinkLogin(
    bearerToken: string,
    code: string,
    approve: boolean,
  ): Promise<RespondLinkLoginFetchResult>;

  /**
   * Native QR scanner for the link-login sign-in path, or `null` where no
   * camera scanner exists (desktop, plain browser, tests). A capability, not
   * identity (see `lib/mobile-app.ts` in gui-app): the paste-the-code
   * fallback must render regardless, because a null scanner — and a denied
   * camera permission on a non-null one — are both ordinary states of the
   * same surface.
   */
  readonly linkCodeScanner: ILinkCodeScanner | null;

  /**
   * Self-description of the DEVICE for human-facing prompts — the link-login
   * approver card and the session row. Present only where the shell knows
   * something better than the browser UA (the mobile app reads the hardware
   * model natively); `null` elsewhere, and consumers fall back to
   * `navigator.userAgent`. Descriptive, never identity.
   */
  readonly deviceDescriber: IDeviceDescriber | null;

  /**
   * Link-login codes the OS handed this shell as a launch/open URL — a QR
   * scanned by the system camera rather than by the in-app scanner. `null`
   * wherever the OS never delivers one (desktop, plain browser, tests).
   *
   * A capability alongside `linkCodeScanner`, not a replacement for it: this
   * one is not initiated by the user inside the app, so it can arrive before
   * any surface is mounted and it can arrive while already signed in. Both are
   * the consumer's problem, and the port's contract is what makes them
   * solvable — see `ILinkLoginDeepLinkSource`.
   */
  readonly linkLoginDeepLinks: ILinkLoginDeepLinkSource | null;

  /**
   * Verifies a step-up OTP and retains the short-TTL bearer credential inside
   * the runner-host boundary. Returns only expiry metadata for renderer batch
   * window logic.
   */
  verifyStepUpChallenge(
    bearerToken: string,
    code: string,
  ): Promise<RetainedStepUpVerifyFetchResult>;

  /**
   * Applies a version-policy write for one host with the user bearer
   * (Remote Host Support §13, T16): `PATCH /api/v3/hosts/:hostId` — "Update
   * now" (`desiredVersion`), the auto-update toggle (`updatePolicy`), or the
   * drain-gate force ("Apply now — ends N sessions", `force: true`). Desktop
   * shells run this in Electron main for the same CORS reason as
   * `listRegisteredHosts`; browser/dev shells may call the shared
   * `updateHostVersionPolicyViaHttp` helper directly. Never throws: transport
   * failures collapse into the discriminated result.
   */
  updateHostVersionPolicy(
    bearerToken: string,
    hostId: string,
    input: UpdateHostVersionPolicyInput,
  ): Promise<UpdateHostVersionPolicyFetchResult>;

  /**
   * "Remove from account" — `POST /api/v3/hosts/:hostId/deregister` with the
   * user bearer. Desktop shells run this in Electron main for the same CORS
   * reason as `listRegisteredHosts` / `updateHostVersionPolicy`; browser/dev
   * shells may call the shared `deregisterHostViaHttp` helper directly. Never
   * throws: transport failures collapse into the discriminated result.
   *
   * This is a REGISTRY-only write, like the version policy above and unlike
   * anything on `IHostManagement`: it needs no route to the machine, nothing on
   * the machine changes, and the removal is not permanent — see
   * `host-deregister-fetcher.ts` for exactly what the route does and why the
   * confirmation copy has to say a live host comes back.
   */
  deregisterHostFromAccount(
    bearerToken: string,
    hostId: string,
  ): Promise<DeregisterHostFetchResult>;

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
   * local-host lifecycle keys off this so the signed-in host-wait UX only
   * drives on shells that actually have a local host to wait for; shells that
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
   * The `hostId` this machine's local host most recently published, read from
   * durable host metadata rather than from a live connection - so it still
   * answers while the host is stopped, restarting, or unreachable.
   *
   * `onLocalHostChange` deliberately emits a snapshot only for a host that is
   * actually dialable, which leaves a blind spot: the registry also lists this
   * machine, and during a local restart its remote-kind twin is the only entry
   * carrying that id. Without this, a shell cannot tell "another machine" from
   * "my own host, currently down" in exactly the window where it matters.
   *
   * `null` when this shell has no local host, or when no host has ever
   * published metadata on this machine.
   */
  getLastKnownLocalHostId(): Promise<string | null>;

  /**
   * Subscribes to OS wake events (device resume / screen unlock). The handler
   * fires shortly after the machine wakes from sleep - the signal `gui-app`
   * uses to force-reconnect its host streams so an open epic recovers from
   * offline within seconds instead of waiting out the stream heartbeat.
   *
   * Desktop bridges Electron `powerMonitor` `resume`/`unlock-screen` through
   * the preload IPC bridge. Mobile raises it on the hidden -> visible edge,
   * where "the machine woke" means the app returned to the foreground and the
   * OS un-suspended its WebView. Shells with no wake signal at all (web, tests)
   * install a no-op whose handler never fires; consumers still pair this with
   * the cross-platform `window` `online` event, so wake recovery degrades
   * gracefully where no native signal exists.
   */
  onSystemResumed(handler: () => void): Disposable;

  /**
   * Asks the shell to re-spawn its detached local host. Desktop delegates
   * to `HostLifecycle.respawn()` via the preload IPC bridge; mobile shells
   * (and any shell without a local host) implement this as a resolved
   * `restarted` no-op. `gui-app` drives this from the host-Retry UX so the
   * renderer never touches the lifecycle process directly. Resolves
   * `declined` when the host was deliberately not restarted (busy with
   * in-progress work, removed by the user, lock contention) - callers
   * present that as information, not as an error; the promise rejects only
   * on genuine failures.
   */
  requestHostRespawn(): Promise<HostRestartRequestResult>;

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
   * The window's client of the per-app selection authority (host-lifecycle
   * redesign, D16). Every shell has one - the desktop preload binds it over
   * IPC to the engine in main, and a shell with no main process mounts the
   * same engine in-window behind the in-process adapter - so this is
   * non-nullable by design: "which host is effective" must have exactly one
   * answer per app, and a shell without an authority would have to invent a
   * second one.
   *
   * Consumers do not talk to it directly; they go through the window's
   * `SelectionEvidenceKernel`, which owns the attach choreography and the
   * live-session inventory.
   */
  readonly selectionAuthority: SelectionAuthorityClient;

  /**
   * Tells the selection authority that registered-host MEMBERSHIP changed, so
   * it re-reads the registry (P1.2 cold review F6).
   *
   * The authority refreshes its fleet on identity change, local-host change
   * and startup; it deliberately does NOT poll, because duplicated 60s
   * registry pollers are one of the things this redesign deletes. That leaves
   * one gap, and it is a real one: remote membership is mutated from the
   * RENDERER (a deregistration, a fresh registration), which the authority has
   * no way to observe. Without this edge, deregistering the preferred remote
   * left it standing as a live candidate, and Activate refused a host
   * registered a moment earlier with `unknown-host`.
   *
   * Idempotent and unscoped by design: it asserts nothing about membership -
   * only that the authority's copy is stale - so a duplicate or late call
   * costs one refetch and can never publish something false. Callers are the
   * membership mutations themselves, not surfaces reacting to them.
   */
  refreshHostFleet(): Promise<void>;

  /**
   * Subscribes to the shell's own registry reads, when the shell OWNS the
   * registry cadence (redesign P4.1/F22, connection registry §1b/§6).
   *
   * `null` means "this shell does not poll for you" and is the honest answer
   * for the browser/dev topology, which has no main process to own a cadence -
   * a consumer that gets `null` keeps its own timer. On desktop the main
   * process runs ONE `GET /api/v3/hosts` for the whole app and pushes the rows
   * here, so N windows stop meaning N timers and N requests against one
   * endpoint.
   *
   * A capability, NOT an authority surface. The payload is registry rows for
   * display; it says nothing about which host is selected and nothing about
   * whether a host is usable - leases come from transport evidence through the
   * selection authority and never from these bytes (invariant 5). Consumers
   * treat a push exactly as they treat their own completed fetch.
   *
   * `identityKey` on the payload is the account the rows were FETCHED under;
   * a consumer showing another account must drop the push rather than commit
   * it.
   */
  onRegisteredHostsChange(
    handler: (push: RegisteredHostsChange) => void,
  ): Disposable | null;

  /**
   * Tray-side host command channel forwarded from the shell tray to the
   * renderer. Present on shells that surface a native tray (desktop) and
   * `null` everywhere else. The renderer keeps a subscription mounted so
   * `openSettingsHost` / `restartHost` / `openLogs` / `installUpdate`
   * tray clicks route through the same host-management surface as Settings.
   */
  readonly hostTray: IHostTray | null;

  /**
   * OS push permission of the DEVICE running this renderer - the phone's own
   * notification switch, not anything host-scoped. Present on shells where OS
   * push exists (the native mobile shells) and `null` everywhere else
   * (desktop, dev web, tests), where the GUI hides the surface entirely.
   */
  readonly pushPermission: IPushPermissionHost | null;
}

/**
 * The three states the GUI reasons about. Deliberately platform-neutral:
 * Capacitor's fourth state (`prompt-with-rationale`, Android's "we may ask
 * once more") collapses to `prompt` at the mobile boundary, so plugin
 * vocabulary never reaches shared code.
 */
export type PushPermissionState = "prompt" | "granted" | "denied";

/**
 * Read/repair surface for the device's OS push permission, backing the
 * Settings → Notifications "this phone" row. Only reachable where
 * `IRunnerHost.pushPermission` is non-null.
 */
export interface IPushPermissionHost {
  /** Local OS read; never prompts. */
  get(): Promise<PushPermissionState>;
  /**
   * Raises the OS prompt if the OS still allows one (before the first ask, or
   * Android's single rationale retry) and resolves the resulting state. A
   * grant here also registers the device token immediately, through the same
   * narrow path a late grant from the OS Settings app takes.
   */
  request(): Promise<PushPermissionState>;
  /** Jumps to this app's notification page in the OS Settings app. */
  openSettings(): Promise<void>;
  /**
   * Fires when the state MAY have changed - a foreground resume (the person
   * may have just changed it in OS Settings) or a completed `request()`.
   * Subscribers re-read via `get()`; the signal carries no state itself.
   */
  onChange(handler: () => void): Disposable;
}

/**
 * One shell-owned registry read, delivered to a consumer that would otherwise
 * have fetched it itself. See `IRunnerHost.onRegisteredHostsChange`.
 */
export interface RegisteredHostsChange {
  /** The account these rows were FETCHED under; `null` when signed out. */
  readonly identityKey: string | null;
  readonly response: HostListResponse;
}

/** Outcome of `IRunnerHost.requestMicrophoneAccess()`. */
export type MicrophoneAccessStatus = "granted" | "denied";

export interface IFileDropHost {
  resolveDroppedFilePaths(files: readonly File[]): Promise<readonly string[]>;
  /**
   * Copy dropped source paths into a stable, app-managed temp file and return
   * the copied paths. Used for drops that expose only a `file://` URL with no
   * `File` object (e.g. the macOS screenshot thumbnail), whose source file is
   * ephemeral - the OS may reclaim it before the terminal program reads the
   * pasted path. Copying at drop time, while the source still exists, yields a
   * durable path. Implementations that cannot copy (or whose source is gone)
   * return the original path so the caller is never worse off.
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
}

/**
 * Renderer display snapshot derived from the local host publication and the
 * committed install record. Field semantics:
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
 * One attempt of the native link-login QR scan. `scanned` carries the RAW
 * decoded text — parsing it into a code (`parseLinkLoginInput`) is the
 * caller's job, so a QR that is not a Traycer payload surfaces as a visible
 * "not a link code" state rather than being silently swallowed here.
 * `permission-denied` is a first-class outcome, not an error: the surface
 * falls back to manual code entry.
 */
export type LinkCodeScanResult =
  | { readonly kind: "scanned"; readonly text: string }
  | { readonly kind: "permission-denied" }
  | { readonly kind: "canceled" }
  | { readonly kind: "error" };

/**
 * Marketing-grade device self-description ("iPhone 16 Pro", "Pixel 9").
 * Best-effort: resolves `null` when nothing better than the browser UA is
 * known, and must never throw.
 */
export interface IDeviceDescriber {
  describe(): Promise<string | null>;
}

/**
 * A native camera QR scanner. Present only on shells that physically have one
 * (`IRunnerHost.linkCodeScanner`); `scan()` owns the whole native interaction
 * including the permission prompt and the fullscreen scan UI.
 */
export interface ILinkCodeScanner {
  scan(): Promise<LinkCodeScanResult>;
}

/**
 * Link codes delivered by the OS as an app launch or open URL
 * (`IRunnerHost.linkLoginDeepLinks`).
 *
 * Two properties the in-app scanner does not need, both forced by the fact
 * that the SYSTEM camera — not the app — starts this flow:
 *
 * 1. RETENTION. A cold start delivers the URL before the GUI exists at all;
 *    the shell captures it at bootstrap and this subscription REPLAYS it. So
 *    a late subscriber still receives the code, and "the app was launched by
 *    the scan" is not a race the consumer has to win.
 * 2. ONE SUBSCRIBER. A retained code is delivered once and then consumed, so
 *    a second subscriber would either steal it or double-claim it. The GUI
 *    subscribes in exactly one place and routes from there.
 *
 * The code is already NORMALIZED and shape-checked (`parseLinkLoginInput`) —
 * unlike `LinkCodeScanResult`, which carries raw scanned text. Nothing else
 * the OS opens reaches the handler: the shell drops every URL that is not a
 * link-login payload, including the payload-free `traycer://auth/callback`
 * return link, because there is no surface to show "that wasn't a code" to
 * when the user never asked for a scan.
 *
 * DEDUPE IS THE SHELL'S JOB, AND ONLY THE SHELL'S. It alone can tell one
 * arrival announced twice by the OS from a person scanning twice, because only
 * it sees how the URL was delivered and when. Every delivery that reaches a
 * consumer is therefore one the shell has already judged intentional, and the
 * consumer must act on all of them — including a repeat of a code it has seen
 * before, which is what a deliberate rescan of a still-live QR looks like.
 */
export interface ILinkLoginDeepLinkSource {
  onLinkLoginCode(
    handler: (delivery: LinkLoginDeepLinkDelivery) => void,
  ): Disposable;
}

/**
 * One accepted arrival of a link code.
 *
 * `deliveryId` exists so a consumer can say "have I acted on THIS arrival"
 * without using the code as its own identity. The distinction is the whole
 * point: two arrivals of one code are a rescan the second time, and a
 * value-keyed guard cannot see the difference. Unique and increasing within a
 * shell's lifetime; carries no meaning beyond identity.
 */
export interface LinkLoginDeepLinkDelivery {
  readonly code: string;
  readonly deliveryId: number;
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
 * The identity block a caller supplies on interactive sign-in. `savedAt` is NOT
 * supplied here — the main-process `FileTokenStore` stamps it at write time.
 * The file carries no authn URL at all: every refresh/probe targets the
 * consuming process's own configured authn origin.
 */
export type StoredCredentialsIdentity = StoredCredentials["user"];

/**
 * Typed outcomes of the locked `rotate` op, mirrored from the credentials
 * mutation store (tech plan §2). `rotate` never returns `tombstoned` (that is a
 * guarded-first-write outcome), but the union is kept whole so callers switch
 * exhaustively:
 *   - `applied`         → the newly-committed rotated pair (adopt it);
 *   - `superseded`      → a sibling already rotated; `pair` is the file's pair to adopt;
 *   - `deleted`         → the file was signed out mid-rotate (sign-out wins);
 *   - `user-mismatch`   → the file now holds a different account (`pair` is theirs);
 *   - `lock-busy`       → a live holder held the lock; bounded retry, no state lost;
 *   - `spend-pending`   → a sibling process spent this base and is still landing
 *                         the successor; transient exactly like `lock-busy`;
 *   - `refresh-rejected`→ authn rejected the refresh; UI-only sign-out, file KEPT;
 *   - `refresh-network` → transient; the access token in hand stays valid, retry;
 *   - `commit-failed`   → spent + local-commit failed; `pair` is the minted pair
 *                         the caller keeps active while main retries the commit.
 */
export type TokenRotateOutcome =
  | "applied"
  | "superseded"
  | "deleted"
  | "user-mismatch"
  | "tombstoned"
  | "lock-busy"
  | "spend-pending"
  | "refresh-rejected"
  | "refresh-network"
  | "commit-failed";

export interface TokenRotateResult {
  readonly outcome: TokenRotateOutcome;
  // The credentials the caller should act on: the committed/adopted/minted pair
  // for `applied`/`superseded`/`user-mismatch`/`commit-failed`; `null` for the
  // outcomes that carry no pair (`deleted`/`tombstoned`/`lock-busy`/
  // `spend-pending`/`refresh-rejected`/`refresh-network`).
  readonly pair: StoredCredentials | null;
}

/**
 * A change broadcast the store emits when the underlying credentials file
 * changes (the §4 owned watcher — external writes AND self-writes). `present`
 * is whether a file now exists; `userId` is the signed-in user id (or `null`
 * when absent). `revision` is a monotonic emit counter (dedup / WindowsBridge
 * fence hint). Consumers re-read the store before acting (events are a hint,
 * disk is the truth). Reconcile never writes and never spends — a self-write
 * echo is a guarded no-op, so there is no self-write suppression.
 */
export interface TokenStoreChange {
  readonly present: boolean;
  readonly userId: string | null;
  readonly revision: number;
}

/**
 * Terminal outcome of the one-time legacy→file credentials migration (tech plan
 * §6). The renderer hands the decrypted legacy localStorage pair to the main
 * store, which reconciles it against the shared file:
 *   - `committed`              → the legacy refresh was spent under the lock and
 *                                its rotated pair now lives in the file;
 *   - `fallback-file-validated`→ the legacy refresh was dead but the file's own
 *                                access is still valid (or its refresh landed the
 *                                commit); the file session stands;
 *   - `file-wins`              → the file already holds a live, different-or-same
 *                                account; the legacy remnant is discarded;
 *   - `terminal-dead`          → the legacy refresh was explicitly rejected;
 *                                a present-but-invalid file is still left for
 *                                start() to revive on its own token;
 *   - `tombstoned`             → the file carries a sign-out tombstone; the
 *                                legacy remnant must never resurrect it;
 *   - `identity-unknown`       → the legacy access token expired AND no file to
 *                                migrate onto, so identity was unknowable without
 *                                spending; auto-migration declined (measured rare);
 *   - `retryable`              → a pre-spend failure (network/lock-busy/abort)
 *                                left the legacy pair unspent; re-migrate later;
 *   - `commit-failed`          → spent, but the local commit failed; the minted
 *                                pair is held in the store overlay and a
 *                                background continuation is still landing it.
 *
 * The file — not this value — is authoritative for the resulting session: after
 * migration the caller runs its normal file rehydrate, which itself revives a
 * stale-access file via the locked `rotate`. So `terminal-dead`/`identity-unknown`
 * only truly sign the user out when the file also cannot be revived.
 */
export type CredentialsMigrationOutcome =
  | "committed"
  | "fallback-file-validated"
  | "file-wins"
  | "terminal-dead"
  | "tombstoned"
  | "identity-unknown"
  | "retryable"
  | "commit-failed";

/**
 * Whether a completed migration should wipe the legacy localStorage token slots
 * (tech plan §6). Wiped once the legacy pair is consolidated into the file or
 * proven unusable; KEPT only while a retry could still land it — `retryable`
 * (nothing was spent; re-migrate next launch) and `commit-failed` (spent and
 * held in the store overlay; the legacy pair stays as the crash-recovery
 * fallback until the background continuation commits).
 */
export function shouldWipeLegacyCredentials(
  outcome: CredentialsMigrationOutcome,
): boolean {
  return outcome !== "retryable" && outcome !== "commit-failed";
}

/**
 * Typed credential store owned by the shell, backed by the single machine-local
 * `~/.traycer/cli/<env>/credentials` file (tech plan §3). It carries the FULL
 * identity now (the host reads `user.id` from the same file to pin its owner
 * gate), and every token *spend* happens inside the file lock via `rotate` — the
 * renderer never refreshes a token itself.
 *
 *   - `get()`      — current credentials (with the process-local commit-failed
 *                    overlay), or `null` when signed out. Rejects when the store
 *                    is unavailable (I/O fault); the caller maps that to a
 *                    UI-only signed-out state and never a write.
 *   - `signIn()`   — interactive create/replace (device-flow sign-in). Supplies
 *                    only the token pair + identity; the store stamps the rest.
 *   - `rotate()`   — the locked adopt-or-refresh+commit (the spend lives here).
 *   - `delete()`   — sign-out only. Rejects if the delete cannot land, so a
 *                    failed sign-out stays signed in rather than lie.
 *   - `subscribe()`— change notifications from the owned watcher.
 *
 * Desktop backs this with an IPC client of the main-process `FileTokenStore`;
 * in-memory implementations (dev runner, tests) keep a single round-trippable
 * slot and a no-op `subscribe`.
 */
export interface ITokenStore {
  get(): Promise<StoredCredentials | null>;
  signIn(
    tokens: StoredAuthTokens,
    identity: StoredCredentialsIdentity,
  ): Promise<void>;
  rotate(expected: {
    readonly userId: string;
    readonly token: string;
  }): Promise<TokenRotateResult>;
  delete(): Promise<void>;
  /**
   * Conditional delete for undoing a superseded sign-in's write: removes the
   * stored pair ONLY if it still holds exactly `expectedToken`, with the
   * comparison and the delete atomic at the store's own authority (the
   * main-process file lock) — never composed from `get()` + `delete()` by a
   * caller. `kept` means the store held nothing or someone else's pair.
   * Rejects when the store cannot decide or the delete cannot land.
   */
  deleteIfToken(expectedToken: string): Promise<"deleted" | "kept">;
  subscribe(listener: (change: TokenStoreChange) => void): Disposable;
  /**
   * One-time migration of the legacy per-window localStorage token pair onto the
   * shared file (tech plan §6). The renderer reads + decrypts the legacy slots
   * and hands the pair here; main single-flights the reconcile across windows and
   * never deletes the file. The caller wipes the legacy slots per
   * `shouldWipeLegacyCredentials(outcome)`, then runs its normal file rehydrate.
   */
  migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome>;
}

/**
 * What the shell's delivery decision actually did with a `show` request.
 *
 * - `presented`: an alert surface exists somewhere - an OS banner was shown,
 *   the display was relayed to the focused window, or the focused sender
 *   already owns its own in-app surfaces.
 * - `duplicate`: this delivery key was already handled app-wide; another
 *   window's request won.
 * - `undeliverable`: the platform cannot present notifications and no window
 *   is focused, so NOTHING was shown or relayed and the key is burnt. The
 *   caller is the sole owner of any fallback cue. This is a resolved outcome,
 *   not a rejection, deliberately: rejection semantics are load-bearing for
 *   retry loops (see `drainPendingNotifications`), and an unsupported
 *   platform must not retry forever.
 */
export type NotificationShowOutcome =
  "presented" | "duplicate" | "undeliverable";

/**
 * Which feed produced the notification being shown - delivery provenance,
 * carried SEPARATELY from the activation payload on purpose. The payload is
 * click routing and degrades to `null` for unrecognized/cross-kind rows, so
 * anything derived from it loses provenance exactly on the rows that need it
 * most; the foreground relay's receive-side gates key redundancy decisions
 * off this field instead.
 */
export type NotificationFeedSource = "host" | "cloud" | "app-local" | "global";

export interface INotificationHost {
  show(
    title: string,
    body: string,
    payload: unknown,
    replaceKey: string | null,
    deliveryKey: string | null,
    feedSource: NotificationFeedSource | null,
    foregroundAppLocal: NotificationForegroundAppLocal | null,
  ): Promise<NotificationShowOutcome>;
  onClick(handler: (payload: unknown) => void): Disposable;
  onForegroundDisplay(
    handler: (display: NotificationForegroundDisplay) => void,
  ): Disposable;
}

/**
 * App-local data that must cross renderer realms when another Traycer window
 * owns the foreground. `entry` stays unknown at the shell boundary; gui-app
 * validates it before merging it into the focused renderer's store.
 */
export interface NotificationForegroundAppLocal {
  readonly userId: string;
  readonly entry: unknown;
}

/** Plain-data main -> renderer relay used instead of an OS notification while
 * another Traycer window is focused. */
export interface NotificationForegroundDisplay {
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
  readonly replaceKey: string | null;
  readonly deliveryKey: string | null;
  readonly feedSource: NotificationFeedSource | null;
  readonly foregroundAppLocal: NotificationForegroundAppLocal | null;
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

export interface IWorkspaceFoldersHost {
  /**
   * Whether THIS shell can open a native OS folder dialog (desktop shells).
   * Shells without one (mobile/browser) install a no-op pickFolders and set
   * this false - gui-app then routes remote-host folder adds through the
   * RPC-backed remote folder picker instead.
   */
  readonly canPickNatively: boolean;
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
  /**
   * How well this host is answering right now - `available`, or `busy` when
   * the shell proved the process is alive but its endpoint did not answer a
   * probe in time.
   *
   * A snapshot means the host EXISTS; there is deliberately no third value for
   * "gone", because absence is carried by the snapshot being `null`. Before
   * this field that null was the shell's only vocabulary, so a live host that
   * lost one loopback probe was indistinguishable from a machine with no host
   * at all - and the renderer duly locked every chat on it read-only
   * (2026-08-11). Consumers that ask "can I dial it" must accept both values;
   * only the badge should narrow to `available`.
   */
  readonly availability: LiveHostAvailability;
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
}

/**
 * Renderer-facing mirror of `HostController`'s canonical two-lane status
 * (Host Update Layer Redesign Tech Plan, "Desktop main: HostController" >
 * "Canonical status"). Source of truth is
 * `clients/desktop/src/electron-main/host/host-controller-types.ts`; this is
 * the renderer-safe copy, following the same duplication pattern as every
 * other host-management type in this file (mirrors the NDJSON/controller
 * shape so `gui-app` never imports across the desktop-main boundary).
 */
export interface MutationProgress {
  readonly stage: string | null;
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
  readonly message: string | null;
  /**
   * Monotonic count of discrete units of work completed within this stage -
   * the CLI's `ProgressInfo.workUnits`, carried through unchanged.
   *
   * ⚠ Producers increment it only when a unit of work has COMPLETED, never on a
   * timer. The staged wait reads it to tell an advancing stage from a stalled
   * one, so a timer-driven producer would report a wedged install as healthy.
   *
   * `null` from any producer that has no discrete unit to count, and from any
   * CLI predating the field - the NDJSON parser normalises an absent numeric to
   * `null`, so an older bundled CLI degrades to the pre-field behaviour rather
   * than breaking.
   */
  readonly workUnits: number | null;
}

export type MutationKind =
  | "ensure"
  | "apply"
  | "activate"
  | "install"
  | "register"
  | "deregister"
  | "respawn"
  | "recoverIfDown"
  | "freePortAndRestart"
  | "uninstallHost"
  | "removeTraycer";

export interface MutationLaneStatus {
  readonly kind: MutationKind;
  readonly progress: MutationProgress | null;
  readonly startedAt: string;
}

export interface DownloadProgress {
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
}

export interface DownloadLaneStatus {
  readonly version: string;
  readonly progress: DownloadProgress | null;
  readonly lastError: string | null;
}

export type HostActivationState =
  "activated" | "pendingActivation" | "activationUnknown" | "unavailable";

export interface HostControllerStatus {
  readonly download: DownloadLaneStatus | null;
  readonly mutation: MutationLaneStatus | null;
  readonly installedVersion: string | null;
  readonly latestVersion: string | null;
  readonly stagedVersion: string | null;
  readonly installedRuntimeVersion: string | null;
  readonly runningRuntimeVersion: string | null;
  readonly updateReady: boolean;
  readonly activation: HostActivationState;
  readonly reachable: boolean;
  readonly removedByUser: boolean;
  readonly checkedAt: string;
}

// Pre-commit busy (CLI-owned apply/pin refused before the stop):
// `"retry-with-force"` - Force re-submits the same intent with `force`.
// Post-commit busy (packaged macOS, bytes already committed):
// `"activate"` - Force submits `activateInstalled{force}`, never a retry
// of the consumed apply/pin.
export type BusyContinuation = "retry-with-force" | "activate";

// Result of an explicit restart request (`requestHostRespawn` /
// `IHostManagement.restartHost`). `declined` is a resolved value, not an
// error: the host was deliberately NOT restarted - it denied the shutdown
// claim to protect in-progress work, was removed by the user, or another
// Traycer process holds the management lock - and the condition clears on
// its own or on a later retry. Surfaces render `declined` as plain
// information; only a rejected promise means something actually broke and
// deserves an error affordance (field RCA 2026-07-28: a busy denial inside
// the SMAppService-register fallback surfaced as a reportable error toast,
// inviting issue reports for a self-recovering condition).
export type HostRestartRequestResult =
  | { readonly kind: "restarted" }
  | { readonly kind: "declined"; readonly message: string };

// Per-intent result. Every mutation intent resolves ONE of these - the
// lane itself never rejects ("wait-never-reject"); a busy/deferred/failed
// outcome is a normal resolved value the calling surface renders.
export type MutationOutcome<TOk> =
  | { readonly kind: "ok"; readonly value: TOk }
  | {
      readonly kind: "busy";
      readonly continuation: BusyContinuation;
      readonly message: string;
    }
  | { readonly kind: "deferred"; readonly message: string }
  | { readonly kind: "stage-fingerprint-mismatch"; readonly message: string }
  | { readonly kind: "installed-not-converged"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export interface ConvergeReadyOk {
  readonly running: boolean;
  readonly version: string | null;
}

export interface ApplyStagedOk {
  readonly appliedVersion: string;
  readonly runningActivated: boolean;
}

export interface ActivateInstalledOk {
  readonly activated: boolean;
}

export interface InstallVersionOk {
  readonly installedVersion: string;
  readonly runningActivated: boolean;
}

export interface ServiceRegistrationOk {
  readonly registered: boolean;
}

export type ApplyStagedTrigger = "launch" | "manual";

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

/** Which Doctor repair to run; both are controller lifecycle intents. */
export type DoctorRepairIntent = "converge-ready" | "register-service";

/**
 * The recovery console's repairs, which QUEUE rather than refusing.
 *
 * The same four Doctor fix actions the WATCHED sheet sends through its
 * refusing dispatches — install and service-install to
 * `runDoctorRepairIfIdle`, start and restart to `restartHostIfIdle` — minus
 * the admission test. This console repairs a host that is already down, so
 * waiting behind whatever is running is the point, and a surface reachable
 * when Settings cannot render must never learn to say no.
 *
 * That exemption is about TIMING only. Identity is a separate question and is
 * enforced here exactly as it is everywhere else — the console outlives the
 * host it names, and a replacement must not inherit repairs aimed at its
 * predecessor.
 */
export type QueuedDoctorRepair =
  "converge-ready" | "register-service" | "restart";

/**
 * `declined` covers both "nothing was enqueued because this is no longer that
 * host" and the HOST's own refusal of a restart — one informational,
 * self-clearing arm, mapped in main so the renderer has no second place to get
 * the taxonomy wrong. A repair that could not run for any other reason rejects.
 */
export type QueuedDoctorRepairResult =
  | { readonly kind: "applied" }
  | { readonly kind: "declined"; readonly message: string };

/**
 * A Doctor repair's answer. `lane-busy` and `host-changed` mean NOTHING was
 * enqueued — the caller renders the message as information, the same way a
 * host's own refusal is rendered.
 */
export type DoctorRepairDispatch =
  | { readonly kind: "lane-busy"; readonly message: string }
  | { readonly kind: "host-changed"; readonly message: string }
  | { readonly kind: "dispatched"; readonly outcome: MutationOutcome<null> };

/**
 * What an atomic maintenance install submission answers.
 *
 * `lane-busy` is main's verdict that the exclusive mutation lane was already
 * occupied at submission time, so NOTHING was enqueued — the compatibility
 * lane maps it to the protocol's `already-updating`. Every other arm is the
 * controller's own per-intent outcome, unchanged and mapped as before.
 */
export type MaintenanceInstallDispatch =
  | {
      readonly kind: "lane-busy";
      /**
       * Whether the lane is occupied by UPDATE work (an install or an apply)
       * as opposed to anything else that takes the same exclusive lane — a
       * service registration, a restart, a removal, a free-port repair, or
       * the pending login-item refresh.
       *
       * The distinction is not cosmetic. The compatibility lane maps a busy
       * lane to the protocol's `already-updating`, and that answer arms the
       * caller's accepted-update latch to wait on `host.status.updateProgress`
       * — a field these pre-1.2.0 hosts do not publish, and which an unrelated
       * service cycle would never populate even if they did. Reporting a
       * service registration as "already updating" therefore both lies and
       * hangs the surface on progress that cannot arrive.
       */
      readonly updateInFlight: boolean;
      /** Main's rendered reason, for the surfaces that show one. */
      readonly message: string;
    }
  | {
      readonly kind: "dispatched";
      readonly outcome: MutationOutcome<InstallVersionOk>;
    };

/**
 * `host.doctor` as the desktop lane can honestly answer it: the CLI's issue
 * list (validated against the protocol issue schema) or the shared CLI-shell
 * failure taxonomy — but WITHOUT `triviallyGreenIssueCodes`. That field is a
 * statement about the transport the report travelled over, which the desktop
 * main process cannot see; the consumer that knows its vantage supplies the
 * set (see `doctorTriviallyGreenIssueCodesForVantage` in the protocol).
 */
export type MaintenanceDoctorProjection =
  | {
      readonly status: "ok";
      readonly issues: readonly MaintenanceDoctorIssue[];
    }
  | { readonly status: "cli-unavailable" }
  | { readonly status: "cli-failed" }
  | { readonly status: "invalid-output" };

/**
 * Renderer-facing host management surface. Each method either resolves
 * with the CLI's final NDJSON `result.data` payload (query commands), or -
 * for long-running operations - accepts an `onProgress` callback that fires
 * for every NDJSON `progress` event the CLI emits along the way.
 */
export interface IHostManagement {
  // Two-lane canonical status (Host Update Layer Redesign Tech Plan). Read
  // once on mount to prime the shared query cache; live updates arrive via
  // the desktop-only `hostControllerStatus` push bridge (see
  // `HostControllerStatusListener`) - the mutation lane pushes on every
  // progress/status change, the download lane is polled internally by the
  // desktop main process (it has no live subscription in `HostController`
  // itself; see `host-controller-status-broadcast.ts`).
  readonly getHostControllerStatus: () => Promise<HostControllerStatus>;
  // Idempotently converges the host to reachable (post-auth provisioning,
  // manual retry, Force restart). `force` skips the busy check.
  readonly convergeReady: (
    force: boolean,
  ) => Promise<MutationOutcome<ConvergeReadyOk>>;
  // Applies the currently-staged version. `trigger` distinguishes a
  // boot-time/idle-gated apply from a manual (banner/menu) click - both
  // resolve the same `MutationOutcome`, but the caller's UI treats a busy
  // outcome differently (gate progress vs. Force/Defer dialog).
  readonly applyStaged: (
    trigger: ApplyStagedTrigger,
    force: boolean,
  ) => Promise<MutationOutcome<ApplyStagedOk>>;
  // Activates an already-installed-but-not-running-activated record
  // (packaged-macOS post-commit activation, or clearing
  // pendingActivation/activationUnknown debt). `force` is the Force
  // continuation after a busy `applyStaged`/pin outcome that carried
  // `continuation: "activate"`.
  readonly activateInstalled: (
    force: boolean,
  ) => Promise<MutationOutcome<ActivateInstalledOk>>;
  // Pins an explicit version (incl. downgrades), bypassing the staged
  // update. `force` is the Force continuation after a busy outcome that
  // carried `continuation: "retry-with-force"`.
  readonly installVersion: (
    pin: string,
    force: boolean,
  ) => Promise<MutationOutcome<InstallVersionOk>>;
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
  // Explicit "restart the host now" (Settings / tray). Same contract as
  // `IRunnerHost.requestHostRespawn`: resolves `declined` when the host
  // was deliberately not restarted; rejects only on genuine failures.
  readonly restartHost: () => Promise<HostRestartRequestResult>;
  /**
   * This machine's host log.
   *
   * Carries `expectedHostId` for the same reason the maintenance block below
   * does, and it is the one READ in that set: the log is host-scoped content
   * rendered under a named host, so when local host A is replaced by B while
   * A's Doctor report is still on screen, an unfenced read puts B's log —
   * paths, ports, workspace names — under A's name. Main compares against the
   * live local identity and refuses a mismatch.
   *
   * An EMPTY string is the fail-CLOSED value, not an opt-out: it matches no
   * host that can name itself, so it is refused everywhere except a legacy
   * install with no identity machinery at all — exactly the population where
   * there is no second host to confuse this one with.
   */
  readonly getHostLogs: (input: {
    readonly tailLines: number;
    readonly expectedHostId: string;
  }) => Promise<HostLogsTailResult>;
  /**
   * This machine's Doctor report.
   *
   * Fenced for the same reason `getHostLogs` is: the report is host-scoped
   * content rendered under a named host, and its issues carry the port and pid
   * numbers the repairs then act on. A report produced for a replacement host
   * but shown under its predecessor hands someone another machine's repair
   * inputs.
   */
  readonly runDoctor: (input: {
    readonly expectedHostId: string;
  }) => Promise<HostDoctorReport>;
  readonly availableVersions: (
    input: HostAvailableVersionsInput,
  ) => Promise<HostAvailableSnapshot>;
  readonly installedRecord: () => Promise<HostInstalledRecord | null>;
  readonly registerService: () => Promise<
    MutationOutcome<ServiceRegistrationOk>
  >;
  readonly deregisterService: () => Promise<void>;
  // Forces (or, on cache hit, reuses) a network registry probe -
  // "Check now"/"Retry" on Settings → Host's Updates row. Distinct from
  // `getHostControllerStatus`: this hits the network and reports
  // probe-specific reachability/error state; it does not gate any
  // surface's visibility (that's `HostControllerStatus.updateReady` /
  // `.activation` now - "quiet until ready", Tech Plan D5).
  readonly registryCheck: (input: {
    readonly force: boolean;
  }) => Promise<HostRegistryUpdateState>;
  /**
   * Kill the process holding the host's port and restart it, QUEUEING behind
   * whatever the lane is running. The down-host recovery console's route: it
   * repairs a host that is already not answering, where waiting is the point.
   *
   * Fenced on identity even though it queues. The consent this carries out
   * was given for a SPECIFIC host's port and pid, and those numbers describe
   * the machine as the report saw it - running them against a replacement
   * kills whatever now holds that port. The lane exemption is about WHEN the
   * repair may run, not about WHICH host it may run against.
   */
  readonly freePortAndRestart: (
    input: FreePortAndRestartInput & { readonly expectedHostId: string },
  ) => Promise<FreePortAndRestartInput>;
  /**
   * The refusing twin, for the Doctor sheet a person is WATCHING.
   *
   * Same reasoning as `restartHostIfIdle` and `runDoctorRepairIfIdle`: the
   * renderer's own gate can only see what it last rendered, so a lifecycle
   * write that arms in main after that snapshot still lets a confirm through,
   * and this repair QUEUES rather than refusing - the kill then lands after
   * the competing write, against a host in a state nobody approved. Main
   * tests the lane and submits with no await between.
   */
  readonly freePortAndRestartIfIdle: (
    input: FreePortAndRestartInput & { readonly expectedHostId: string },
  ) => Promise<DoctorRepairDispatch>;
  readonly cliManifest: () => Promise<CliInstallManifestSnapshot | null>;
  // The four `maintenance*` members below serve ONE consumer: the GUI's
  // local-maintenance fallback, which answers the v1.2.0 `host.*` maintenance
  // RPCs over this bridge for a LOCAL host too old to have them (≤ 1.1.11 —
  // a frozen population; delete these when the supported fleet floor reaches
  // the maintenance-RPC host version). Unlike the query members above, they
  // return PROTOCOL response shapes: the desktop main process projects the
  // same CLI JSON / on-disk records the host's own resolvers project, and it
  // classifies CLI failures into the wire taxonomy there because an Electron
  // invoke rejection loses its error shape crossing the boundary — the
  // renderer could no longer tell "no CLI" from "CLI crashed".
  //
  // EVERY member below carries `expectedHostId`: the host the caller believes
  // is local. These operate on "this machine's host" implicitly, so without it
  // a request aimed at host A silently lands on its replacement B — the local
  // identity can change under a scope that froze A's id, and an id nothing
  // checks is worse than no id at all. Main compares against the live local
  // identity and refuses a mismatch.
  /** `host.update.check`'s answer from this machine's bundled CLI. */
  readonly maintenanceUpdateCheck: (
    input: HostAvailableVersionsInput & { readonly expectedHostId: string },
  ) => Promise<HostUpdateCheckResponse>;
  /** `host.doctor`'s answer, minus the caller-owned transport vantage. */
  readonly maintenanceDoctor: (input: {
    readonly expectedHostId: string;
  }) => Promise<MaintenanceDoctorProjection>;
  /** `host.getInstallationInfo`'s answer from the shared on-disk records. */
  readonly maintenanceInstallationInfo: (input: {
    readonly expectedHostId: string;
  }) => Promise<HostGetInstallationInfoResponse>;
  /**
   * `host.update.install`'s dispatch, refused when the mutation lane is
   * already occupied.
   *
   * Distinct from {@link installVersion} because the REFUSAL has to be atomic
   * with the submission. The lane is exclusive but it does not reject a
   * distinct intent — it QUEUES it — so a renderer that reads
   * `getHostControllerStatus` and then submits has a window in which the
   * banner, the tray or the background reconciler can take the lane, and its
   * install lands right after that one finishes (retargeting, possibly
   * downgrading, a host nobody asked to move). Main tests the lane and
   * submits in one synchronous stretch, which is what closes it.
   *
   * `installVersion` keeps its queueing semantics for the surfaces that want
   * them; only the compatibility lane, whose caller has no other way to see
   * the refusal, takes this one.
   */
  readonly maintenanceInstallVersion: (input: {
    readonly version: string;
    readonly force: boolean;
    readonly expectedHostId: string;
  }) => Promise<MaintenanceInstallDispatch>;
  /**
   * Respawn the local host, REFUSED (not queued) when the desktop's exclusive
   * mutation lane already owns an intent.
   *
   * `restartHost` queues behind whatever is running, and stays that way for
   * the tray and menu deliberately — those are RECOVERY surfaces, the ones
   * still reachable when Settings cannot render, so they must never learn to
   * say no (they confirm first, exactly like Settings does). Queueing IS
   * wrong for a Settings restart the person is watching: by the time an
   * install or service cycle finishes, the kill they authorised is aimed at a
   * host in a different state, and the update they were waiting for has
   * already restarted it once. Force overrides the HOST's veto (busy work, a
   * live claim); it was never meant to override the desktop's own
   * serialization.
   *
   * A lane refusal arrives as `declined` with a message, the same arm a host's
   * own refusal uses — informational, self-clearing, retryable.
   */
  readonly restartHostIfIdle: (input: {
    readonly expectedHostId: string;
  }) => Promise<HostRestartRequestResult>;
  /**
   * The down-host recovery console's four lifecycle repairs, identity-fenced
   * and QUEUEING. See {@link QueuedDoctorRepair} for why those two properties
   * belong together rather than being traded off.
   */
  readonly runDoctorRepairQueued: (input: {
    readonly repair: QueuedDoctorRepair;
    readonly expectedHostId: string;
  }) => Promise<QueuedDoctorRepairResult>;
  /**
   * The WATCHED Doctor sheet's two lifecycle repairs, refused when the
   * exclusive lane is occupied or this machine's host is no longer the
   * expected one.
   *
   * `convergeReady` converges to LATEST and `registerService` adds a service
   * cycle; both QUEUE behind a running intent rather than being refused, so a
   * repair clicked during a pinned install would otherwise land after it and
   * override the version the person actually chose. That sheet's start/restart
   * take `restartHostIfIdle` above, not this method; the down-host console
   * keeps the queueing path for all four via `runDoctorRepairQueued`.
   */
  readonly runDoctorRepairIfIdle: (input: {
    readonly repair: DoctorRepairIntent;
    readonly expectedHostId: string;
  }) => Promise<DoctorRepairDispatch>;
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
