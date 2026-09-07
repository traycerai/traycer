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
  HostUpdateCheckResponseV11,
} from "@traycer/protocol/host/maintenance/index";
import type {
  HostUpdateAttemptContinuation,
  HostUpdateAttemptPhase,
} from "@traycer/protocol/config/host-update-attempt";
import type { BrowserViewBridge } from "./browser-view";

export type { StoredCredentials } from "@traycer/protocol/config/credentials";

export type SystemResumeEvent = {
  /** `null` keeps the conservative desktop-calibrated behavior. */
  readonly backgroundedForMs: number | null;
};

/**
 * Composite runner-host surface consumed by `gui-app` on standalone desktop and mobile shells.
 * `IRunnerHost` intentionally stays platform-agnostic: the shared module must not import Electron or Capacitor types.
 */
export interface IRunnerHost {
  /** Complete native browser capability, or null on shells without one. */
  readonly browserView: BrowserViewBridge | null;

  /**
   * Browser-safe sign-in URL the shell wants `gui-app` to open when the user initiates auth.
   * Shells embed their own callback scheme (custom protocol on desktop, universal link on mobile), so the URL is shell-owned and read-only here.
   */
  readonly signInUrl: string;

  /** Browser-safe base URL for the AuthnV3 service. */
  readonly authnBaseUrl: string;

  /**
   * Browser-safe WebSocket attach endpoint for the Remote Host Support relay (Architecture §3/§4b, S2/T14), e.g. `wss://relay.traycer.ai/attach`.
   */
  readonly relayBaseUrl: string;

  /**
   * Validates a Traycer bearer token and returns the full AuthnV3 identity shape required to mint a client `RequestContext`.
   * Desktop shells perform this in Electron main so renderer csp/cors cannot turn a valid OAuth callback into a false invalid-token result.
   */
  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult>;

  /**
   * Fetches the signed-in user's host registry + live status from authn-v3's `get /api/v3/hosts` with the user bearer (Remote Host Support §7).
   * Desktop shells run this in Electron main so renderer-origin cors does not block the request - authn-v3's cors allow-list is the web dashboard origin, not the app renderer - exactly as the token-validation calls above do.
   */
  listRegisteredHosts(bearerToken: string): Promise<HostListFetchResult>;

  /**
   * Fetches the signed-in user's account sessions from authn-v3.
   * Transport failures collapse into the result rather than throwing; a cancellation via `signal` is the one case that may reject.
   */
  listUserSessions(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<ListUserSessionsFetchResult>;

  /**
   * Revokes one session family.
   * Renderer callers never pass the raw step-up bearer.
   */
  revokeUserSession(
    bearerToken: string,
    familyId: string,
    useStepUpCredential: boolean,
  ): Promise<RevokeUserSessionFetchResult>;

  /** Revokes all other sessions and broadcasts host/session invalidation. */
  revokeAllSessions(bearerToken: string): Promise<RevokeAllSessionsFetchResult>;

  /**
   * Mints a device credential for a connected host, so the host can keep working on the user's behalf after this client disconnects.
   * They necessarily cross back into the renderer, because the stream socket that must carry them to the host lives there.
   */
  mintHostCredential(
    bearerToken: string,
    request: MintHostCredentialRequest,
  ): Promise<MintHostCredentialFetchResult>;

  requestStepUpChallenge(
    bearerToken: string,
  ): Promise<StepUpChallengeFetchResult>;

  /**
   * Mints a one-time link-login code under the user bearer - the "Link mobile app" QR surface.
   * The result carries the raw code back into the renderer by necessity: the QR that must display it renders there.
   */
  mintLinkLoginCode(
    bearerToken: string,
    signal: AbortSignal,
  ): Promise<MintLinkLoginCodeFetchResult>;

  /**
   * The minting surface's view of its own code - whether a phone has claimed it, and the server-observed claimant metadata for the confirmation prompt.
   * Owner-only on the server.
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
   * Native QR scanner for the link-login sign-in path, or `null` where no camera scanner exists (desktop, plain browser, tests).
   */
  readonly linkCodeScanner: ILinkCodeScanner | null;

  /**
   * Self-description of the device for human-facing prompts - the link-login approver card and the session row.
   * Present only where the shell knows something better than the browser UA (the mobile app reads the hardware model natively); `null` elsewhere, and consumers fall back to `navigator.userAgent`.
   */
  readonly deviceDescriber: IDeviceDescriber | null;

  /**
   * Link-login codes the OS handed this shell as a launch/open URL - a QR scanned by the system camera rather than by the in-app scanner.
   * `null` wherever the OS never delivers one (desktop, plain browser, tests).
   */
  readonly linkLoginDeepLinks: ILinkLoginDeepLinkSource | null;

  /**
   * Verifies a step-up otp and retains the short-ttl bearer credential inside the runner-host boundary.
   * Returns only expiry metadata for renderer batch window logic.
   */
  verifyStepUpChallenge(
    bearerToken: string,
    code: string,
  ): Promise<RetainedStepUpVerifyFetchResult>;

  /**
   * Desktop shells run this in Electron main for the same cors reason as `listRegisteredHosts`; browser/dev shells may call the shared `updateHostVersionPolicyViaHttp` helper directly.
   * Never throws: transport failures collapse into the discriminated result.
   */
  updateHostVersionPolicy(
    bearerToken: string,
    hostId: string,
    input: UpdateHostVersionPolicyInput,
  ): Promise<UpdateHostVersionPolicyFetchResult>;

  /**
   * "Remove from account" - `post /api/v3/hosts/:hostId/deregister` with the user bearer.
   * Never throws: transport failures collapse into the discriminated result.
   */
  deregisterHostFromAccount(
    bearerToken: string,
    hostId: string,
  ): Promise<DeregisterHostFetchResult>;

  openExternalLink(url: string): Promise<void>;

  /**
   * The query is by scheme only: it never matches an application name or bundle path, so a renamed or relocated install is still detected as long as it still registers its scheme.
   */
  getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]>;

