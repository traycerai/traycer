import {
  ARTIFACT_OBJECT_SPAN_BYTES,
  type SandboxArtifactReply,
} from "../../ipc-contracts/sandbox-artifact-types";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { log } from "../app/logger";
import type {
  DesktopTrayEpic,
  DesktopTrayIndicatorState,
} from "../../ipc-contracts/host-types";
import type {
  QuitDecision,
  UnsyncedEditsSnapshot,
  UnsyncedEditsSnapshotEntry,
} from "../../ipc-contracts/app-lifecycle-types";
import type {
  DesktopAuthSessionSnapshot,
  MenuCommandId,
  PerWindowSnapshot,
  PerWindowStatePatch,
  SupportLogTarget,
} from "../../ipc-contracts/window-types";
import {
  parseJsonRecord,
  parseJsonValue,
  parseLandingDrafts,
} from "../../ipc-contracts/window-state-parsers";
import type {
  StoredAuthTokens,
  StoredCredentialsIdentity,
} from "../../ipc-contracts/auth-types";
import type { MintHostCredentialRequest } from "@traycer/protocol/auth/devices-sessions";

export {
  parseJsonRecord,
  parseJsonValue,
  parseLandingDraft,
  parseLandingDrafts,
} from "../../ipc-contracts/window-state-parsers";
import { normalizeDesktopAuthSession } from "../auth/desktop-auth-session";
import type { UpdateHostVersionPolicyInput } from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import {
  SANDBOX_VERB_GESTURES,
  sandboxPatchRequestSchema,
  type SandboxAutomationOpenTarget,
  type SandboxCreateRequest,
  type SandboxLifecycleVerb,
  type SandboxPatchRequest,
  type SandboxVerbGesture,
} from "@traycer/protocol/host/sandbox-control";
import {
  slackAppBotRequestSchema,
  slackAppRegisterRequestSchema,
  type SlackAppRegisterRequest,
} from "@traycer/protocol/host/slack-app";
import {
  SECRET_REQUEST_DECISIONS,
  type SecretRequestDecision,
} from "@traycer/protocol/host/sandbox-secrets";

export function assertString(
  value: unknown,
  context: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${context} requires a string argument`);
  }
}

export function assertNullableString(
  value: unknown,
  context: string,
): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${context} requires a string or null argument`);
  }
}

export function assertNumber(
  value: unknown,
  context: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context} requires a finite number argument`);
  }
}

export function assertInteger(
  value: unknown,
  context: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${context} requires an integer argument`);
  }
}

/**
 * Parses the `{ token, refreshToken }` pair the renderer hands to
 * `tokenStore.signIn` over IPC. Fail-closed: a non-string field throws so a
 * malformed payload never lands as credentials.
 */
export function parseStoredAuthTokens(value: unknown): StoredAuthTokens {
  if (value === null || typeof value !== "object") {
    throw new Error(
      "tokenStore.signIn requires a { token, refreshToken } object",
    );
  }
  const record = value as Record<string, unknown>;
  assertString(record.token, "tokenStore.signIn.token");
  assertString(record.refreshToken, "tokenStore.signIn.refreshToken");
  return { token: record.token, refreshToken: record.refreshToken };
}

/**
 * Parses the `{ id, email, name }` identity block the renderer hands to
 * `tokenStore.signIn`. The main store stamps `savedAt`, so only the user
 * identity crosses here. Fail-closed on any non-string field.
 */
/**
 * Parses the delegated host-credential mint request. `hostId` is required (the
 * mint is meaningless without it and the server rejects a bad one anyway);
 * `hostLabel` and `platform` are display metadata, so anything that is not a
 * string collapses to `null` rather than throwing - a missing label must not
 * cost the user a credential.
 */
export function parseMintHostCredentialRequest(
  value: unknown,
): MintHostCredentialRequest {
  if (value === null || typeof value !== "object") {
    throw new Error("mintHostCredential requires a request object");
  }
  const record = value as Record<string, unknown>;
  assertString(record.hostId, "mintHostCredential.hostId");
  return {
    hostId: record.hostId,
    hostLabel: typeof record.hostLabel === "string" ? record.hostLabel : null,
    platform: typeof record.platform === "string" ? record.platform : null,
  };
}

