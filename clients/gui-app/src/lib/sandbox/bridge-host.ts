import {
  parseCanvasZoomGesture,
  type CanvasZoomGesture,
} from "./canvas-bridge";
import {
  parseCanvasSiblingLayout,
  type CanvasSiblingLayout,
} from "./canvas-layout-bridge";
import {
  canvasRecord,
  parseCanvasBox,
  parseCanvasElement,
  parseCanvasPageError,
  parseCanvasRelativeLink,
  parseCanvasTextSelection,
  type CanvasBox,
  type CanvasElement,
  type CanvasElementLocator,
  type CanvasMode,
  type CanvasPageError,
  type CanvasTextSelection,
} from "./canvas-bridge";
import type { ResolvedTheme } from "@/lib/theme-applier";
import {
  isForwardedShortcut,
  type ForwardedShortcut,
} from "@/lib/sandbox/forwarded-shortcuts";
import type { SandboxNetworkPolicy } from "@/lib/sandbox/mcp-csp";
import type { SandboxPermission } from "@/lib/sandbox/sandbox-url";
import type { SandboxTheme } from "@/lib/sandbox/theme-map";
import { MAX_EMBEDDED_DOWNLOAD_BYTES } from "@/lib/sandbox/download-limits";
import { parseArtifactAddress } from "./artifact-serving/artifact-address";

/**
 * The app side of the sandbox frame, with no DOM in it: the caller hands it
 * every message whose `event.source` is the frame's window and every frame
 * `load`, and gives it a `post` that writes to that window. It speaks the
 * MCP Apps (2026-01-26) JSON-RPC dialect, plus two notifications of ours
 * (`traycer/notifications/document-ready` and `…/shortcut`).
 *
 * Trust is `event.source` alone - an opaque frame's `event.origin` is always
 * "null" - plus a nonce that proves the composed document. Loader mode allows
 * two loads (the loader and its rewrite); served mode allows only one and
 * needs no resource handshake, unless it serves a folder of pages, where each
 * further load is the reader moving to another page and must prove itself
 * again. An extra load, an unexpected proxy-ready, or a wrong or repeated
 * nonce disposes the bridge. Loads
 * are COUNTED rather than ordered because the frame's messages and its
 * `load` events reach the app on different paths and can arrive in either
 * order. A page that rewrites itself trips the count too, which fails safe.
 */

export type SandboxKind = "page" | "wireframe" | "app";

export interface SandboxResource {
  readonly html: string;
  readonly kind: SandboxKind;
  readonly networkPolicy: SandboxNetworkPolicy;
  /** The meta policy the loader adds, or `null` for none (`open` pages). */
  readonly csp: string | null;
  readonly permissions: readonly SandboxPermission[];
  readonly theme: SandboxTheme;
  readonly forwardedShortcuts: readonly ForwardedShortcut[];
}

export type SandboxDisplayMode = "inline" | "fullscreen";

/** The MCP Apps `hostContext`, as much of it as we fill. */
export interface SandboxHostContext {
  readonly theme: ResolvedTheme;
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly displayMode: SandboxDisplayMode;
  readonly availableDisplayModes: readonly SandboxDisplayMode[];
  readonly platform: "desktop" | "mobile" | "web";
}

export type SandboxStatus = "loading" | "ready" | "crashed" | "disposed";

export interface SandboxSize {
  readonly width: number | null;
  readonly height: number | null;
}

export interface SandboxShortcutPress extends ForwardedShortcut {
  readonly key: string;
}

/** Which way a wheel or swipe inside the frame moved the reader. */
export type SandboxScrollDirection = "toward-end" | "away-from-end";

/**
 * Dispatched (bubbling) on the frame element for each wheel or swipe inside
 * the frame, with a {@link SandboxScrollDirection} as `detail`. Input in the
 * frame's own document never reaches the listeners around the frame, so a
 * scroll container that tells reader scrolling from layout listens for this.
 */
export const SANDBOX_SCROLL_GESTURE_EVENT = "traycer:sandbox-scroll-gesture";

/** A wheel the page could not use, in CSS pixels, for the app to scroll by. */
export interface SandboxWheel {
  readonly deltaX: number;
  readonly deltaY: number;
}

/** One wheel event never moves the app further than this, whatever a page sends. */
const MAX_WHEEL_DELTA_PX = 4000;
const WHEEL_LINE_PX = 16;