  /**
   * Ensures OS microphone access before voice capture.
   * On macOS this triggers the native permission prompt when the status is undetermined, and returns the existing decision otherwise (macOS never re-prompts a denied app - the caller then routes to `openMicrophoneSettings`).
   */
  requestMicrophoneAccess(): Promise<MicrophoneAccessStatus>;

  /**
   * Opens the OS Privacy → Microphone settings pane so the user can re-grant mic access (used by the voice-input "denied" affordance).
   * Desktop opens the native pane; shells without a settings deep link (mobile/web/tests) implement this as a resolved no-op.
   */
  openMicrophoneSettings(): Promise<void>;

  /**
   * Opens the macOS Privacy → Full Disk Access pane, where the login import sends a user whose Safari jar the OS refused to let Traycer read.
   * A dedicated method rather than an `openExternalLink(...)` of the pane's `x-apple.systempreferences:` URL, which the desktop's http(s)-only link gate would refuse silently.
   */
  openFullDiskAccessSettings(): Promise<void>;

  /**
   * Called by the gui auth controller immediately before `openExternalLink(...)`.
   * After this signal, every subsequent `appUrlOpen` (or equivalent shell-delivered callback event) is unambiguously part of the new attempt.
   */
  beginAuthAttempt(): void;

  /**
   * Subscribes to the browser-return signal the shell delivers when the user comes back from the device-approval browser tab (the `traycer://` deep link on desktop).
   * The token always arrives through the device-flow poll (`IDeviceFlowHost`), never here, and sign-in still completes poll-only if this never fires.
   */
  onAuthCallback(handler: () => void): Disposable;

  /**
   * OAuth 2.0 Device Authorization Grant (rfc 8628) controller, owned by the shell's privileged process.
   * Always present; callers never branch on `null`.
   */
  readonly deviceFlow: IDeviceFlowHost;

  readonly secureStorage: ISecureStorage;
  readonly notifications: INotificationHost;
  readonly tray: ITrayState;
  readonly workspaceFolders: IWorkspaceFoldersHost;
  readonly fileDrops: IFileDropHost;
  /**
   * How this shell commits a blob the user asked to keep, or `null` where it owns no native route and the caller falls back to the browser save APIs.
   * A capability, not an identity: a plain desktop browser tab is `null` here without being any less of a desktop.
   */
  readonly fileSave: IFileSaveHost | null;
  /**
   * Desktop display-zoom surface. Present on desktop shells and `null` on
   * shells that do not own a native app-scale control.
   */
  readonly zoom: IZoomHost | null;

  /**
   * Typed token-storage capability shared across shells.
   * Callers never branch on `null`.
   */
  readonly tokenStore: ITokenStore;

  /** Declares whether this shell actually exposes a local-host stream. */
  readonly hasLocalHost: boolean;

  /**
   * Whether an image written through the web clipboard API on this shell actually reaches the system clipboard.
   * Nothing rejects, so a surface cannot learn this by trying.
   */
  readonly canCopyImages: boolean;

  /**
   * Subscribes to local-host snapshot changes.
   * Mobile shells emit a single `null` snapshot on subscribe and never transition.
   */
  onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable;

  /**
   * The `hostId` this machine's local host most recently published, read from durable host metadata rather than from a live connection - so it still answers while the host is stopped, restarting, or unreachable.
   * Without this, a shell cannot tell "another machine" from "my own host, currently down" in exactly the window where it matters.
   */
  getLastKnownLocalHostId(): Promise<string | null>;

  /** Subscribes to OS wake events (device resume / screen unlock). */
  onSystemResumed(handler: (event: SystemResumeEvent) => void): Disposable;

