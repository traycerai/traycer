import type {
  BrowserViewCapturePageResult,
  BrowserViewConsoleEntry,
  BrowserViewElementCapture,
  BrowserViewNetworkEntry,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserContextAttachmentWire } from "@traycer/protocol/host/agent/gui/subscribe";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isBrowserSessionTileRef } from "@/stores/epics/canvas/types";

export type BrowserContextAttachmentKind =
  | "browser-console-entry"
  | "browser-network-request"
  | "browser-screenshot"
  | "browser-element"
  | "browser-debug-context";

export type BrowserObserveDataLevel =
  | "console-entry"
  | "network-request"
  | "screenshot"
  | "element"
  | "debug-errors"
  | "debug-snapshot";

export interface BrowserObserveGrant {
  readonly kind: "visible-browser-observe-grant";
  readonly chatId: string;
  readonly tileInstanceId: string;
  readonly origin: string;
  readonly dataLevel: BrowserObserveDataLevel;
  readonly expiresAt: number;
}

export interface BrowserObserveGrantRequest {
  readonly kind: "visible-browser-observe-grant-request";
  readonly chatId: string | null;
  readonly tileInstanceId: string;
  readonly origin: string;
  readonly dataLevel: BrowserObserveDataLevel;
  readonly expiresAt: number | null;
  readonly sourceAction:
    | "browser-console-row-send"
    | "browser-network-row-send"
    | "browser-screenshot-send"
    | "browser-element-send"
    | "browser-composer-attach";
}

interface BrowserContextAttachmentBase {
  readonly schemaVersion: 1;
  readonly kind: BrowserContextAttachmentKind;
  readonly source: {
    readonly tile: BrowserViewTileKey;
    readonly pageUrl: string;
    readonly origin: string;
    readonly capturedAt: number;
  };
  readonly observeGrantRequest: BrowserObserveGrantRequest;
  readonly observeGrant: BrowserObserveGrant | null;
  readonly composerText: string;
}

export interface BrowserConsoleContextAttachment extends BrowserContextAttachmentBase {
  readonly kind: "browser-console-entry";
  readonly consoleEntry: BrowserViewConsoleEntry;
}

export interface BrowserNetworkContextAttachment extends BrowserContextAttachmentBase {
  readonly kind: "browser-network-request";
  readonly networkRequest: BrowserViewNetworkEntry;
}

export interface BrowserScreenshotContextAttachment extends BrowserContextAttachmentBase {
  readonly kind: "browser-screenshot";
  readonly screenshot: {
    readonly mediaType: string;
    readonly base64: string;
    readonly byteLength: number;
    readonly hash: string;
    readonly attachmentsMapKey: string;
    readonly name: string;
  };
}

export interface BrowserElementContextAttachment extends BrowserContextAttachmentBase {
  readonly kind: "browser-element";
  readonly element: BrowserViewElementCapture;
}

/**
 * Ticket 22 fixup: `title` and `screenshot` were traced and found dead -
 * `browserContextAttachmentToWire` only ever selects
 * `kind`/`origin`/`pageUrl`/`composerText`/`tileInstanceId` off any
 * attachment payload, and no other production code reads `payload.title`
 * or `payload.screenshot.*` for this kind (only test assertions did, which
 * is what made the dead fields look load-bearing). Carrying `screenshot`
 * meant retaining a captured base64 image in composer draft state for a
 * consumer that never reads it - a real memory cost for nothing. If a
 * future UI surface needs the title or a screenshot preview for this kind,
 * add it back deliberately with a real reader, not as leftover capture
 * plumbing.
 */
export interface BrowserDebugContextAttachment extends BrowserContextAttachmentBase {
  readonly kind: "browser-debug-context";
  readonly dataLevel: "screenshot" | "debug-errors" | "debug-snapshot";
  readonly consoleEntries: readonly BrowserViewConsoleEntry[];
  readonly networkEntries: readonly BrowserViewNetworkEntry[];
}

