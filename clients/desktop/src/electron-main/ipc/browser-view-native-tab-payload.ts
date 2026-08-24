import type {
  BrowserViewAttachSurface,
  BrowserViewDetachSurface,
  BrowserViewElectronTabCdpDispatch,
  BrowserViewElectronTabControl,
  BrowserViewEnsureTab,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabKey,
  BrowserViewReleaseTab,
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
} from "../../ipc-contracts/browser-view-types";
import { parseBrowserViewCdpCommand } from "./browser-view-cdp-payload";

export function parseBrowserViewEnsureTab(
  value: unknown,
): BrowserViewEnsureTab {
  const record = readRecord(value, "Electron browser tab ensure payload");
  return {
    ...parseBrowserViewNativeTabKey(record),
    requestedUrl: readNonEmptyString(record.requestedUrl, "requestedUrl"),
    seedStorageState: record.seedStorageState ?? null,
  };
}

export function parseBrowserViewAttachSurface(
  value: unknown,
): BrowserViewAttachSurface {
  const record = readRecord(value, "Electron browser surface attachment");
  return {
    ...parseBrowserViewNativeTabCapability(record),
    bindingId: readNonEmptyString(record.bindingId, "bindingId"),
    surface: parseBrowserViewTileKey(record.surface),
    visible: readBoolean(record.visible, "visible"),
  };
}

export function parseBrowserViewDetachSurface(
  value: unknown,
): BrowserViewDetachSurface {
  const record = readRecord(value, "Electron browser surface detachment");
  return {
    ...parseBrowserViewNativeTabCapability(record),
    bindingId: readNonEmptyString(record.bindingId, "bindingId"),
  };
}

export function parseBrowserViewReleaseTab(
  value: unknown,
): BrowserViewReleaseTab {
  return parseBrowserViewNativeTabCapability(value);
}

export function parseBrowserViewElectronTabControl(
  value: unknown,
): BrowserViewElectronTabControl {
  const record = readRecord(value, "Electron browser tab control");
  return {
    ...parseBrowserViewNativeTabCapability(record),
    action: parseControlAction(record.action),
  };
}

export function parseBrowserViewElectronTabCdpDispatch(
  value: unknown,
): BrowserViewElectronTabCdpDispatch {
  const record = readRecord(value, "Electron browser tab CDP dispatch");
  return {
    ...parseBrowserViewNativeTabCapability(record),
    cdpSessionId: readNullableNonEmptyString(
      record.cdpSessionId,
      "cdpSessionId",
    ),
    command: parseBrowserViewCdpCommand(record.command),
  };
}

export function parseBrowserViewNativeTabCapability(
  value: unknown,
): BrowserViewNativeTabCapability {
  const record = readRecord(value, "Electron browser tab capability");
  return {
    ...parseBrowserViewNativeTabKey(record),
    registrationId: readNonEmptyString(record.registrationId, "registrationId"),
  };
}

function parseBrowserViewNativeTabKey(value: unknown): BrowserViewNativeTabKey {
  const record = readRecord(value, "Electron browser tab key");
  return {
    hostId: readNonEmptyString(record.hostId, "hostId"),
    sessionId: readNonEmptyString(record.sessionId, "sessionId"),
    tabId: readNonEmptyString(record.tabId, "tabId"),
  };
}

function parseControlAction(
  value: unknown,
): BrowserViewElectronTabControl["action"] {
  const record = readRecord(value, "Electron browser tab control action");
  const kind = readNonEmptyString(record.kind, "action.kind");
  switch (kind) {
    case "navigate":
      return { kind, url: readNonEmptyString(record.url, "action.url") };
    case "setViewportPreset":
      return {
        kind,
        viewportPreset: readViewportPreset(record.viewportPreset),
      };
    case "reload":
    case "goBack":
    case "goForward":
    case "zoomIn":
    case "zoomOut":
    case "resetZoom":
    case "openDevTools":
      return { kind };
    default:
      throw new Error(
        `Electron browser tab control action ${kind} is invalid.`,
      );
  }
}

function parseBrowserViewTileKey(value: unknown): BrowserViewTileKey {
  const record = readRecord(value, "Electron browser surface key");
  return {
    viewTabId: readNonEmptyString(record.viewTabId, "surface.viewTabId"),
    paneId: readNonEmptyString(record.paneId, "surface.paneId"),
    tileInstanceId: readNonEmptyString(
      record.tileInstanceId,
      "surface.tileInstanceId",
    ),
    pageSessionId: readNonEmptyString(
      record.pageSessionId,
      "surface.pageSessionId",
    ),
  };
}

function readViewportPreset(value: unknown): BrowserViewViewportPresetId {
  if (
    value === "responsive" ||
    value === "mobile" ||
    value === "tablet" ||
    value === "desktop"
  ) {
    return value;
  }
  throw new Error("Electron browser viewportPreset is invalid.");
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} must be an object.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Electron browser tab ${field} must be a non-empty string.`);
}

function readNullableNonEmptyString(
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  return readNonEmptyString(value, field);
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`Electron browser tab ${field} must be a boolean.`);
}