  /**
   * Subscribes to network-path changes the shell can observe natively: connectivity coming back, or the interface type changing under live connectivity (Wi-Fi -> cellular).
   * Both are moments an existing socket is dead or about to behave like it, without any DOM `online` event firing - the network never went "offline", it moved.
   */
  onNetworkPathChanged(handler: () => void): Disposable;

  /**
   * Asks the shell to re-spawn its detached local host.
   * Desktop delegates to `HostLifecycle.respawn()` via the preload IPC bridge; mobile shells (and any shell without a local host) implement this as a resolved `restarted` no-op.
   */
  requestHostRespawn(): Promise<HostRestartRequestResult>;

  /**
   * OS-service control surface used by the Service Health settings pane.
   * Callers branch once on `null` to gate the UI.
   */
  readonly service: IServiceHost | null;

  /** Surface to the local `traycer` CLI subprocess. */
  readonly traycerCli: ITraycerCli | null;

  /** Cross-window migration-run channel. */
  readonly migration: IMigrationHost | null;

  /**
   * Host-management surface for the local Traycer host.
   * Backed by ndjson subcommand invocations against the `traycer` CLI subprocess on desktop; `null` on shells that don't ship the CLI (mobile, web).
   */
  readonly hostManagement: IHostManagement | null;

  /**
   * Consumers do not talk to it directly; they go through the window's `SelectionEvidenceKernel`, which owns the attach choreography and the live-session inventory.
   */
  readonly selectionAuthority: SelectionAuthorityClient;

  /**
   * The authority refreshes its fleet on identity change, local-host change and startup; it deliberately does not poll, because duplicated 60s registry pollers are one of the things this redesign deletes.
   * Without this edge, deregistering the preferred remote left it standing as a live candidate, and Activate refused a host registered a moment earlier with `unknown-host`.
   */
  refreshHostFleet(): Promise<void>;

  /**
   * Subscribes to the shell's own registry reads, when the shell owns the registry cadence (redesign P4.1/F22, connection registry §1b/§6).
   * `identityKey` on the payload is the account the rows were fetched under; a consumer showing another account must drop the push rather than commit it.
   */
  onRegisteredHostsChange(
    handler: (push: RegisteredHostsChange) => void,
  ): Disposable | null;

  /** Tray-side host command channel forwarded from the shell tray to the renderer. */
  readonly hostTray: IHostTray | null;

  /**
   * OS push permission of the device running this renderer - the phone's own notification switch, not anything host-scoped.
   */
  readonly pushPermission: IPushPermissionHost | null;

  /**
   * The OS "back" request - Android's hardware key and its system back gesture, which the OS delivers as one event and which never reach the WebView as a touch.
   * The shell's only other contribution is `minimize`, for a press with nothing left to go back to: the platform's answer is to step out of the way, not to sit on a press that visibly did nothing.
   */
  readonly systemBack: ISystemBackHost | null;
}

export interface ISystemBackHost {
  /** Fires once per OS back request; carries nothing. */
  onBack(handler: () => void): Disposable;
  /** Sends the app to the background, leaving it warm for the next resume. */
  minimize(): Promise<void>;
}

/**
 * The three states the gui reasons about.
 * Deliberately platform-neutral: Capacitor's fourth state (`prompt-with-rationale`, Android's "we may ask once more") collapses to `prompt` at the mobile boundary, so plugin vocabulary never reaches shared code.
 */
export type PushPermissionState = "prompt" | "granted" | "denied";

/**
 * Read/repair surface for the device's OS push permission, backing the Settings → Notifications "this phone" row.
 * Only reachable where `IRunnerHost.pushPermission` is non-null.
 */
export interface IPushPermissionHost {
  /** Local OS read; never prompts. */
  get(): Promise<PushPermissionState>;
  /**
   * Raises the OS prompt if the OS still allows one (before the first ask, or Android's single rationale retry) and resolves the resulting state.
   */
  request(): Promise<PushPermissionState>;
  /** Jumps to this app's notification page in the OS Settings app. */
  openSettings(): Promise<void>;
  /**
   * Fires when the state may have changed - a foreground resume (the person may have just changed it in OS Settings) or a completed `request()`.
   */
  onChange(handler: () => void): Disposable;
}

/**
 * One shell-owned registry read, delivered to a consumer that would otherwise
 * have fetched it itself. See `IRunnerHost.onRegisteredHostsChange`.
 */
export interface RegisteredHostsChange {
  /** The account these rows were fetched under; `null` when signed out. */
  readonly identityKey: string | null;
  readonly response: HostListResponse;
}

export type MicrophoneAccessStatus = "granted" | "denied";

