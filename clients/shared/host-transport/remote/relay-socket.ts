import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import type { WebSocketCloseEvent, WebSocketErrorEvent } from "../ws-factory";
import type { TimerHandle, IntervalHandle } from "../timer-handle";
import {
  RELAY_DIAL_TIMEOUT_MS,
  RELAY_PING_INTERVAL_MS,
  RELAY_PONG_TIMEOUT_MS,
} from "./config";

/**
 * The persistent client↔relay WebSocket leg (T10 wire protocol; relay-do
 * README). One socket = one relay session = one E2E Noise session (the client's
 * single socket is its single `sid`; the relay assigns and owns `sid`).
 *
 * Responsibilities (transport-only — no Noise, no mux; those sit above):
 *  - present the `role:"client"` attach grant and await `attach_ack{sid}`;
 *  - forward opaque DATA (binary) frames both ways — client leg is `[ciphertext]`
 *    with NO sid prefix (the relay knows the sid from this authenticated socket);
 *  - surface relay CONTROL (text JSON) lifecycle frames as typed callbacks;
 *  - drive the `relay-ping`/`relay-pong` keepalive and fail the socket on missed
 *    pongs (a half-open socket after device sleep);
 *  - re-present a fresh grant in-band via a `reauth` control frame.
 *
 * The grant rides the `?grant=<jws>` query fallback (the relay also accepts the
 * preferred `Sec-WebSocket-Protocol: …, grant.<jws>` header, but the shared
 * `IStreamWebSocketFactory` only takes a URL, so the client uses the query form).
 */

// Kept in lockstep with workers/relay-do/src/config.ts (relay-owned constants).
const KEEPALIVE_PING = "relay-ping";
const KEEPALIVE_PONG = "relay-pong";

/** Relay session-kill / peer-death reasons (mirror relay-do `KillReason`). */
export type RelayKillReason =
  "reauth_timeout" | "revoked" | "host_gone" | "policy_violation";

export interface RelaySocketHandlers {
  /** The relay assigned this client session its `sid`; bridging is live. */
  readonly onAttachAck: (sid: number) => void;
  /** An opaque inbound DATA frame (Noise transport bytes for the layer above). */
  readonly onData: (ciphertext: Uint8Array) => void;
  /** The host's uplink dropped — pause; the same Noise session resumes on re-attach. */
  readonly onHostDetached: () => void;
  /** The host's uplink (re)attached — resume sends on the existing Noise session. */
  readonly onHostAttached: () => void;
  /** The relay acknowledged an in-band `reauth` grant. */
  readonly onReauthAck: () => void;
  /** The peer is gone / the session was killed — the session must full-resume. */
  readonly onPeerGone: (reason: RelayKillReason) => void;
  /** A recoverable relay protocol error (no close). */
  readonly onError: (code: string, message: string) => void;
  /** The socket dropped (any cause) — the session reconnects from backoff. */
  readonly onClose: (info: {
    readonly code: number;
    readonly reason: string;
  }) => void;
}

export interface RelaySocketOptions {
  readonly attachBaseUrl: string;
  readonly grantJws: string;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly handlers: RelaySocketHandlers;
}

export class RelaySocket {
  private readonly handlers: RelaySocketHandlers;
  private socket: StreamWebSocketLike | null;
  private opened = false;
  private closed = false;
  private dialTimer: TimerHandle | null = null;
  private pingTimer: IntervalHandle | null = null;
  private lastPongAt: number;

  constructor(options: RelaySocketOptions) {
    this.handlers = options.handlers;
    this.lastPongAt = Date.now();
    const dialUrl = withGrantQuery(options.attachBaseUrl, options.grantJws);
    this.socket = options.webSocketFactory.create(dialUrl);
    this.wireSocket(this.socket);
    this.dialTimer = setTimeout(() => {
      this.dialTimer = null;
      if (!this.opened) {
        this.fail(4000, "relay-dial-timeout");
      }
    }, RELAY_DIAL_TIMEOUT_MS);
  }