export type BrowserContextAttachmentPayload =
  | BrowserConsoleContextAttachment
  | BrowserNetworkContextAttachment
  | BrowserScreenshotContextAttachment
  | BrowserElementContextAttachment
  | BrowserDebugContextAttachment;

export type BrowserContextAttachmentResult =
  | {
      readonly status: "attached";
      readonly payload: BrowserContextAttachmentPayload;
    }
  | {
      readonly status: "unhandled";
      readonly payload: BrowserContextAttachmentPayload;
      readonly reason: "ticket-12-handler-not-registered";
    };

export interface BrowserContextAttachmentRequest {
  readonly targetChatId: string;
  readonly payload: BrowserContextAttachmentPayload;
}

export type BrowserContextAttachmentHandler = (
  request: BrowserContextAttachmentRequest,
) => Promise<BrowserContextAttachmentResult> | BrowserContextAttachmentResult;

const activeHandlers = new Set<BrowserContextAttachmentHandler>();

export function registerBrowserContextAttachmentHandler(
  handler: BrowserContextAttachmentHandler,
): { dispose: () => void } {
  activeHandlers.add(handler);
  return {
    dispose: () => {
      activeHandlers.delete(handler);
    },
  };
}

export async function requestBrowserContextAttachment(
  payload: BrowserContextAttachmentPayload,
  input: { readonly targetChatId: string },
): Promise<BrowserContextAttachmentResult> {
  const request = { targetChatId: input.targetChatId, payload };
  for (const handler of Array.from(activeHandlers).reverse()) {
    const result = await handler(request);
    if (result.status === "attached") return result;
  }
  return {
    status: "unhandled",
    payload,
    reason: "ticket-12-handler-not-registered",
  };
}

export function createBrowserConsoleAttachment(input: {
  readonly tile: BrowserViewTileKey;
  readonly pageUrl: string;
  readonly entry: BrowserViewConsoleEntry;
}): BrowserConsoleContextAttachment {
  const origin = originFromUrl(input.pageUrl);
  const capturedAt = Date.now();
  return {
    schemaVersion: 1,
    kind: "browser-console-entry",
    source: {
      tile: input.tile,
      pageUrl: input.pageUrl,
      origin,
      capturedAt,
    },
    observeGrantRequest: createGrantRequest({
      tile: input.tile,
      origin,
      dataLevel: "console-entry",
      sourceAction: "browser-console-row-send",
    }),
    observeGrant: null,
    composerText: consoleComposerText(input.entry, input.pageUrl),
    consoleEntry: input.entry,
  };
}

export function createBrowserNetworkAttachment(input: {
  readonly tile: BrowserViewTileKey;
  readonly pageUrl: string;
  readonly entry: BrowserViewNetworkEntry;
}): BrowserNetworkContextAttachment {
  const origin = originFromUrl(input.pageUrl);
  const capturedAt = Date.now();
  return {
    schemaVersion: 1,
    kind: "browser-network-request",
    source: {
      tile: input.tile,
      pageUrl: input.pageUrl,
      origin,
      capturedAt,
    },
    observeGrantRequest: createGrantRequest({
      tile: input.tile,
      origin,
      dataLevel: "network-request",
      sourceAction: "browser-network-row-send",
    }),
    observeGrant: null,
    composerText: networkComposerText(input.entry, input.pageUrl),
    networkRequest: input.entry,
  };
}

export function createBrowserScreenshotAttachment(input: {
  readonly tile: BrowserViewTileKey;
  readonly pageUrl: string;
  readonly capture: BrowserViewCapturePageResult;
}): BrowserScreenshotContextAttachment {
  const origin = originFromUrl(input.pageUrl);
  const capturedAt = input.capture.capturedAt;
  const name = `browser-screenshot-${input.capture.sha256.slice(0, 12)}.png`;
  return {
    schemaVersion: 1,
    kind: "browser-screenshot",
    source: {
      tile: input.tile,
      pageUrl: input.pageUrl,
      origin,
      capturedAt,
    },
    observeGrantRequest: createGrantRequest({
      tile: input.tile,
      origin,
      dataLevel: "screenshot",
      sourceAction: "browser-screenshot-send",
    }),
    observeGrant: null,
    composerText: screenshotComposerText(input.capture),
    screenshot: {
      mediaType: input.capture.mediaType,
      base64: input.capture.base64,
      byteLength: input.capture.byteLength,
      hash: input.capture.sha256,
      attachmentsMapKey: input.capture.sha256,
      name,
    },
  };
}