export interface IFileDropHost {
  resolveDroppedFilePaths(files: readonly File[]): Promise<readonly string[]>;
  /**
   * Copy dropped source paths into a stable, app-managed temp file and return the copied paths.
   * Used for drops that expose only a `file://` URL with no `File` object (e.g. the macOS screenshot thumbnail), whose source file is ephemeral - the OS may reclaim it before the terminal program reads the pasted path.
   */
  copyDroppedFilePaths(paths: readonly string[]): Promise<readonly string[]>;
  /**
   * Reads file paths from the native clipboard formats that Chromium does not surface through `ClipboardEvent`.
   * Callers only use this from a direct paste event whose DOM clipboard has no usable content.
   */
  readNativeClipboardFilePaths(): Promise<readonly string[]>;
}

export interface FileSaveRequest {
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

export interface SavedFileLocation {
  readonly name: string;
  readonly path: string | null;
}

export interface IFileSaveHost {
  /** `null` when the user dismissed the dialog or sheet without saving. */
  saveFile(request: FileSaveRequest): Promise<SavedFileLocation | null>;
  /**
   * Re-opens a file this shell saved, by the `path` it reported, with the OS default application.
   * `null` where the shell never learns a path, which is also every case where `saveFile` reports `path: null`.
   */
  readonly openSavedFile: ((path: string) => Promise<void>) | null;
  /**
   * Writes the bytes straight into the device's own file storage, with no chooser, sheet or dialog in between - what a phone user means by "download".
   */
  readonly downloadFile:
    | ((request: FileSaveRequest) => Promise<SavedFileLocation>)
    | null;
  /**
   * What {@link saveFile} does, from the user's point of view: `"download"` where it commits the file itself (a desktop save dialog), `"share"` where it hands the bytes to an OS chooser and another app decides.
   */
  readonly saveRoute: "download" | "share";
}

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
 * Renderer-facing view of `traycer host status` output.
 * Lines that aren't structured markers (raw host stdout captured into the same file) are filtered out by the CLI.
 */
export interface TraycerHostStatusSnapshot {
  readonly running: boolean;
  readonly pidMetadata: TraycerPidMetadata | null;
  readonly bootstrapMarkers: readonly BootstrapMarkerEntry[];
  readonly bootstrapLogPath: string;
  /**
   * Last ~80 lines of `~/.traycer/bootstrap.log` verbatim - includes both structured markers and raw shell stdout/stderr captured into the same file.
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
  | "starting"
  | "exited"
  | "crashed"
  | "killed"
  | "failed-to-spawn";

export interface BootstrapMarkerEntry {
  readonly timestamp: string;
  readonly phase: BootstrapPhase;
  readonly fields: Readonly<Partial<Record<string, string>>>;
}

export interface TraycerShellConfig {
  readonly path: string;
  readonly args: readonly string[];
  readonly synthesised: boolean;
}

/**
 * An entry in the Settings → Shell picker list: a detected shell binary or a user-added program.
 * `missing` is `true` only for an `"added"` row whose file is gone (a list-time probe, never persisted), so the UI can flag a customised-but-uninstalled shell while keeping its ✕; detected rows are always `false`.
 */
export interface TraycerDetectedShell {
  readonly name: string;
  readonly path: string;
  readonly isDefault: boolean;
  readonly source: "detected" | "added";
  readonly missing: boolean;
  /** Mirrors `DetectedShell.wslHealth`; absent from CLIs predating the probe. */
  readonly wslHealth?: "not-installed" | "no-distro";
}

/**
 * Result of probing a candidate shell path (Settings → Shell "Add a shell" live validation).
 * The desktop shell answers this natively (fs access in Electron main), mirroring the protocol's detection check rather than spawning the CLI per keystroke.
 */
export interface TraycerShellProbeResult {
  readonly exists: boolean;
  readonly executable: boolean;
}

// Host-process env overrides (Settings → Shell), applied to the local host at its next start.
export interface TraycerEnvOverride {
  readonly key: string;
  readonly value: string | null;
}

export interface TraycerShellConfigSetInput {
  /** New shell path; null preserves the stored value (or default). */
  readonly path: string | null;
  /**
   * Ordered shell flags.
   * `null` preserves the stored value (or falls back to the synthesised default); `[]` writes an explicit empty list - passed straight through as a native `string[]` rather than JSON-encoded text.
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
   * The backend re-validates it is absolute + executable and rejects otherwise, so callers should gate on {@link shellProbe} first for a clean UX.
   */
  shellConfigAdd(input: { readonly path: string }): Promise<void>;
  /**
   * Forgets a previously-added program (`config shell remove`).
   * Removing a path that was never added is a no-op success.
   */
  shellConfigRemove(input: { readonly path: string }): Promise<void>;
  /**
   * Restores a remembered shell's flags to its family default (`config shell revert-args`) by clearing its stored deviation while keeping the shell remembered.
   */
  shellRevertArgs(input: { readonly path: string }): Promise<void>;
  /**
   * Native (non-subprocess) existence + executability probe backing the picker's live "Add a shell" validation.
   */
  shellProbe(input: {
    readonly path: string;
  }): Promise<TraycerShellProbeResult>;
  /**
   * Opens the shell's native "choose a program file" dialog, resolving the chosen absolute path or `null` on cancel.
   * `null` (not a method) on shells with no native file dialog - the picker hides its Browse affordance then.
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
   * Linux-only. Calls `loginctl enable-linger $user` so the systemd-user
   * instance starts before any interactive login. Throws on non-Linux.
   */
  enableLinger(): Promise<void>;
  /**
   * Reads the last `maxLines` lines of the host's log file. Returns
   * `null` when the log file is missing or unreadable.
   */
  getLogTail(maxLines: number): Promise<string | null>;
}

export type LinkCodeScanResult =
  | { readonly kind: "scanned"; readonly text: string }
  | { readonly kind: "permission-denied" }
  | { readonly kind: "canceled" }
  | { readonly kind: "error" };