export interface SandboxBridgeEvents {
  readonly onCanvasZoom?: (gesture: CanvasZoomGesture) => void;
  readonly onHtmlZoom?: (scale: number) => void;
  readonly onDoubleClick?: (element: CanvasElement) => void;
  readonly onTextSelection?: (selection: CanvasTextSelection | null) => void;
  readonly onPageError?: (error: CanvasPageError) => void;
  readonly onRelativeLink?: (href: string) => void;
  readonly onStatus: (status: SandboxStatus) => void;
  readonly onSize: (size: SandboxSize) => void;
  /**
   * Ask the reader to confirm an http(s) link the page asked to open, and open
   * it if they do. Resolves `true` once opened, `false` when they declined.
   * The frame cannot prove the reader clicked inside it (page script can fake
   * focus and activation), so every request is confirmed by the app (D42).
   * A confirm still showing must be taken down when `onStatus` reports
   * "disposed".
   */
  readonly onOpenLink: (url: string) => Promise<boolean>;
  /** Only presses that match a forwarded chord are reported. */
  readonly onShortcut: (press: SandboxShortcutPress) => void;
  readonly onRequestTeardown: () => void;
  readonly onScrollGesture: (direction: SandboxScrollDirection) => void;
  readonly onWheel: (wheel: SandboxWheel) => void;
}

/**
 * Serves the requests only an MCP App may make (`tools/call`,
 * `resources/read`, …). A rejection is answered as a JSON-RPC error.
 */
export type SandboxAppRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

/**
 * A plain-html artifact is a folder of pages the reader moves between inside
 * one frame. Paths are relative to the artifact's folder; a page above it
 * reads `../…`.
 */
export interface SandboxServedPages {
  /** The artifact's folder relative to the artifacts tree root. */
  readonly treePath: string;
  readonly onNavigate: (path: string) => void;
  /** The frame moved to something the artifact does not have as a page. */
  readonly onPageMissing: () => void;
}

export interface SandboxBridgeHostOptions {
  readonly document:
    | {
        readonly kind: "loader";
        readonly resource: SandboxResource;
        readonly nonce: string;
      }
    | {
        readonly kind: "served";
        readonly canvas?: boolean;
        readonly nonce: string;
        readonly forwardedShortcuts: readonly ForwardedShortcut[];
        /** `null` keeps the one-document rule: a canvas board never moves. */
        readonly pages: SandboxServedPages | null;
      };
  readonly hostContext: SandboxHostContext;
  readonly hostVersion: string;
  readonly post: (message: unknown) => void;
  readonly events: SandboxBridgeEvents;
  /** `null` for pages and wireframes: app methods answer -32601. */
  readonly appRequests: SandboxAppRequestHandler | null;
}

function documentShortcuts(
  document: SandboxBridgeHostOptions["document"],
): readonly ForwardedShortcut[] {
  return document.kind === "loader"
    ? document.resource.forwardedShortcuts
    : document.forwardedShortcuts;
}

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/** Ordinary messages from the frame are bounded as UTF-8 JSON. */
export const MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;
/**
 * Embedded app downloads need room for their encoded bytes plus the envelope.
 * JSON can expand one text byte to six characters (a Unicode escape), which
 * also covers base64's four-for-three expansion. The handler still enforces
 * the decoded per-file limit; this separate cap bounds the whole request.
 */
const MAX_INBOUND_DOWNLOAD_MESSAGE_BYTES =
  6 * MAX_EMBEDDED_DOWNLOAD_BYTES + MAX_INBOUND_MESSAGE_BYTES;
export const MAX_IN_FLIGHT_APP_REQUESTS = 16;
/** From mount until the written page proves itself with its nonce. */
export const LOAD_TIMEOUT_MS = 15_000;
export const PING_TIMEOUT_MS = 5_000;
/**
 * A later page's ready follows its load within milliseconds. A load with no
 * ready after this long is a document without the prelude: a child
 * artifact's page, served as it is, or a file that is not a page.
 */
export const PAGE_HANDSHAKE_TIMEOUT_MS = 2_000;
export const TEARDOWN_GRACE_MS = 2_000;
/** After the reader declines a link, a frame asks about none for this long. */
export const DECLINED_LINK_QUIET_MS = 2_000;
/**
 * The tallest page that errored before it loaded and still counts as having
 * drawn nothing: an empty body with the browser's default 8px margins measures
 * 16px, so this leaves room for those and a stray empty line, and no room for
 * a real heading or chart.
 */
export const CRASHED_PAGE_MAX_HEIGHT_PX = 32;
/**
 * A link longer than this is refused before the reader is asked: no one can
 * check it, and the confirm has to show all of it. A parsed URL's `href` is
 * ASCII, so this is bytes as well as characters.
 */
export const MAX_LINK_URL_CHARS = 8 * 1024;

/**
 * The frame whose link the reader is being asked about, app-wide: one confirm
 * at a time across every visible frame, so several pages cannot chain prompts.
 */
let linkConfirmOwner: object | null = null;

const APP_METHODS: ReadonlySet<string> = new Set([
  "tools/call",
  "resources/read",
  "ui/message",
  "ui/update-model-context",
  "ui/request-display-mode",
  "ui/download-file",
]);

const BEFORE_DOCUMENT_PROOF: ReadonlySet<string> = new Set([
  "traycer/notifications/document-ready",
  "traycer/notifications/early-error",
  "ping",
]);

