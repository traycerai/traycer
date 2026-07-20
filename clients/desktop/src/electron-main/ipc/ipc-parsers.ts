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
  parseLandingDrafts,
} from "../../ipc-contracts/window-state-parsers";

export {
  parseJsonRecord,
  parseJsonValue,
  parseLandingDraft,
  parseLandingDrafts,
} from "../../ipc-contracts/window-state-parsers";
import { normalizeDesktopAuthSession } from "../auth/desktop-auth-session";
import type { UpdateHostVersionPolicyInput } from "@traycer-clients/shared/host-client/host-version-policy-fetcher";

export function assertString(
  value: unknown,
  context: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${context} requires a string argument`);
  }
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
      typeof entry.isDirty !== "boolean"
    ) {
      continue;
    }
    out.push({
      epicId: entry.epicId,
      title: entry.title,
      queueSize: entry.queueSize,
      isDirty: entry.isDirty,
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

export function parseQuitDecision(value: unknown): QuitDecision {
  if (value === "proceed" || value === "userConfirmedDiscard") {
    return value;
  }
  log.warn(
    "[runner-ipc] invalid quit decision from renderer; defaulting to proceed",
    { value },
  );
  return "proceed";
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
    return [{ id: obj.id, epicId: obj.epicId, name: obj.name }];
  });
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
  return value === "host" ? "host" : "desktop";
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

export function readEpicId(payload: unknown): string | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  return typeof obj.epicId === "string" ? obj.epicId : null;
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