  /**
   * Marketing-grade device self-description ("iPhone 16 Pro", "Pixel 9").
   * Best-effort: resolves `null` when nothing better than the browser UA is known, and must never throw.
   */
export interface IDeviceDescriber {
  describe(): Promise<string | null>;
}

/**
 * A native camera QR scanner.
 * Present only on shells that physically have one (`IRunnerHost.linkCodeScanner`); `scan()` owns the whole native interaction including the permission prompt and the fullscreen scan UI.
 */
export interface ILinkCodeScanner {
  scan(): Promise<LinkCodeScanResult>;
}

/**
 * Link codes delivered by the OS as an app launch or open URL (`IRunnerHost.linkLoginDeepLinks`).
 * Two properties the in-app scanner does not need, both forced by the fact that the system camera - not the app - starts this flow: 1.
 */
export interface ILinkLoginDeepLinkSource {
  onLinkLoginCode(
    handler: (delivery: LinkLoginDeepLinkDelivery) => void,
  ): Disposable;
}

/**
 * One accepted arrival of a link code.
 * `deliveryId` exists so a consumer can say "have I acted on this arrival" without using the code as its own identity.
 */
export interface LinkLoginDeepLinkDelivery {
  readonly code: string;
  readonly deliveryId: number;
}

export interface DeviceFlowAuthorization {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

/**
 * Terminal outcome of a device-flow attempt, emitted once by the shell's controller after its poll loop settles: - `authorized` carries the minted `{ token, refreshToken }` pair.
 * - `expired` the device_code ttl elapsed before approval.
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
   * Handle to a single in-flight device-flow attempt.
   * `onResult` fires exactly once with the terminal `DeviceFlowResult`; implementations replay a result that settled before the subscription so a fast poll can't be missed.
   */
export interface DeviceFlowSession {
  readonly authorization: DeviceFlowAuthorization;
  onResult(handler: (result: DeviceFlowResult) => void): Disposable;
  /**
   * Nudges the shell-side poll loop to dispatch a `/device/token` poll immediately (collapsing the remaining interval wait).
   * Best-effort and idempotent: it never delivers a token itself - the result still arrives through `onResult` - and is a no-op once the attempt has settled.
   */
  pollNow(): void;
  cancel(): void;
}

export interface IDeviceFlowHost {
  /**
   * Starts a device-authorization attempt: the shell runs `/device/authorize` and immediately begins the `/device/token` poll loop in its privileged process.
   */
  start(): Promise<DeviceFlowSession | null>;
}

export type AuthTokenRefreshResult =
  | {
      readonly kind: "refreshed";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" };

  /**
   * Opaque string slots.
   * `get` returns exactly the string `set` was handed, or `null` only when nothing is stored - a value must never read as absent.
   */
export interface ISecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The auth credential persisted per shell: the jws bearer (`token`) plus the separately-delivered `refreshToken`.
 * Post raw-jws cutover these are two distinct strings (no aes "combined token"); both must be stored so refresh (`post /api/v3/auth/refresh`, which requires `refreshToken` in the body) works.
 */
export interface StoredAuthTokens {
  readonly token: string;
  readonly refreshToken: string;
}

export type StoredCredentialsIdentity = StoredCredentials["user"];

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
  readonly pair: StoredCredentials | null;
}

/**
 * A change broadcast the store emits when the underlying credentials file changes (the §4 owned watcher - external writes and self-writes).
 * `revision` is a monotonic emit counter (dedup / WindowsBridge fence hint).
 */
export interface TokenStoreChange {
  readonly present: boolean;
  readonly userId: string | null;
  readonly revision: number;
}

/**
 * Terminal outcome of the one-time legacy→file credentials migration (tech plan §6).
 * The file - not this value - is authoritative for the resulting session: after migration the caller runs its normal file rehydrate, which itself revives a stale-access file via the locked `rotate`.
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

export function shouldWipeLegacyCredentials(
  outcome: CredentialsMigrationOutcome,
): boolean {
  return outcome !== "retryable" && outcome !== "commit-failed";
}

/**
 * Typed credential store owned by the shell, backed by the single machine-local `~/.traycer/cli/<env>/credentials` file (tech plan §3).
 * It carries the full identity now (the host reads `user.id` from the same file to pin its owner gate), and every token *spend* happens inside the file lock via `rotate` - the renderer never refreshes a token itself.
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
   * `kept` means the store held nothing or someone else's pair.
   * Rejects when the store cannot decide or the delete cannot land.
   */
  deleteIfToken(expectedToken: string): Promise<"deleted" | "kept">;
  subscribe(listener: (change: TokenStoreChange) => void): Disposable;
  /**
   * One-time migration of the legacy per-window localStorage token pair onto the shared file (tech plan §6).
   * The renderer reads + decrypts the legacy slots and hands the pair here; main single-flights the reconcile across windows and never deletes the file.
   */
  migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome>;
}

/**
 * What the shell's delivery decision actually did with a `show` request.
 * - `undeliverable`: the platform cannot present notifications and no window is focused, so nothing was shown or relayed and the key is burnt.
 */
export type NotificationShowOutcome =
  | "presented"
  | "duplicate"
  | "undeliverable";

export type NotificationFeedSource = "host" | "cloud" | "app-local" | "global";

export interface INotificationHost {
  /** Native OS notification preferences for this desktop app. */
  readonly systemSettings: INotificationSystemSettingsHost | null;
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

export interface INotificationSystemSettingsHost {
  /** Opens the OS notification preferences owned by this application. */
  open(): Promise<void>;
}

/**
 * App-local data that must cross renderer realms when another Traycer window owns the foreground.
 * `entry` stays unknown at the shell boundary; gui-app validates it before merging it into the focused renderer's store.
 */
export interface NotificationForegroundAppLocal {
  readonly userId: string;
  readonly entry: unknown;
}

/** Plain-data main -> renderer relay used instead of an OS notification while
 */
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

export interface TrayEpic {
  readonly epicId: string;
  readonly title: string;
  readonly subtitle: string;
}

export interface IWorkspaceFoldersHost {
  /**
   * Whether this shell can open a native OS folder dialog (desktop shells).
   * Shells without one (mobile/browser) install a no-op pickFolders and set this false - gui-app then routes remote-host folder adds through the RPC-backed remote folder picker instead.
   */
  readonly canPickNatively: boolean;
  pickFolders(): Promise<readonly string[]>;
}

/**
 * Metadata the desktop runner publishes once the bundled host is running.
 * After the T4 WS-only cutover the host no longer exposes an HTTP endpoint - `WsRpcClient` dials `websocketUrl` directly for every request.
 */
export interface LocalHostSnapshot {
  readonly hostId: string;
  readonly websocketUrl: string;
  readonly version: string;
  readonly pid: number;
  readonly systemHostName: string;
  readonly displayName: string;
  /**
   * How well this host is answering right now - `available`, or `busy` when the shell proved the process is alive but its endpoint did not answer a probe in time.
   * Consumers that ask "can I dial it" must accept both values; only the badge should narrow to `available`.
   */
  readonly availability: LiveHostAvailability;
}

/**
 * Host-management types crossing the shell↔renderer boundary.
 * Renderer-facing copy of `clients/desktop/src/ ipc-contracts/host-management-types.ts` so `gui-app` can import the shapes from the platform contract instead of reaching across into the desktop workspace.
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
      | "running"
      | "stopped"
      | "not-installed"
      | "externally-managed";
    readonly stoppedBeforeSwap: boolean;
    readonly postSwapAction: "install" | "restart" | "start" | "none";
    readonly postSwapError: string | null;
  };
}

// Result of the post-auth `ensureHost` provisioning call.
export interface HostEnsureResult {
  readonly action: "already-ready" | "provisioned" | "host-busy" | "removed";
  readonly running: boolean;
  readonly version: string | null;
}

// Whether the user has uninstalled Traycer's background components from this device via Settings → General → Danger Zone.
export interface HostRemovalState {
  readonly removedByUser: boolean;
}

// Result of the in-app "Remove Traycer" action.
export interface TraycerUninstallResult {
  readonly removedHost: boolean;
  /**
   * The deregistration was performed and nothing contradicted it - not that the registration is provably gone.
   */
  readonly deregisteredService: boolean;
  /**
   * What the post-teardown readback observed: `true` = definitely still registered, `null` = nothing could confirm either way.
   * Read this rather than `deregisteredService` when you need certainty.
   */
  readonly serviceRegistrationRetained: boolean | null;
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
  /**
   * The catalog override, tri-state: `true` explicitly includes release candidates, `false` explicitly excludes them, and `undefined` asks the CLI to derive inclusion from the installed host.
   * `boolean | undefined` rather than an optional property, so a caller must state which of the three it means.
   */
  readonly includePreReleases: boolean | undefined;
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
 * Renderer-facing mirror of `HostController`'s canonical two-lane status (Host Update Layer Redesign Tech Plan, "Desktop main: HostController" > "Canonical status").
 */
export interface MutationProgress {
  readonly stage: string | null;
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
  readonly message: string | null;
  /**
   * Monotonic count of discrete units of work completed within this stage - the CLI's `ProgressInfo.workUnits`, carried through unchanged.
   * Producers increment it only when a unit of work has completed, never on a timer.
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
  | "activated"
  | "pendingActivation"
  | "activationUnknown"
  | "unavailable";

  /**
   * The durable attempt record's facts, read from disk by desktop main.
   * Desktop main can read that record without a host.
   */
export interface LocalAttemptFacts {
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly targetVersion: string;
  readonly phase: HostUpdateAttemptPhase;
  // `HostUpdateAttemptContinuation` already includes `null`.
  readonly continuation: HostUpdateAttemptContinuation;
  readonly updatedAt: string;
}

export interface HostControllerStatus {
  /**
   * The durable attempt on this machine, or `null` when there is none or the record could not be read.
   * `null` is deliberately not "no attempt": an unreadable record is also `null`, and the renderer must treat absence as "we cannot say" rather than as "nothing is running".
   */
  readonly localAttempt: LocalAttemptFacts | null;
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

// Pre-commit busy (CLI-owned apply/pin refused before the stop): `"retry-with-force"` - Force re-submits the same intent with `force`.
// Post-commit busy (packaged macOS, bytes already committed): `"activate"` - Force submits `activateInstalled{force}`, never a retry of the consumed apply/pin.
export type BusyContinuation = "retry-with-force" | "activate";

// Result of an explicit restart request (`requestHostRespawn` / `IHostManagement.restartHost`).
export type HostRestartRequestResult =
  | { readonly kind: "restarted" }
  | { readonly kind: "declined"; readonly message: string };