/** The page forwards this while fullscreen (`host-context-changed`). */
const FULLSCREEN_EXIT: ForwardedShortcut = {
  code: "Escape",
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
};

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SERVER_BUSY = -32000;

type RequestId = string | number;

interface InboundMessage {
  readonly method: string | null;
  readonly id: RequestId | null;
  readonly params: unknown;
  readonly isResponse: boolean;
}

type Phase = "awaiting-proxy" | "delivered" | "ready" | "disposed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

type InboundJson =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "not-json" };

const utf8 = new TextEncoder();

/**
 * Only plain objects, arrays and primitives: a structured clone can also carry
 * an ArrayBuffer, a Map, a Date or a boxed string, none of which is JSON.
 */
function isJsonTree(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }
  return Object.values(value).every(isJsonTree);
}

/** The message as JSON text, or `null` when it is not JSON. */
function stringifyJson(data: unknown): string | null {
  try {
    // A cycle or a BigInt throws here, and so does nesting too deep to walk.
    const json: unknown = JSON.stringify(data);
    return typeof json === "string" && isJsonTree(data) ? json : null;
  } catch {
    return null;
  }
}

/**
 * The message as the JSON it would be on the wire, measured in UTF-8 bytes.
 * What is dispatched is that JSON parsed back, never the structured clone the
 * frame posted.
 */
function toInboundJson(data: unknown, maxBytes: number): InboundJson {
  const json = stringifyJson(data);
  if (json === null) return { kind: "not-json" };
  // A UTF-16 unit never takes more than its UTF-8 bytes, so the length alone
  // refuses a huge message without encoding it.
  if (json.length > maxBytes || utf8.encode(json).byteLength > maxBytes) {
    return { kind: "too-large" };
  }
  const value: unknown = JSON.parse(json);
  return { kind: "ok", value };
}

function parseInbound(data: unknown): InboundMessage | null {
  if (!isRecord(data) || data.jsonrpc !== "2.0") return null;
  const id = isRequestId(data.id) ? data.id : null;
  if (typeof data.method === "string") {
    return { method: data.method, id, params: data.params, isResponse: false };
  }
  if (id !== null && ("result" in data || "error" in data)) {
    return { method: null, id, params: null, isResponse: true };
  }
  return null;
}

function parseHtmlZoom(params: unknown): number | null {
  if (!isRecord(params) || typeof params.scale !== "number") return null;
  const { scale } = params;
  return Number.isFinite(scale) && scale >= 0.25 && scale <= 4 ? scale : null;
}