export function parseStoredCredentialsIdentity(
  value: unknown,
): StoredCredentialsIdentity {
  if (value === null || typeof value !== "object") {
    throw new Error(
      "tokenStore.signIn requires an { id, email, name } identity",
    );
  }
  const record = value as Record<string, unknown>;
  assertString(record.id, "tokenStore.signIn.identity.id");
  assertString(record.email, "tokenStore.signIn.identity.email");
  assertString(record.name, "tokenStore.signIn.identity.name");
  return { id: record.id, email: record.email, name: record.name };
}

/**
 * Parses the `{ userId, token }` CAS guard the renderer hands to
 * `tokenStore.rotate`. Fail-closed on any non-string field.
 */
export function parseTokenRotateExpected(value: unknown): {
  readonly userId: string;
  readonly token: string;
} {
  if (value === null || typeof value !== "object") {
    throw new Error("tokenStore.rotate requires a { userId, token } object");
  }
  const record = value as Record<string, unknown>;
  assertString(record.userId, "tokenStore.rotate.userId");
  assertString(record.token, "tokenStore.rotate.token");
  return { userId: record.userId, token: record.token };
}

export function parseEpics(value: unknown): readonly DesktopTrayEpic[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: DesktopTrayEpic[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const epic = entry as Record<string, unknown>;
    if (typeof epic.epicId !== "string" || typeof epic.title !== "string") {
      continue;
    }
    out.push({
      epicId: epic.epicId,
      title: epic.title,
      subtitle: typeof epic.subtitle === "string" ? epic.subtitle : "",
    });
  }
  return out;
}

export function parseIndicator(value: unknown): DesktopTrayIndicatorState {
  if (value === "active" || value === "attention" || value === "idle") {
    return value;
  }
  return "idle";
}

export function parseUnsyncedSnapshot(value: unknown): UnsyncedEditsSnapshot {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: UnsyncedEditsSnapshotEntry[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.epicId !== "string" ||
      typeof entry.title !== "string" ||
      typeof entry.queueSize !== "number" ||
      Number.isNaN(entry.queueSize) ||
      typeof entry.isDirty !== "boolean" ||
      typeof entry.unsyncable !== "boolean"
    ) {
      continue;
    }
    out.push({
      epicId: entry.epicId,
      title: entry.title,
      queueSize: entry.queueSize,
      isDirty: entry.isDirty,
      // Carried, not defaulted. A `?? false` here would read as tolerance and
      // behave as a silent claim that another window's retained buffer is
      // safe to destroy - the exact direction this field must never fail in.
      // Renderer, preload and main ship in one binary, so a row without it is
      // malformed rather than old, and the guard above drops it.
      unsyncable: entry.unsyncable,
    });
  }
  return out;
}

interface ParsedFreshSnapshotResponse {
  readonly requestId: string;
  readonly snapshot: UnsyncedEditsSnapshot;
}

export function parseFreshSnapshotResponse(
  value: unknown,
): ParsedFreshSnapshotResponse | null {
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.requestId !== "string" || obj.requestId.length === 0) {
    return null;
  }
  const snapshot = parseUnsyncedSnapshot(obj.snapshot);
  return { requestId: obj.requestId, snapshot };
}

/**
 * Every member of {@link QuitDecision}, as a TOTAL record.
 *
 * This is the enforcement, not decoration. `parseQuitDecision` used to accept
 * the members it knew about through an `if` chain and fall back to `proceed` -
 * i.e. quit - for everything else. Adding a member to the union left that
 * chain compiling, so a renderer saying "do not quit" would have been parsed
 * as "quit" and answered by quitting. A record keyed by the union cannot omit
 * a member without failing the build, so the next member has to be decided
 * here before it can exist. But the record only makes ADDING a member a
 * compile error - it says nothing about what an unparseable payload means,
 * same as `parseUnsyncedSnapshot` above: an unrecognized `decision` is not
 * evidence the user asked to quit, so the fallback must be the one outcome
 * that can't destroy anything - `userCancelled`, which keeps the app open.
 * `stayOpen` exists on both consumers of this result for exactly that reason.
 */
const QUIT_DECISION_MEMBERS: Readonly<Record<QuitDecision, true>> = {
  proceed: true,
  userConfirmedDiscard: true,
  userCancelled: true,
};