  /** Sends an opaque DATA frame (client leg: raw `[ciphertext]`, no sid). */
  sendData(ciphertext: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null || !this.opened) {
      return false;
    }
    try {
      socket.send(ciphertext);
      return true;
    } catch {
      return false;
    }
  }

  /** Re-presents a fresh attach grant in-band on the live socket (§4b). */
  sendReauth(grantJws: string): boolean {
    return this.sendControl({ type: "reauth", grant: grantJws });
  }

  close(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.teardownTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket === null) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(code, reason);
    } catch {
      // best-effort close
    }
  }

  private sendControl(message: { type: "reauth"; grant: string }): boolean {
    const socket = this.socket;
    if (socket === null || !this.opened) {
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private wireSocket(socket: StreamWebSocketLike): void {
    socket.onopen = () => {
      if (socket !== this.socket) {
        return;
      }
      this.opened = true;
      if (this.dialTimer !== null) {
        clearTimeout(this.dialTimer);
        this.dialTimer = null;
      }
      this.lastPongAt = Date.now();
      this.startKeepalive();
    };
    socket.onmessage = (event: StreamWebSocketMessageEvent) => {
      if (socket !== this.socket) {
        return;
      }
      if (event.type === "binary") {
        this.handlers.onData(event.data);
        return;
      }
      this.handleTextFrame(event.data);
    };
    socket.onerror = (_event: WebSocketErrorEvent) => {
      if (socket !== this.socket) {
        return;
      }
      this.fail(4005, "relay-socket-error");
    };
    socket.onclose = (event: WebSocketCloseEvent) => {
      if (socket !== this.socket) {
        return;
      }
      this.onSocketClosed(event.code, event.reason);
    };
  }

  private handleTextFrame(raw: string): void {
    if (raw === KEEPALIVE_PONG) {
      this.lastPongAt = Date.now();
      return;
    }
    if (raw === KEEPALIVE_PING) {
      // The relay auto-responds to pings; a relay-originated ping is not
      // expected, but answer it symmetrically to be safe.
      const socket = this.socket;
      if (socket !== null) {
        try {
          socket.send(KEEPALIVE_PONG);
        } catch {
          // ignore
        }
      }
      return;
    }
    const control = parseRelayControl(raw);
    if (control === null) {
      return;
    }
    this.dispatchControl(control);
  }

  private dispatchControl(control: RelayControlInbound): void {
    switch (control.type) {
      case "attach_ack":
        this.handlers.onAttachAck(control.sid);
        return;
      case "host_detached":
        this.handlers.onHostDetached();
        return;
      case "host_attached":
        this.handlers.onHostAttached();
        return;
      case "reauth_ack":
        this.handlers.onReauthAck();
        return;
      case "peer_gone":
      case "killed":
        this.handlers.onPeerGone(control.reason);
        return;
      case "error":
        this.handlers.onError(control.code, control.message);
        return;
    }
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt >= RELAY_PONG_TIMEOUT_MS) {
        this.fail(4004, "relay-missed-pongs");
        return;
      }
      const socket = this.socket;
      if (socket === null || !this.opened) {
        return;
      }
      try {
        socket.send(KEEPALIVE_PING);
      } catch {
        this.fail(4005, "relay-ping-send-failed");
      }
    }, RELAY_PING_INTERVAL_MS);
  }

  private clearKeepalive(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private teardownTimers(): void {
    this.clearKeepalive();
    if (this.dialTimer !== null) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
  }

  /** Local-side failure (timeout, error, missed pongs): close + notify drop. */
  private fail(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.close(code, reason);
    this.handlers.onClose({ code, reason });
  }

  private onSocketClosed(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.teardownTimers();
    this.socket = null;
    this.handlers.onClose({ code, reason });
  }
}

/** Appends the attach grant as a `?grant=` query param (fallback presentation). */
function withGrantQuery(attachBaseUrl: string, grantJws: string): string {
  const separator = attachBaseUrl.includes("?") ? "&" : "?";
  return `${attachBaseUrl}${separator}grant=${encodeURIComponent(grantJws)}`;
}

// -----------------------------------------------------------------------------
// Inbound relay→peer control parsing (mirror relay-do RelayControlMessage)
// -----------------------------------------------------------------------------

type RelayControlInbound =
  | { type: "attach_ack"; sid: number }
  | { type: "host_detached" }
  | { type: "host_attached" }
  | { type: "reauth_ack" }
  | { type: "peer_gone"; reason: RelayKillReason }
  | { type: "killed"; reason: RelayKillReason }
  | { type: "error"; code: string; message: string };

const KILL_REASONS: ReadonlySet<string> = new Set([
  "reauth_timeout",
  "revoked",
  "host_gone",
  "policy_violation",
]);

function parseRelayControl(raw: string): RelayControlInbound | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isControlRecord(parsed)) {
    return null;
  }
  const record = parsed;
  const type = record.type;
  if (type === "attach_ack" && record.role === "client") {
    return typeof record.sid === "number"
      ? { type: "attach_ack", sid: record.sid }
      : null;
  }
  if (type === "host_detached") {
    return { type: "host_detached" };
  }
  if (type === "host_attached") {
    return { type: "host_attached" };
  }
  if (type === "reauth_ack") {
    return { type: "reauth_ack" };
  }
  if (
    (type === "peer_gone" || type === "killed") &&
    typeof record.reason === "string" &&
    KILL_REASONS.has(record.reason)
  ) {
    const reason = record.reason as RelayKillReason;
    return type === "peer_gone"
      ? { type: "peer_gone", reason }
      : { type: "killed", reason };
  }
  if (
    type === "error" &&
    typeof record.code === "string" &&
    typeof record.message === "string"
  ) {
    return { type: "error", code: record.code, message: record.message };
  }
  return null;
}

function isControlRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