  // Per-intent result.
// Every mutation intent resolves one of these - the lane itself never rejects ("wait-never-reject"); a busy/deferred/failed outcome is a normal resolved value the calling surface renders.
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
  /**
   * The deregistration was performed and nothing contradicted it - not that the registration is provably gone.
   */
  readonly deregisteredService: boolean;
  /**
   * What the post-teardown readback observed.
   * Read this rather than `deregisteredService` when you need certainty.
   */
  readonly serviceRegistrationRetained: boolean | null;
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
  /** Cleared once the user upgrades (the next reconcile observes the new version and drops the hint). */
  readonly packageManagerUpgrade: {
    readonly source: "homebrew" | "npm" | "winget" | "scoop" | "apt" | "rpm";
    readonly installedVersion: string;
    readonly bundledVersion: string;
    readonly upgradeCommand: string;
    readonly recordedAt: string;
  } | null;
}

export type DoctorRepairIntent = "converge-ready" | "register-service";

/**
 * The recovery console's repairs, which queue rather than refusing.
 * This console repairs a host that is already down, so waiting behind whatever is running is the point, and a surface reachable when Settings cannot render must never learn to say no.
 */
export type QueuedDoctorRepair =
  | "converge-ready"
  | "register-service"
  | "restart";

export type QueuedDoctorRepairResult =
  | { readonly kind: "applied" }
  | { readonly kind: "declined"; readonly message: string };

export type DoctorRepairDispatch =
  | { readonly kind: "lane-busy"; readonly message: string }
  | { readonly kind: "host-changed"; readonly message: string }
  | { readonly kind: "dispatched"; readonly outcome: MutationOutcome<null> };