function isQuitDecision(value: unknown): value is QuitDecision {
  return (
    typeof value === "string" && Object.hasOwn(QUIT_DECISION_MEMBERS, value)
  );
}

export function parseQuitDecision(value: unknown): QuitDecision {
  if (isQuitDecision(value)) {
    return value;
  }
  log.warn(
    "[runner-ipc] invalid quit decision from renderer; defaulting to userCancelled",
    { value },
  );
  return "userCancelled";
}

export interface ParsedQuitDecisionResponse {
  readonly requestId: string | null;
  readonly decision: QuitDecision;
  readonly legacy: boolean;
}

export function parseQuitDecisionResponse(
  value: unknown,
): ParsedQuitDecisionResponse {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const requestId = parseRequestId(obj.requestId);
    return {
      requestId,
      decision: parseQuitDecision(obj.decision),
      legacy: false,
    };
  }
  return {
    requestId: null,
    decision: parseQuitDecision(value),
    legacy: true,
  };
}

export function parseRequestId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseInitialRoute(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  return value;
}

export function parseOptionalTitle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildEpicInitialRoute(
  epicId: string,
  tabId: string | null,
): string {
  const epicPath = `/epics/${encodeURIComponent(epicId)}`;
  return `${epicPath}/${encodeURIComponent(tabId ?? epicId)}`;
}

/** Mirrors the renderer's `draftPathname` (`/draft/{draftId}`). */
export function buildDraftInitialRoute(draftId: string): string {
  return `/draft/${encodeURIComponent(draftId)}`;
}

export function parsePerWindowStatePatch(value: unknown): PerWindowStatePatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const obj = value as Record<string, unknown>;
  const patch: PerWindowStatePatch = {};
  if ("epicTabs" in obj) {
    Object.assign(patch, {
      epicTabs: parsePerWindowEpicTabs(obj.epicTabs),
    });
  }
  if ("activeTabId" in obj) {
    Object.assign(patch, {
      activeTabId: typeof obj.activeTabId === "string" ? obj.activeTabId : null,
    });
  }
  if ("canvasByTabId" in obj) {
    Object.assign(patch, {
      canvasByTabId: parseJsonRecord(obj.canvasByTabId),
    });
  }
  if ("landingDrafts" in obj) {
    Object.assign(patch, {
      landingDrafts: parseLandingDrafts(obj.landingDrafts),
    });
  }
  if ("activeLandingDraftId" in obj) {
    Object.assign(patch, {
      activeLandingDraftId:
        typeof obj.activeLandingDraftId === "string"
          ? obj.activeLandingDraftId
          : null,
    });
  }
  if ("tabStripLayout" in obj) {
    Object.assign(patch, {
      tabStripLayout: parseJsonValue(obj.tabStripLayout) ?? null,
    });
  }
  if ("activeRoute" in obj) {
    Object.assign(patch, {
      activeRoute: typeof obj.activeRoute === "string" ? obj.activeRoute : null,
    });
  }
  return patch;
}

export function parsePerWindowEpicTabs(
  value: unknown,
): PerWindowSnapshot["epicTabs"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const obj = entry as Record<string, unknown>;
    if (
      typeof obj.id !== "string" ||
      typeof obj.epicId !== "string" ||
      typeof obj.name !== "string"
    ) {
      return [];
    }
    // The tab's identity is id + epicId; an empty name is a legitimate
    // untitled tab (the renderer derives the shown title). Only drop entries
    // missing structural identity, not empty-named ones.
    if (obj.id.length === 0 || obj.epicId.length === 0) {
      return [];
    }
    if (seen.has(obj.id)) {
      return [];
    }
    seen.add(obj.id);
    const surfaceMode = parsePerWindowEpicSurfaceMode(obj.surfaceMode);
    return [
      surfaceMode === null
        ? { id: obj.id, epicId: obj.epicId, name: obj.name }
        : { id: obj.id, epicId: obj.epicId, name: obj.name, surfaceMode },
    ];
  });
}