function finiteSize(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parseShortcutPress(params: unknown): SandboxShortcutPress | null {
  if (!isRecord(params)) return null;
  const { key, code, ctrl, meta, alt, shift } = params;
  if (typeof key !== "string" || typeof code !== "string") return null;
  if (
    typeof ctrl !== "boolean" ||
    typeof meta !== "boolean" ||
    typeof alt !== "boolean" ||
    typeof shift !== "boolean"
  ) {
    return null;
  }
  return { key, code, ctrl, meta, alt, shift };
}

function parseHttpUrl(params: unknown): string | null {
  if (!isRecord(params) || typeof params.url !== "string") return null;
  try {
    const url = new URL(params.url);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A served page's path relative to the artifact's folder, from its URL. */
function pagePathFromUrl(url: unknown, treePath: string): string | null {
  if (typeof url !== "string") return null;
  const address = parseArtifactAddress(url);
  if (address === null) return null;
  if (treePath === "") return address.path;
  const folder = treePath.split("/");
  const page = address.path.split("/");
  let shared = 0;
  while (
    shared < folder.length &&
    shared < page.length - 1 &&
    folder[shared] === page[shared]
  ) {
    shared += 1;
  }
  return "../".repeat(folder.length - shared) + page.slice(shared).join("/");
}

function changedContext(
  previous: SandboxHostContext,
  next: SandboxHostContext,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    const before: unknown = Reflect.get(previous, key);
    const after: unknown = Reflect.get(next, key);
    if (JSON.stringify(before) !== JSON.stringify(after)) changed[key] = after;
  }
  return changed;
}

export class SandboxBridgeHost {
  private readonly options: SandboxBridgeHostOptions;
  private phase: Phase = "awaiting-proxy";
  private hostContext: SandboxHostContext;
  private loads = 0;
  /** Accepted document-ready notifications, counted against loads. */
  private readies = 0;
  /** Documents begun so far; also tells one page's ping from the next's. */
  private documents = 1;
  private earlyError = false;
  private initialized = false;
  private crashed = false;
  private inFlightAppRequests = 0;
  private nextRequestId = 0;
  private linkDeclinedAt: number | null = null;
  /** This frame's claim on {@link linkConfirmOwner}. */
  private readonly linkConfirmKey = {};
  private loadWatchdog: number | null = null;
  private pageHandshakeTimer: number | null = null;
  private readonly queuedNotifications: { method: string; params: unknown }[] =
    [];
  private readonly pendingResponses = new Map<
    RequestId,
    (answered: boolean) => void
  >();
  private readonly timers = new Set<number>();
  private readonly canvasResponses = new Map<
    RequestId,
    {
      readonly timer: number;
      readonly settle: (result: Record<string, unknown> | null) => void;
    }
  >();

  hitTest(point: {
    readonly x: number;
    readonly y: number;
  }): Promise<CanvasElement | null> {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
      return Promise.resolve(null);
    return this.canvasRequest("hit-test", point).then((result) =>
      parseCanvasElement(result?.element),
    );
  }

  setTextSelectionTarget(
    locator: CanvasElementLocator | null,
  ): Promise<boolean> {
    return this.canvasRequest("set-text-selection-target", {
      target: locator,
    }).then((result) => result !== null);
  }

  selectTextRange(points: {
    readonly start: { readonly x: number; readonly y: number };
    readonly end: { readonly x: number; readonly y: number };
  }): Promise<boolean> {
    return this.canvasRequest("select-text-range", points).then(
      (result) => result !== null,
    );
  }

  retypeAt(point: {
    readonly x: number;
    readonly y: number;
  }): Promise<boolean> {
    return this.canvasRequest("retype-at", point).then(
      (result) => result !== null,
    );
  }

  describeElement(
    locator: CanvasElementLocator,
  ): Promise<CanvasElement | null> {
    return this.canvasRequest("describe-element", locator).then((result) =>
      parseCanvasElement(result?.element),
    );
  }

  literalAncestor(
    locator: CanvasElementLocator | { readonly selector: string },
  ): Promise<CanvasElement | null> {
    return this.canvasRequest("literal-ancestor", locator).then((result) =>
      canvasRecord(result) ? parseCanvasElement(result.element) : null,
    );
  }

  textRangeRect(params: {
    readonly tid: string;
    readonly start: number;
    readonly end: number;
    readonly quotedText?: string;
  }): Promise<CanvasBox | null> {
    return this.canvasRequest("text-range-rect", params).then((result) =>
      canvasRecord(result) ? parseCanvasBox(result.box) : null,
    );
  }

  elementBox(locator: CanvasElementLocator): Promise<CanvasBox | null> {
    return this.canvasRequest("element-box", locator).then((result) =>
      parseCanvasBox(result?.box),
    );
  }

  revealElement(locator: CanvasElementLocator): Promise<boolean> {
    return this.canvasRequest("reveal-element", locator).then(
      (result) => result?.revealed === true,
    );
  }

  siblingLayout(
    locator: CanvasElementLocator,
  ): Promise<CanvasSiblingLayout | null> {
    return this.canvasRequest("sibling-layout", locator).then((result) =>
      parseCanvasSiblingLayout(result?.layout),
    );
  }

  navigateCanvas(destination: {
    readonly search: string;
    readonly hash: string;
  }): Promise<boolean> {
    return this.canvasRequest("navigate", destination).then(
      (result) => result !== null,
    );
  }

  setMode(mode: CanvasMode): Promise<boolean> {
    return this.canvasRequest("set-mode", { mode }).then(
      (result) => result !== null,
    );
  }

  private canvasDocumentProven(): boolean {
    return (
      this.options.document.kind === "served" &&
      this.options.document.canvas === true &&
      this.phase === "ready"
    );
  }

  private canvasEnabled(): boolean {
    return this.canvasDocumentProven() && !this.crashed;
  }

  private canvasRequest(
    method: string,
    params: object,
  ): Promise<Record<string, unknown> | null> {
    if (!this.canvasEnabled() || this.canvasResponses.size >= 32)
      return Promise.resolve(null);
    return new Promise((settle) => {
      this.nextRequestId += 1;
      const id = `traycer-canvas-${this.nextRequestId}`;
      const timer = window.setTimeout(() => {
        this.canvasResponses.delete(id);
        settle(null);
      }, PING_TIMEOUT_MS);
      this.canvasResponses.set(id, { timer, settle });
      this.post({
        jsonrpc: "2.0",
        id,
        method: `traycer/canvas/${method}`,
        params: { ...params, nonce: this.options.document.nonce },
      });
    });
  }

  private receiveCanvasResponse(data: unknown, id: RequestId): boolean {
    const pending = this.canvasResponses.get(id);
    if (pending === undefined) return false;
    if (
      !this.canvasEnabled() ||
      !canvasRecord(data) ||
      !canvasRecord(data.result) ||
      data.result.nonce !== this.options.document.nonce
    )
      return true;
    this.canvasResponses.delete(id);
    window.clearTimeout(pending.timer);
    pending.settle(data.result);
    return true;
  }

  private receiveCanvasTextSelection(params: Record<string, unknown>): void {
    if (params.selection === null) {
      this.options.events.onTextSelection?.(null);
      return;
    }
    const selection = parseCanvasTextSelection(params);
    if (selection !== null) this.options.events.onTextSelection?.(selection);
  }

  private receiveCanvasZoom(params: unknown): void {
    const gesture = parseCanvasZoomGesture(params);
    if (gesture !== null) this.options.events.onCanvasZoom?.(gesture);
  }

  private receiveCanvasNotification(method: string, params: unknown): void {
    if (
      !this.canvasDocumentProven() ||
      !canvasRecord(params) ||
      params.nonce !== this.options.document.nonce
    )
      return;
    // Startup/liveness failures can mark a proven page crashed before its
    // buffered error arrives. Diagnostics still belong on that board's pill.
    if (method === "traycer/canvas/page-error") {
      const error = parseCanvasPageError(params);
      if (error !== null) this.options.events.onPageError?.(error);
      return;
    }
    if (!this.canvasEnabled()) return;
    if (method === "traycer/canvas/double-click") {
      const element = parseCanvasElement(params.element);
      if (element !== null) this.options.events.onDoubleClick?.(element);
    } else if (method === "traycer/canvas/text-selection") {
      this.receiveCanvasTextSelection(params);
    } else if (method === "traycer/canvas/zoom") {
      this.receiveCanvasZoom(params);
    } else if (method === "traycer/canvas/relative-link") {
      const href = parseCanvasRelativeLink(params);
      if (href !== null) this.options.events.onRelativeLink?.(href);
    }
  }

  constructor(options: SandboxBridgeHostOptions) {
    this.options = options;
    this.hostContext = options.hostContext;
    if (options.document.kind === "served") this.phase = "delivered";
    this.armLoadWatchdog();
  }

  /**
   * A loader that never answers, or a page that never finishes loading,
   * would otherwise sit at "loading" for good.
   */
  private armLoadWatchdog(): void {
    this.clearTimer(this.loadWatchdog);
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      this.loadWatchdog = null;
      this.markCrashed();
    }, LOAD_TIMEOUT_MS);
    this.loadWatchdog = timer;
    this.timers.add(timer);
  }

  private clearTimer(timer: number | null): void {
    if (timer === null) return;
    window.clearTimeout(timer);
    this.timers.delete(timer);
    if (this.loadWatchdog === timer) this.loadWatchdog = null;
    if (this.pageHandshakeTimer === timer) this.pageHandshakeTimer = null;
  }

  private servedPages(): SandboxServedPages | null {
    const document = this.options.document;
    return document.kind === "served" ? document.pages : null;
  }

  /**
   * The reader moved the frame to another page: it starts over as a freshly
   * served document, and nothing the previous page left pending may answer
   * for it.
   */
  private beginPage(): void {
    this.documents += 1;
    this.phase = "delivered";
    this.earlyError = false;
    this.initialized = false;
    this.crashed = false;
    this.queuedNotifications.length = 0;
    this.clearTimer(this.pageHandshakeTimer);
    const unanswered = [...this.pendingResponses.values()];
    this.pendingResponses.clear();
    for (const settle of unanswered) settle(false);
    for (const { timer, settle } of this.canvasResponses.values()) {
      window.clearTimeout(timer);
      settle(null);
    }
    this.canvasResponses.clear();
    this.armLoadWatchdog();
    this.options.events.onStatus("loading");
  }

  private awaitPageHandshake(): void {
    this.clearTimer(this.pageHandshakeTimer);
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      this.pageHandshakeTimer = null;
      this.reportPageMissing();
    }, PAGE_HANDSHAKE_TIMEOUT_MS);
    this.pageHandshakeTimer = timer;
    this.timers.add(timer);
  }

  private reportPageMissing(): void {
    const pages = this.servedPages();
    if (pages === null || this.phase === "disposed") return;
    // A missing page is an answer, not a hang: it must not turn into a crash.
    this.clearTimer(this.pageHandshakeTimer);
    this.clearTimer(this.loadWatchdog);
    pages.onPageMissing();
  }

  get status(): SandboxStatus {
    if (this.phase === "disposed") return "disposed";
    if (this.crashed) return "crashed";
    return this.phase === "ready" ? "ready" : "loading";
  }

  /** A message whose `event.source` is the frame's window. */
  receive(data: unknown): void {
    if (this.phase === "disposed") return;
    const posted = parseInbound(data);
    if (posted === null) return;
    const maxBytes =
      this.options.appRequests !== null &&
      posted.method === "ui/download-file" &&
      posted.id !== null
        ? MAX_INBOUND_DOWNLOAD_MESSAGE_BYTES
        : MAX_INBOUND_MESSAGE_BYTES;
    const json = toInboundJson(data, maxBytes);
    if (json.kind !== "ok") {
      if (posted.id !== null && !posted.isResponse) {
        const reason =
          json.kind === "too-large"
            ? "Message too large"
            : "Message is not JSON";
        this.respondError(posted.id, INVALID_PARAMS, reason);
      }
      return;
    }
    const message = parseInbound(json.value);
    if (message === null) return;
    if (message.isResponse) {
      this.settleResponse(message.id, json.value);
      return;
    }
    if (message.method === "ui/notifications/sandbox-proxy-ready") {
      this.onProxyReady();
      return;
    }
    if (!this.canDispatch(message.method)) return;
    this.dispatch(message);
  }

  private settleResponse(id: RequestId | null, value: unknown): void {
    if (id === null || this.receiveCanvasResponse(value, id)) return;
    const settle = this.pendingResponses.get(id);
    this.pendingResponses.delete(id);
    settle?.(true);
  }

  private canDispatch(method: string | null): boolean {
    if (this.phase === "awaiting-proxy") return false;
    // Served documents skip the loader handshake, but their callbacks must
    // still wait for the composed document to prove its nonce.
    if (this.options.document.kind === "served" && this.phase !== "ready") {
      return method !== null && BEFORE_DOCUMENT_PROOF.has(method);
    }
    return true;
  }

  /** The frame element fired `load`. */
  frameLoaded(): void {
    if (this.phase === "disposed") return;
    this.loads += 1;
    if (this.servedPages() === null) {
      const allowedLoads = this.options.document.kind === "loader" ? 2 : 1;
      if (this.loads > allowedLoads) this.rejectDocument();
      return;
    }
    // A page's ready may reach the app before its load: whichever comes
    // first begins the new document.
    if (this.loads > this.documents) this.beginPage();
    // The entry page keeps the crash watchdog; a later page that never
    // proves itself was not a page of this artifact.
    if (this.loads > 1 && this.readies < this.loads) this.awaitPageHandshake();
  }

  /** Send `host-context-changed` with the keys that changed, if any. */
  updateHostContext(next: SandboxHostContext): void {
    const changed = changedContext(this.hostContext, next);
    this.hostContext = next;
    if (Object.keys(changed).length === 0) return;
    if (this.phase !== "ready") return;
    this.post({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: changed,
    });
  }

  /** Plain HTML proves readiness without an MCP App's initialized handshake. */
  setHtmlView(enabled: boolean, scale: number): void {
    if (
      this.phase !== "ready" ||
      this.options.document.kind !== "served" ||
      this.options.document.canvas === true
    )
      return;
    this.post({
      jsonrpc: "2.0",
      method: "traycer/html/view",
      params: { enabled, scale },
    });
  }

  /**
   * An app → page notification (`ui/notifications/tool-input`, …). Held until
   * the page says `initialized`, as the spec requires.
   */
  notify(method: string, params: unknown): void {
    if (this.phase === "disposed") return;
    if (!this.initialized) {
      this.queuedNotifications.push({ method, params });
      return;
    }
    this.post({ jsonrpc: "2.0", method, params });
  }

  /**
   * Ask the page to tear down (`ui/resource-teardown`), wait for its answer
   * or the grace period, then dispose.
   */
  async teardown(): Promise<void> {
    if (this.phase === "disposed") return;
    if (this.phase === "awaiting-proxy") {
      this.dispose();
      return;
    }
    await new Promise<void>((resolve) => {
      this.request("ui/resource-teardown", {}, TEARDOWN_GRACE_MS, () => {
        resolve();
      });
    });
    this.dispose();
  }

  dispose(): void {
    if (this.phase === "disposed") return;
    this.phase = "disposed";
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    const unanswered = [...this.pendingResponses.values()];
    this.pendingResponses.clear();
    for (const settle of unanswered) settle(false);
    for (const { timer, settle } of this.canvasResponses.values()) {
      window.clearTimeout(timer);
      settle(null);
    }
    this.canvasResponses.clear();
    this.queuedNotifications.length = 0;
    try {
      // The frame takes down a confirm it is showing on "disposed", so this
      // goes out while the app-wide slot is still held: no other frame's
      // confirm can open beside one that is about to go.
      this.options.events.onStatus("disposed");
    } finally {
      // A confirm that never settles must not hold every other frame's links.
      this.releaseLinkConfirm();
    }
  }

  /** Retire the document before offering recovery; normal teardown stays quiet. */
  private rejectDocument(): void {
    this.dispose();
    this.options.events.onStatus("crashed");
  }

  private onProxyReady(): void {
    if (this.phase !== "awaiting-proxy") {
      // The loader came back: the frame was reloaded or navigated to it.
      this.rejectDocument();
      return;
    }
    const document = this.options.document;
    if (document.kind !== "loader") {
      this.rejectDocument();
      return;
    }
    const { resource } = document;
    this.phase = "delivered";
    this.post({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: {
        html: resource.html,
        kind: resource.kind,
        networkPolicy: resource.networkPolicy,
        csp: resource.csp,
        permissions: resource.permissions,
        nonce: this.options.document.nonce,
        bootstrap: {
          theme: resource.theme,
          forwardedShortcuts: resource.forwardedShortcuts,
        },
      },
    });
  }

  /** A wheel the page gave up, or the direction of a swipe it left to chain. */
  private relayScroll(method: string, params: unknown): void {
    if (method === "traycer/notifications/wheel") {
      const wheel = parseWheel(params);
      if (wheel !== null) this.options.events.onWheel(wheel);
      return;
    }
    if (
      method === "traycer/notifications/scroll-gesture" &&
      isRecord(params) &&
      (params.direction === "toward-end" ||
        params.direction === "away-from-end")
    ) {
      this.options.events.onScrollGesture(params.direction);
    }
  }

  private relayShortcut(params: unknown): void {
    const press = parseShortcutPress(params);
    if (press === null) return;
    const forwarded = documentShortcuts(this.options.document);
    // Bare Escape leaves fullscreen or clears an inline canvas selection.
    const exitsFullscreen =
      this.phase === "ready" &&
      this.hostContext.displayMode === "fullscreen" &&
      isForwardedShortcut([FULLSCREEN_EXIT], press);
    const clearsCanvasSelection =
      this.canvasEnabled() &&
      isRecord(params) &&
      params.nonce === this.options.document.nonce &&
      isForwardedShortcut([FULLSCREEN_EXIT], press);
    if (
      exitsFullscreen ||
      clearsCanvasSelection ||
      isForwardedShortcut(forwarded, press)
    ) {
      this.options.events.onShortcut(press);
    }
  }

  private relayHtmlZoom(params: unknown): void {
    const scale = parseHtmlZoom(params);
    if (scale !== null) this.options.events.onHtmlZoom?.(scale);
  }

  private dispatch(message: InboundMessage): void {
    const { method, id, params } = message;
    switch (method) {
      case "traycer/notifications/document-ready":
        this.onDocumentReady(params);
        return;
      case "traycer/notifications/page-missing":
        if (isRecord(params) && params.nonce === this.options.document.nonce)
          this.reportPageMissing();
        return;
      case "traycer/notifications/early-error":
        if (this.phase === "delivered") this.earlyError = true;
        return;
      case "traycer/notifications/shortcut":
        this.relayShortcut(params);
        return;
      case "ui/notifications/size-changed":
        if (isRecord(params)) {
          this.options.events.onSize({
            width: finiteSize(params.width),
            height: finiteSize(params.height),
          });
        }
        return;
      case "traycer/notifications/html-view":
        this.relayHtmlZoom(params);
        return;
      case "ui/notifications/initialized":
        this.onInitialized();
        return;
      case "ui/notifications/request-teardown":
        this.options.events.onRequestTeardown();
        return;
      default:
        break;
    }
    if (method === null) return;
    if (id === null) {
      this.receiveCanvasNotification(method, params);
      this.relayScroll(method, params);
      return;
    }
    this.handleRequest(id, method, params);
  }

  private handleRequest(id: RequestId, method: string, params: unknown): void {
    if (method === "ping") {
      this.respond(id, {});
      return;
    }
    if (method === "ui/initialize") {
      this.respond(id, {
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
        hostInfo: { name: "Traycer", version: this.options.hostVersion },
        hostCapabilities: this.hostCapabilities(),
        hostContext: this.hostContext,
      });
      return;
    }
    if (method === "ui/open-link") {
      this.handleOpenLink(id, params);
      return;
    }
    const appRequests = this.options.appRequests;
    if (!APP_METHODS.has(method) || appRequests === null) {
      this.respondError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    if (this.inFlightAppRequests >= MAX_IN_FLIGHT_APP_REQUESTS) {
      this.respondError(id, SERVER_BUSY, "Too many requests in flight");
      return;
    }
    this.inFlightAppRequests += 1;
    void appRequests(method, params).then(
      (result) => {
        this.inFlightAppRequests -= 1;
        this.respond(id, result);
      },
      (error: unknown) => {
        this.inFlightAppRequests -= 1;
        const text = error instanceof Error ? error.message : "Request failed";
        this.respondError(id, INTERNAL_ERROR, text);
      },
    );
  }

  /**
   * One confirm at a time across the app, and after the reader declines one a
   * frame asks about nothing for {@link DECLINED_LINK_QUIET_MS}, whatever the
   * URL: a page cannot bury the reader in prompts.
   */
  private handleOpenLink(id: RequestId, params: unknown): void {
    const url = parseHttpUrl(params);
    if (url === null) {
      this.respondError(id, INVALID_PARAMS, "Only http(s) links open");
      return;
    }
    if (url.length > MAX_LINK_URL_CHARS) {
      this.respondError(id, INVALID_PARAMS, "Link too long");
      return;
    }
    if (linkConfirmOwner !== null) {
      this.respondError(id, SERVER_BUSY, "Another link is awaiting the reader");
      return;
    }
    const declinedAt = this.linkDeclinedAt;
    if (
      declinedAt !== null &&
      Date.now() - declinedAt < DECLINED_LINK_QUIET_MS
    ) {
      this.respondError(id, SERVER_BUSY, "Link not opened");
      return;
    }
    linkConfirmOwner = this.linkConfirmKey;
    void this.options.events
      .onOpenLink(url)
      .catch(() => false)
      .then((opened) => {
        this.releaseLinkConfirm();
        if (opened) {
          this.respond(id, {});
          return;
        }
        this.linkDeclinedAt = Date.now();
        this.respondError(id, SERVER_BUSY, "Link not opened");
      });
  }

  private releaseLinkConfirm(): void {
    if (linkConfirmOwner === this.linkConfirmKey) linkConfirmOwner = null;
  }

  private hostCapabilities(): Record<string, unknown> {
    if (this.options.appRequests === null) return { openLinks: {} };
    return {
      openLinks: {},
      serverTools: {},
      serverResources: {},
      updateModelContext: { text: {} },
      message: { text: {} },
      downloadFile: {},
    };
  }

  private onDocumentReady(params: unknown): void {
    if (!isRecord(params) || params.nonce !== this.options.document.nonce) {
      this.rejectDocument();
      return;
    }
    const pages = this.servedPages();
    if (pages !== null) {
      // At most one ready may run ahead of its load.
      if (this.readies > this.loads) {
        this.rejectDocument();
        return;
      }
      this.readies += 1;
      if (this.readies > this.documents) this.beginPage();
      this.clearTimer(this.pageHandshakeTimer);
    }
    if (this.phase !== "delivered") {
      this.rejectDocument();
      return;
    }
    this.phase = "ready";
    this.clearTimer(this.loadWatchdog);
    const path =
      pages === null ? null : pagePathFromUrl(params.url, pages.treePath);
    if (pages !== null && path !== null) pages.onNavigate(path);
    // Too late: the watchdog already reported this frame.
    if (this.crashed) return;
    const height = finiteSize(params.height);
    if (
      this.earlyError &&
      (height === null || height <= CRASHED_PAGE_MAX_HEIGHT_PX)
    ) {
      this.markCrashed();
      return;
    }
    this.options.events.onStatus("ready");
    // What changed while the page loaded (`updateHostContext` waits for
    // ready): a fullscreen entered then must still reach its bootstrap.
    const missed = changedContext(this.options.hostContext, this.hostContext);
    if (Object.keys(missed).length > 0) {
      this.post({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: missed,
      });
    }
    const pinged = this.documents;
    this.request("ping", {}, PING_TIMEOUT_MS, (answered) => {
      // The reader may have moved on: the next page is not the one that hung.
      if (!answered && pinged === this.documents) this.markCrashed();
    });
  }

  private onInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const { method, params } of this.queuedNotifications.splice(0)) {
      this.post({ jsonrpc: "2.0", method, params });
    }
  }

  private markCrashed(): void {
    if (this.crashed || this.phase === "disposed") return;
    this.crashed = true;
    this.options.events.onStatus("crashed");
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    settle: (answered: boolean) => void,
  ): void {
    this.nextRequestId += 1;
    const id = `traycer-host-${this.nextRequestId}`;
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.pendingResponses.delete(id)) return;
      settle(false);
    }, timeoutMs);
    this.timers.add(timer);
    this.pendingResponses.set(id, (answered) => {
      window.clearTimeout(timer);
      this.timers.delete(timer);
      settle(answered);
    });
    this.post({ jsonrpc: "2.0", id, method, params });
  }

  private respond(id: RequestId, result: unknown): void {
    this.post({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: RequestId, code: number, message: string): void {
    this.post({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private post(message: unknown): void {
    if (this.phase === "disposed") return;
    this.options.post(message);
  }
}

/** `deltaMode` 1 is lines and 2 is pages; a page is read as a few lines. */
function parseWheel(params: unknown): SandboxWheel | null {
  if (!isRecord(params)) return null;
  const { deltaX, deltaY, deltaMode } = params;
  if (
    typeof deltaX !== "number" ||
    typeof deltaY !== "number" ||
    !Number.isFinite(deltaX) ||
    !Number.isFinite(deltaY)
  ) {
    return null;
  }
  let scale = 1;
  if (deltaMode === 1) scale = WHEEL_LINE_PX;
  if (deltaMode === 2) scale = WHEEL_LINE_PX * 20;
  const clamp = (delta: number): number =>
    Math.max(-MAX_WHEEL_DELTA_PX, Math.min(MAX_WHEEL_DELTA_PX, delta * scale));
  return { deltaX: clamp(deltaX), deltaY: clamp(deltaY) };
}