  /** What an atomic maintenance install submission answers. */
export type MaintenanceInstallDispatch =
  | {
      readonly kind: "lane-busy";
      /**
       * The distinction is not cosmetic.
       * Reporting a service registration as "already updating" therefore both lies and hangs the surface on progress that cannot arrive.
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
     * `host.doctor` as the desktop lane can honestly answer it: the CLI's issue list (validated against the protocol issue schema) or the shared CLI-shell failure taxonomy - but without `triviallyGreenIssueCodes`.
     */
export type MaintenanceDoctorProjection =
  | {
      readonly status: "ok";
      readonly issues: readonly MaintenanceDoctorIssue[];
    }
  | { readonly status: "cli-unavailable" }
  | { readonly status: "cli-failed" }
  | { readonly status: "invalid-output" };

export interface IHostManagement {
  // Two-lane canonical status (Host Update Layer Redesign Tech Plan).
  readonly getHostControllerStatus: () => Promise<HostControllerStatus>;
  // Idempotently converges the host to reachable (post-auth provisioning,
  // manual retry, Force restart). `force` skips the busy check.
  readonly convergeReady: (
    force: boolean,
  ) => Promise<MutationOutcome<ConvergeReadyOk>>;
  // Applies the currently-staged version.
  readonly applyStaged: (
    trigger: ApplyStagedTrigger,
    force: boolean,
  ) => Promise<MutationOutcome<ApplyStagedOk>>;
  // Activates an already-installed-but-not-running-activated record (packaged-macOS post-commit activation, or clearing pendingActivation/activationUnknown debt).
  // `force` is the Force continuation after a busy `applyStaged`/pin outcome that carried `continuation: "activate"`.
  readonly activateInstalled: (
    force: boolean,
  ) => Promise<MutationOutcome<ActivateInstalledOk>>;
  // Pins an explicit version (incl.
  // `force` is the Force continuation after a busy outcome that carried `continuation: "retry-with-force"`.
  readonly installVersion: (
    pin: string,
    force: boolean,
  ) => Promise<MutationOutcome<InstallVersionOk>>;
  readonly uninstallHost: (input: {
    readonly all: boolean;
  }) => Promise<HostUninstallResult>;
  // In-app "Remove Traycer" (Settings → General → Danger Zone).
  readonly uninstallTraycer: () => Promise<TraycerUninstallResult>;
  // Reads the persisted removal sentinel so the renderer can short-circuit to
  // the removed surface before attempting any provisioning.
  readonly getRemovalState: () => Promise<HostRemovalState>;
  // Clears the removal sentinel so a subsequent `ensureHost` reinstalls the
  // host (the Reinstall escape hatch on the removed surface).
  readonly clearRemoval: () => Promise<void>;
  // Explicit "restart the host now" (Settings / tray).
  // Same contract as `IRunnerHost.requestHostRespawn`: resolves `declined` when the host was deliberately not restarted; rejects only on genuine failures.
  readonly restartHost: () => Promise<HostRestartRequestResult>;
  /** This machine's host log. */
  readonly getHostLogs: (input: {
    readonly tailLines: number;
    readonly expectedHostId: string;
  }) => Promise<HostLogsTailResult>;
  /** This machine's Doctor report. */
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
  // Forces (or, on cache hit, reuses) a network registry probe - "Check now"/"Retry" on Settings → Host's Updates row.
  readonly registryCheck: (input: {
    readonly force: boolean;
  }) => Promise<HostRegistryUpdateState>;
  /**
   * Kill the process holding the host's port and restart it, queueing behind whatever the lane is running.
   */
  readonly freePortAndRestart: (
    input: FreePortAndRestartInput & { readonly expectedHostId: string },
  ) => Promise<FreePortAndRestartInput>;
  /** The refusing twin, for the Doctor sheet a person is watching. */
  readonly freePortAndRestartIfIdle: (
    input: FreePortAndRestartInput & { readonly expectedHostId: string },
  ) => Promise<DoctorRepairDispatch>;
  readonly cliManifest: () => Promise<CliInstallManifestSnapshot | null>;
  // Every member below carries `expectedHostId`: the host the caller believes is local.
  /** `host.update.check`'s answer from this machine's bundled CLI. */
  readonly maintenanceUpdateCheck: (
    input: HostAvailableVersionsInput & { readonly expectedHostId: string },
  ) => Promise<HostUpdateCheckResponseV11>;
  /** `host.doctor`'s answer, minus the caller-owned transport vantage. */
  readonly maintenanceDoctor: (input: {
    readonly expectedHostId: string;
  }) => Promise<MaintenanceDoctorProjection>;
  /** `host.getInstallationInfo`'s answer from the shared on-disk records. */
  readonly maintenanceInstallationInfo: (input: {
    readonly expectedHostId: string;
  }) => Promise<HostGetInstallationInfoResponse>;
  /**
   * `host.update.install`'s dispatch, refused when the mutation lane is already occupied.
   * Distinct from {@link installVersion} because the refusal has to be atomic with the submission.
   */
  readonly maintenanceInstallVersion: (input: {
    readonly version: string;
    readonly force: boolean;
    readonly expectedHostId: string;
  }) => Promise<MaintenanceInstallDispatch>;
  /**
   * Respawn the local host, refused (not queued) when the desktop's exclusive mutation lane already owns an intent.
   * Force overrides the host's veto (busy work, a live claim); it was never meant to override the desktop's own serialization.
   */
  readonly restartHostIfIdle: (input: {
    readonly expectedHostId: string;
  }) => Promise<HostRestartRequestResult>;
  /**
   * The down-host recovery console's four lifecycle repairs, identity-fenced and queueing.
   * See {@link QueuedDoctorRepair} for why those two properties belong together rather than being traded off.
   */
  readonly runDoctorRepairQueued: (input: {
    readonly repair: QueuedDoctorRepair;
    readonly expectedHostId: string;
  }) => Promise<QueuedDoctorRepairResult>;
  /**
   * The watched Doctor sheet's two lifecycle repairs, refused when the exclusive lane is occupied or this machine's host is no longer the expected one.
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

export interface IHostTray {
  onCommand(handler: (command: HostTrayCommand) => void): Disposable;
}