function parsePerWindowEpicSurfaceMode(
  value: unknown,
): { readonly kind: "phase-migration"; readonly phaseId: string } | null {
  if (!isPlainRecord(value)) return null;
  if (
    value.kind === "phase-migration" &&
    typeof value.phaseId === "string" &&
    value.phaseId.length > 0
  ) {
    return { kind: "phase-migration", phaseId: value.phaseId };
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseDesktopAuthSession(
  value: unknown,
): DesktopAuthSessionSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return normalizeDesktopAuthSession({
      status: "signed-out",
      token: null,
      profile: null,
    });
  }
  const obj = value as Record<string, unknown>;
  const profile =
    obj.profile !== null &&
    typeof obj.profile === "object" &&
    !Array.isArray(obj.profile)
      ? (obj.profile as Record<string, unknown>)
      : null;
  return normalizeDesktopAuthSession({
    status:
      obj.status === "signed-in" || obj.status === "signing-in"
        ? obj.status
        : "signed-out",
    token: typeof obj.token === "string" ? obj.token : null,
    profile:
      profile !== null &&
      typeof profile.userId === "string" &&
      typeof profile.userName === "string" &&
      typeof profile.email === "string"
        ? {
            userId: profile.userId,
            userName: profile.userName,
            email: profile.email,
          }
        : null,
  });
}

export function parseSupportLogTarget(value: unknown): SupportLogTarget {
  if (
    value === "host" ||
    value === "desktop" ||
    value === "browserTelemetry" ||
    value === "browserTrace"
  ) {
    return value;
  }
  throw new Error(
    'supportLogTarget must be "desktop", "host", "browserTelemetry", or "browserTrace"',
  );
}

/**
 * Parses the renderer-supplied `PATCH /api/v3/hosts/:hostId` body (Remote
 * Host Support §13, T16). Every field is tri-state (`undefined` = leave
 * untouched); an unrecognized/mistyped value degrades to `undefined` rather
 * than throwing, so a stale renderer build can never crash main — the server
 * still 400s an empty-effective body.
 */
export function parseUpdateHostVersionPolicyInput(
  value: unknown,
): UpdateHostVersionPolicyInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      updatePolicy: undefined,
      desiredVersion: undefined,
      force: undefined,
    };
  }
  const obj = value as Record<string, unknown>;
  const updatePolicy =
    obj.updatePolicy === "manual" || obj.updatePolicy === "auto"
      ? obj.updatePolicy
      : undefined;
  const desiredVersion =
    obj.desiredVersion === null
      ? null
      : typeof obj.desiredVersion === "string"
        ? obj.desiredVersion
        : undefined;
  const force = typeof obj.force === "boolean" ? obj.force : undefined;
  return { updatePolicy, desiredVersion, force };
}

/**
 * Parses the renderer-supplied `POST /api/sandboxes` body. Unlike the version
 * policy above there is no safe degrade for a malformed create - a guessed
 * shape would provision a machine nobody asked for - so a bad value throws,
 * which the invoke surfaces to the renderer as a rejected call.
 */
export function parseSandboxCreateRequest(
  value: unknown,
): SandboxCreateRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("createSandbox.request must be an object");
  }
  const obj = value as Record<string, unknown>;
  const os = obj.os;
  if (os !== "linux" && os !== "windows") {
    throw new Error('createSandbox.request.os must be "linux" or "windows"');
  }
  const burst = obj.burst;
  if (typeof burst !== "boolean") {
    throw new Error("createSandbox.request.burst must be a boolean");
  }
  const cpus = obj.cpus;
  if (typeof cpus !== "number" || !(cpus > 0)) {
    throw new Error("createSandbox.request.cpus must be a positive number");
  }
  return {
    os,
    cpus,
    memoryMb: requirePositiveInteger(
      obj.memoryMb,
      "createSandbox.request.memoryMb",
    ),
    diskMb: nullOr(obj.diskMb, (v) =>
      requirePositiveInteger(v, "createSandbox.request.diskMb"),
    ),
    region: nullOr(obj.region, (v) =>
      requireNonEmptyString(v, "createSandbox.request.region"),
    ),
    displayName: requireNonEmptyString(
      obj.displayName,
      "createSandbox.request.displayName",
    ),
    idleMinutes: nullOr(obj.idleMinutes, (v) =>
      requirePositiveInteger(v, "createSandbox.request.idleMinutes"),
    ),
    burst,
    createdByHostId: nullOr(obj.createdByHostId, (v) =>
      requireNonEmptyString(v, "createSandbox.request.createdByHostId"),
    ),
    createdByAgentId: nullOr(obj.createdByAgentId, (v) =>
      requireNonEmptyString(v, "createSandbox.request.createdByAgentId"),
    ),
    environmentId: nullOr(obj.environmentId, (v) =>
      requireNonEmptyString(v, "createSandbox.request.environmentId"),
    ),
    // `0` is never, as on a patch; `null` is the configuration's default.
    destroyAfterRestingMinutes: nullOr(obj.destroyAfterRestingMinutes, (v) =>
      requireNonNegativeInteger(
        v,
        "createSandbox.request.destroyAfterRestingMinutes",
      ),
    ),
    createdByTaskId: nullOr(obj.createdByTaskId, (v) =>
      requireNonEmptyString(v, "createSandbox.request.createdByTaskId"),
    ),
    clientRequestId: nullOr(obj.clientRequestId, (v) =>
      requireNonEmptyString(v, "createSandbox.request.clientRequestId"),
    ),
  };
}

