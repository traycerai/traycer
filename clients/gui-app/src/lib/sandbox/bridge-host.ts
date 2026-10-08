import type { ResolvedTheme } from "@/lib/theme-applier";
import {
  isForwardedShortcut,
  type ForwardedShortcut,
} from "@/lib/sandbox/forwarded-shortcuts";
import type { SandboxNetworkPolicy } from "@/lib/sandbox/mcp-csp";
import type { SandboxPermission } from "@/lib/sandbox/sandbox-url";
import type { SandboxTheme } from "@/lib/sandbox/theme-map";

/**
 * The app side of the sandbox frame, with no DOM in it: the caller hands it
 * every message whose `event.source` is the frame's window and every frame
 * `load`, and gives it a `post` that writes to that window. It speaks the
 * MCP Apps (2026-01-26) JSON-RPC dialect, plus two notifications of ours
 * (`traycer/notifications/document-ready` and `…/shortcut`).
 *
 * Trust is `event.source` alone - an opaque frame's `event.origin` is always
 * "null" - plus one rule about documents: exactly two documents ever load in
 * the frame, the loader and the resource it writes over itself. The written
 * document proves itself with the nonce delivered in
 * `sandbox-resource-ready`. A third load, a second `sandbox-proxy-ready` (the
 * loader came back), or a wrong or repeated nonce disposes the bridge. Loads
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

export interface SandboxBridgeHostOptions {
  readonly resource: SandboxResource;
  readonly nonce: string;
  readonly hostContext: SandboxHostContext;
  readonly hostVersion: string;
  readonly post: (message: unknown) => void;
  readonly events: SandboxBridgeEvents;
  /** `null` for pages and wireframes: app methods answer -32601. */
  readonly appRequests: SandboxAppRequestHandler | null;
}

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/** Messages from the frame larger than this, as UTF-8 JSON, are dropped. */
export const MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;
export const MAX_IN_FLIGHT_APP_REQUESTS = 16;
/** From mount until the written page proves itself with its nonce. */
export const LOAD_TIMEOUT_MS = 15_000;
export const PING_TIMEOUT_MS = 5_000;
export const TEARDOWN_GRACE_MS = 2_000;
/** After the reader declines a link, a frame asks about none for this long. */
export const DECLINED_LINK_QUIET_MS = 2_000;
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
function toInboundJson(data: unknown): InboundJson {
  const json = stringifyJson(data);
  if (json === null) return { kind: "not-json" };
  // A UTF-16 unit never takes more than its UTF-8 bytes, so the length alone
  // refuses a huge message without encoding it.
  if (
    json.length > MAX_INBOUND_MESSAGE_BYTES ||
    utf8.encode(json).byteLength > MAX_INBOUND_MESSAGE_BYTES
  ) {
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
  private earlyError = false;
  private initialized = false;
  private crashed = false;
  private inFlightAppRequests = 0;
  private nextRequestId = 0;
  private linkDeclinedAt: number | null = null;
  /** This frame's claim on {@link linkConfirmOwner}. */
  private readonly linkConfirmKey = {};
  private readonly loadWatchdog: number;
  private readonly queuedNotifications: { method: string; params: unknown }[] =
    [];
  private readonly pendingResponses = new Map<
    RequestId,
    (answered: boolean) => void
  >();
  private readonly timers = new Set<number>();

  constructor(options: SandboxBridgeHostOptions) {
    this.options = options;
    this.hostContext = options.hostContext;
    // A loader that never answers, or a page that never finishes loading,
    // would otherwise sit at "loading" for good.
    this.loadWatchdog = window.setTimeout(() => {
      this.timers.delete(this.loadWatchdog);
      this.markCrashed();
    }, LOAD_TIMEOUT_MS);
    this.timers.add(this.loadWatchdog);
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
    const json = toInboundJson(data);
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
      if (message.id === null) return;
      const settle = this.pendingResponses.get(message.id);
      this.pendingResponses.delete(message.id);
      settle?.(true);
      return;
    }
    if (message.method === "ui/notifications/sandbox-proxy-ready") {
      this.onProxyReady();
      return;
    }
    if (this.phase === "awaiting-proxy") return;
    this.dispatch(message);
  }

  /** The frame element fired `load`. */
  frameLoaded(): void {
    if (this.phase === "disposed") return;
    this.loads += 1;
    if (this.loads > 2) this.dispose();
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

  private onProxyReady(): void {
    if (this.phase !== "awaiting-proxy") {
      // The loader came back: the frame was reloaded or navigated to it.
      this.dispose();
      return;
    }
    const { resource } = this.options;
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
        nonce: this.options.nonce,
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

  private dispatch(message: InboundMessage): void {
    const { method, id, params } = message;
    switch (method) {
      case "traycer/notifications/document-ready":
        this.onDocumentReady(params);
        return;
      case "traycer/notifications/early-error":
        if (this.phase === "delivered") this.earlyError = true;
        return;
      case "traycer/notifications/shortcut": {
        const press = parseShortcutPress(params);
        if (press === null) return;
        const forwarded = this.options.resource.forwardedShortcuts;
        // Bare Escape only from the proven page, and only while fullscreen.
        const exitsFullscreen =
          this.phase === "ready" &&
          this.hostContext.displayMode === "fullscreen" &&
          isForwardedShortcut([FULLSCREEN_EXIT], press);
        if (exitsFullscreen || isForwardedShortcut(forwarded, press)) {
          this.options.events.onShortcut(press);
        }
        return;
      }
      case "ui/notifications/size-changed":
        if (isRecord(params)) {
          this.options.events.onSize({
            width: finiteSize(params.width),
            height: finiteSize(params.height),
          });
        }
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
    const valid =
      this.phase === "delivered" &&
      isRecord(params) &&
      params.nonce === this.options.nonce;
    if (!valid) {
      this.dispose();
      return;
    }
    this.phase = "ready";
    window.clearTimeout(this.loadWatchdog);
    this.timers.delete(this.loadWatchdog);
    // Too late: the watchdog already reported this frame.
    if (this.crashed) return;
    const height = finiteSize(params.height);
    if (this.earlyError && (height === null || height === 0)) {
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
    this.request("ping", {}, PING_TIMEOUT_MS, (answered) => {
      if (!answered) this.markCrashed();
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