export function createBrowserDebugContextAttachment(input: {
  readonly tile: BrowserViewTileKey;
  readonly pageUrl: string;
  readonly dataLevel: "screenshot" | "debug-errors" | "debug-snapshot";
  readonly capture: BrowserViewCapturePageResult;
  readonly consoleEntries: readonly BrowserViewConsoleEntry[];
  readonly networkEntries: readonly BrowserViewNetworkEntry[];
}): BrowserDebugContextAttachment {
  const origin = originFromUrl(input.pageUrl);
  const capturedAt = input.capture.capturedAt;
  return {
    schemaVersion: 1,
    kind: "browser-debug-context",
    source: {
      tile: input.tile,
      pageUrl: input.pageUrl,
      origin,
      capturedAt,
    },
    observeGrantRequest: createGrantRequest({
      tile: input.tile,
      origin,
      dataLevel: input.dataLevel,
      sourceAction: "browser-composer-attach",
    }),
    observeGrant: null,
    composerText: debugContextComposerText({
      dataLevel: input.dataLevel,
      consoleEntries: input.consoleEntries,
      networkEntries: input.networkEntries,
      hash: input.capture.sha256,
    }),
    dataLevel: input.dataLevel,
    consoleEntries: input.consoleEntries,
    networkEntries: input.networkEntries,
  };
}

export function mintBrowserObserveGrant(
  payload: BrowserContextAttachmentPayload,
  input: { readonly chatId: string; readonly expiresAt: number },
): BrowserContextAttachmentPayload {
  const grant: BrowserObserveGrant = {
    kind: "visible-browser-observe-grant",
    chatId: input.chatId,
    tileInstanceId: payload.source.tile.tileInstanceId,
    origin: payload.source.origin,
    dataLevel: payload.observeGrantRequest.dataLevel,
    expiresAt: input.expiresAt,
  };
  return {
    ...payload,
    observeGrantRequest: {
      ...payload.observeGrantRequest,
      chatId: input.chatId,
      expiresAt: input.expiresAt,
    },
    observeGrant: grant,
  };
}

function createGrantRequest(input: {
  readonly tile: BrowserViewTileKey;
  readonly origin: string;
  readonly dataLevel: BrowserObserveDataLevel;
  readonly sourceAction: BrowserObserveGrantRequest["sourceAction"];
}): BrowserObserveGrantRequest {
  return {
    kind: "visible-browser-observe-grant-request",
    chatId: null,
    tileInstanceId: input.tile.tileInstanceId,
    origin: input.origin,
    dataLevel: input.dataLevel,
    expiresAt: null,
    sourceAction: input.sourceAction,
  };
}