/**
 * Parses the renderer-supplied `PATCH /api/sandboxes/:id` body. Each key must
 * be present: `null` leaves that setting unchanged, so a missing key is a
 * renderer bug, not a default. `destroyAfterRestingMinutes` takes `0` for
 * never.
 */
export function parseSandboxPatchRequest(value: unknown): SandboxPatchRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("patchSandbox.request must be an object");
  }
  const obj = value as Record<string, unknown>;
  const request: SandboxPatchRequest = {
    displayName: nullOr(obj.displayName, (v) =>
      requireNonEmptyString(v, "patchSandbox.request.displayName"),
    ),
    idleMinutes: nullOr(obj.idleMinutes, (v) =>
      requirePositiveInteger(v, "patchSandbox.request.idleMinutes"),
    ),
    destroyAfterRestingMinutes: nullOr(obj.destroyAfterRestingMinutes, (v) =>
      requireNonNegativeInteger(
        v,
        "patchSandbox.request.destroyAfterRestingMinutes",
      ),
    ),
  };
  // The protocol's bounds too (an idle floor, the name's length), so this
  // guard cannot drift from the contract it forwards.
  const checked = sandboxPatchRequestSchema.safeParse(request);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new Error(
      `patchSandbox.request.${issue.path.join(".")}: ${issue.message}`,
    );
  }
  return request;
}

/**
 * A required id argument (a team id, an environment id): a non-empty
 * string, or the call is refused.
 */
export function parseRequiredId(value: unknown, name: string): string {
  return requireNonEmptyString(value, name);
}

/**
 * The environment a `getSandboxAutomation` reads: `null` for the person's own
 * Automations host, otherwise a non-empty id (an empty one would send
 * `?environmentId=` and read no environment at all).
 */
export function parseSandboxAutomationEnvironmentId(
  value: unknown,
): string | null {
  return nullOr(value, (v) =>
    requireNonEmptyString(v, "getSandboxAutomation.environmentId"),
  );
}

/**
 * Parses the renderer-supplied Automations open target: `null` (the
 * caller's own host, no body) or a team environment and the pod's slot. A
 * malformed target throws, like a malformed create: a guessed one would open
 * another pod than the one picked.
 */
export function parseSandboxAutomationOpenTarget(
  value: unknown,
): SandboxAutomationOpenTarget | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("openSandboxAutomation.target must be an object or null");
  }
  const obj = value as Record<string, unknown>;
  return {
    environmentId: requireNonEmptyString(
      obj.environmentId,
      "openSandboxAutomation.target.environmentId",
    ),
    ordinal: nullOr(obj.ordinal, (v) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new Error(
          "openSandboxAutomation.target.ordinal must be a non-negative integer",
        );
      }
      return v;
    }),
  };
}

/**
 * The renderer-supplied Slack app registration, against the protocol's own
 * bounds. The error names the field and the rule, never the value: two of
 * the fields are the app's secrets.
 */
export function parseSlackAppRegisterRequest(
  value: unknown,
): SlackAppRegisterRequest {
  const checked = slackAppRegisterRequestSchema.safeParse(value);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new Error(
      `registerSlackApp.request.${issue.path.join(".")}: ${issue.message}`,
    );
  }
  return checked.data;
}