function consoleComposerText(
  entry: BrowserViewConsoleEntry,
  pageUrl: string,
): string {
  return [
    "Browser console entry",
    `Page: ${pageUrl}`,
    `Level: ${entry.level}`,
    `Source: ${entry.source}`,
    `Message: ${entry.text}`,
    locationLine(entry.url, entry.lineNumber, entry.columnNumber),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function networkComposerText(
  entry: BrowserViewNetworkEntry,
  pageUrl: string,
): string {
  return [
    "Browser network request",
    `Page: ${pageUrl}`,
    `Request: ${entry.method} ${entry.url}`,
    `Status: ${networkStatusLabel(entry)}`,
    entry.mimeType === null ? null : `Type: ${entry.mimeType}`,
    entry.durationMs === null ? null : `Duration: ${entry.durationMs} ms`,
    entry.failureText === null ? null : `Failure: ${entry.failureText}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Ticket 29 (A2): no `Page:` line (volatile state, belongs in the
 * observation not a static block) and no `Image: <name>` line - siblings of
 * ticket 22's `debugContextComposerText` fix that were not swept at the
 * time. See that function's doc comment for why: the name never had an
 * image attached beside it in this attachment's own wire shape.
 */
function screenshotComposerText(capture: BrowserViewCapturePageResult): string {
  return [
    "Browser screenshot",
    `Content hash: ${capture.sha256}`,
    `Size: ${capture.byteLength} bytes`,
  ].join("\n");
}

/**
 * Ticket 22: no `Page:`/`Title:` lines - that's volatile state the
 * `<browser_tile>` wrapper and `composerText` used to duplicate, and it goes
 * stale the moment the user navigates (F4); `snapshot()`'s envelope is the
 * single source of truth now. No `Screenshot: <name>` line either - that
 * name never had an image attached beside it (the wire schema for this
 * attachment carries no image bytes), which is exactly the filename-with-
 * no-picture pattern F4/F-vision flagged as inviting false trust.
 */
function debugContextComposerText(input: {
  readonly dataLevel: "screenshot" | "debug-errors" | "debug-snapshot";
  readonly consoleEntries: readonly BrowserViewConsoleEntry[];
  readonly networkEntries: readonly BrowserViewNetworkEntry[];
  readonly hash: string;
}): string {
  return [
    "Browser context",
    `Level: ${browserDebugDataLevelLabel(input.dataLevel)}`,
    `Content hash: ${input.hash}`,
    input.consoleEntries.length === 0
      ? null
      : `Console errors:\n${input.consoleEntries
          .map((entry) => `- ${entry.text}`)
          .join("\n")}`,
    input.networkEntries.length === 0
      ? null
      : `Network errors:\n${input.networkEntries
          .map(
            (entry) =>
              `- ${entry.method} ${entry.url}: ${networkStatusLabel(entry)}`,
          )
          .join("\n")}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function browserDebugDataLevelLabel(
  dataLevel: "screenshot" | "debug-errors" | "debug-snapshot",
): string {
  if (dataLevel === "debug-errors")
    return "screenshot + console/network errors";
  if (dataLevel === "debug-snapshot") return "full debug snapshot";
  return "screenshot";
}

function networkStatusLabel(entry: BrowserViewNetworkEntry): string {
  if (entry.status === "failed") {
    return `failed${entry.failureText === null ? "" : ` (${entry.failureText})`}`;
  }
  if (entry.statusCode !== null) {
    return `${entry.statusCode}${entry.statusText === null ? "" : ` ${entry.statusText}`}`;
  }
  return entry.status;
}

function locationLine(
  url: string | null,
  lineNumber: number | null,
  columnNumber: number | null,
): string | null {
  if (url === null) return null;
  if (lineNumber === null) return `Location: ${url}`;
  const column = columnNumber === null ? "" : `:${columnNumber}`;
  return `Location: ${url}:${lineNumber}${column}`;
}

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "local";
  }
}

/**
 * Managed browser identity is read from the BrowserSessionTileRef itself.
 * Native surface bindings never become a second identity directory. Ordinary
 * user-owned browser tiles retain their canvas instance id on this legacy wire.
 */
export function browserContextAttachmentToWire(
  payload: BrowserContextAttachmentPayload,
): BrowserContextAttachmentWire {
  return {
    kind: payload.kind,
    origin: payload.source.origin,
    pageUrl: payload.source.pageUrl,
    composerText: payload.composerText,
    tabId: browserContextTabId(payload.source.tile),
  };
}

function browserContextTabId(tile: BrowserViewTileKey): string {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tile.viewTabId];
  const source = canvas?.tilesByInstanceId[tile.tileInstanceId];
  return source !== undefined && isBrowserSessionTileRef(source)
    ? source.tabId
    : tile.tileInstanceId;
}