/** The bot a Slack app call names, against the protocol's bounds. */
export function parseSlackAppBotId(value: unknown, name: string): string {
  const checked = slackAppBotRequestSchema.safeParse({ botId: value });
  if (!checked.success) {
    throw new Error(`${name}: ${checked.error.issues[0].message}`);
  }
  return checked.data.botId;
}

/** `null` stays `null` (the server's default); anything else must parse. */
function nullOr<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function parseSecretRequestDecision(
  value: unknown,
): SecretRequestDecision {
  const decision = SECRET_REQUEST_DECISIONS.find((known) => known === value);
  if (decision === undefined) {
    throw new Error(
      'decideSecretRequest.decision must be "approve", "approve_default" or "decline"',
    );
  }
  return decision;
}

export function parseSandboxLifecycleVerb(
  value: unknown,
): SandboxLifecycleVerb {
  if (
    value === "suspend" ||
    value === "resume" ||
    value === "stop" ||
    value === "start"
  ) {
    return value;
  }
  throw new Error(
    'runSandboxVerb.verb must be "suspend", "resume", "stop" or "start"',
  );
}

export function parseSandboxVerbGesture(
  value: unknown,
): SandboxVerbGesture | null {
  if (value === null) return null;
  const gesture = SANDBOX_VERB_GESTURES.find((g) => g === value);
  if (gesture !== undefined) return gesture;
  throw new Error(
    'runSandboxVerb.gesture must be null, "open-terminal", "send" or "open-files"',
  );
}

export function readSenderWebContentsId(
  event: IpcMainInvokeEvent | IpcMainEvent,
): number | null {
  const sender = (event as { readonly sender?: { readonly id?: unknown } })
    .sender;
  if (sender === undefined || typeof sender.id !== "number") {
    return null;
  }
  return sender.id;
}

/**
 * App-scoped commands that may fire with no focused renderer - tray-menu and
 * Windows jump-list clicks happen while another app is foregrounded. The
 * dispatcher falls back to the MRU window (focusing it) for these, so they
 * never silently no-op. Window-scoped commands (close tab, find in page, ...)
 * deliberately stay focused-window-only: delivering them to an arbitrary
 * window would act on the wrong target.
 */
export function isMruFallbackMenuCommand(command: MenuCommandId): boolean {
  return (
    command === "epic.openInNewWindow" ||
    command === "app.aboutDetails" ||
    command === "app.openLogs" ||
    command === "app.openSettings" ||
    command === "app.signIn" ||
    command === "app.signOut" ||
    // The renderer owns the CLI mutation behind host update/restart; main
    // only needs to make sure *some* renderer receives the command and is
    // focused/visible to the user (restart is renderer-confirmed).
    command === "host.installUpdate" ||
    command === "host.restart"
  );
}

export function parseSandboxArtifactMountId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]+$/.test(value)) {
    throw new Error("Invalid artifact mount id");
  }
  return value;
}

export function parseSandboxArtifactReply(
  value: unknown,
): SandboxArtifactReply | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestId !== "string" ||
    record.requestId.length === 0 ||
    record.requestId.length > 128
  )
    return null;
  if (record.kind === "unavailable") {
    if (
      (record.status !== 404 && record.status !== 503) ||
      typeof record.reason !== "string" ||
      record.reason.length > 256
    )
      return null;
    return {
      requestId: record.requestId,
      kind: "unavailable",
      status: record.status,
      reason: record.reason,
    };
  }
  if (
    record.kind !== "bytes" ||
    !(record.bytes instanceof Uint8Array) ||
    record.bytes.byteLength > ARTIFACT_OBJECT_SPAN_BYTES + 1024 ||
    typeof record.offset !== "number" ||
    !Number.isSafeInteger(record.offset) ||
    record.offset < 0 ||
    typeof record.totalBytes !== "number" ||
    !Number.isSafeInteger(record.totalBytes) ||
    record.totalBytes < 0 ||
    typeof record.mediaType !== "string" ||
    record.mediaType.length === 0 ||
    record.mediaType.length > 256 ||
    /[^\x20-\x7e]/.test(record.mediaType)
  )
    return null;
  return {
    requestId: record.requestId,
    kind: "bytes",
    bytes: record.bytes,
    offset: record.offset,
    totalBytes: record.totalBytes,
    mediaType: record.mediaType,
  };
}
