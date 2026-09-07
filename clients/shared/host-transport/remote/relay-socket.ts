import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import type { WebSocketCloseEvent, WebSocketErrorEvent } from "../ws-factory";
import type { TimerHandle, IntervalHandle } from "../timer-handle";
import { assertRelayAttachUrlSecure } from "@traycer/protocol/host-transport/relay-attach-url";
import { createRelayPathEstimator } from "@traycer/protocol/host-transport/relay-liveness";
import {
  RELAY_DIAL_TIMEOUT_MS,
  RELAY_AWAITING_PING_INTERVAL_MS,
  RELAY_AWAITING_PONG_TIMEOUT_MS,
  RELAY_PING_INTERVAL_MS,
  RELAY_PING_TICK_MS,
  RELAY_AWAITING_DEADLINE_CAP_MULTIPLE,
  RELAY_PONG_TIMEOUT_MS,
} from "./config";

/** The persistent client↔relay WebSocket leg (T10 wire protocol; relay-do readme). */

// Kept in lockstep with workers/relay-do/src/config.ts (relay-owned constants).
const KEEPALIVE_PING = "relay-ping";
const KEEPALIVE_PONG = "relay-pong";

export const RELAY_WAKE_PROBE_TIMEOUT_CLOSE_CODE = 4006;
export const RELAY_WAKE_PROBE_TIMEOUT_CLOSE_REASON = "relay-wake-probe-timeout";

/**
 * Relay session-kill / peer-death reasons (mirror relay-do `KillReason`).
 * The relay can add a reason before this client updates.
 */
export type RelayKillReason =
  | "reauth_timeout"
  | "revoked"
  | "host_gone"
  | "policy_violation"
  | (string & {});

export interface RelaySocketHandlers {
  /** The relay assigned this client session its `sid`; bridging is live. */
  readonly onAttachAck: (sid: number) => void;
  /** An opaque inbound data frame (Noise transport bytes for the layer above). */
  readonly onData: (ciphertext: Uint8Array) => void;
  /** The host's uplink dropped - pause; the same Noise session resumes on re-attach. */
  readonly onHostDetached: () => void;
  /** The host's uplink (re)attached - resume sends on the existing Noise session. */
  readonly onHostAttached: () => void;
  /** The relay acknowledged an in-band `reauth` grant. */
  readonly onReauthAck: () => void;
  /** The peer is gone / the session was killed - the session must full-resume. */
  readonly onPeerGone: (reason: RelayKillReason) => void;
  /** A recoverable relay protocol error (no close). */
  readonly onError: (code: string, message: string) => void;
  /** The socket dropped (any cause) - the session reconnects from backoff. */
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
  /**
   * Armed exactly while a wake-time ping is outstanding, and disarmed by the next inbound frame - so its survival to the deadline IS the verdict.
   */
  private probeTimer: TimerHandle | null = null;
  /** Monotonically increasing identity of the current wake-probe arm. */
  private probeArmToken = 0;
  /** When the current arm's (possibly joined-earlier) deadline fires. */
  private probeDeadlineAt = 0;
  /**
   * True from the moment an arm is raised until an inbound frame answers it.
   * Deliberately NOT cleared by `close()` - see `pokeKeepalive`'s contract.
   */
  private probeUnanswered = false;
  /** The current arm's effective failure policy (upgrade-only merged). */
  private probeImmediateRedialOnFailure = false;
  /** Last time any frame arrived from the relay (pong, control, or data). */
  private lastInboundAt: number;
  /**
   * Whether application traffic is currently outstanding - explicit state, not a comparison of the two timestamps.
   * That parks a genuinely half-open socket on the 60s idle deadline instead of the 12s detection one, for exactly the traffic pattern the fast deadline was added to catch.
   */
  private awaitingResponse = false;
  /** When the current unanswered-send run began; the fast deadline's origin. */
  private awaitingSince = 0;
  private lastPingSentAt = 0;
  /**
   * Feeds the two liveness deadlines below, which floor on their constants and can therefore only be lengthened by it.
   */
  private readonly path = createRelayPathEstimator();

  constructor(options: RelaySocketOptions) {
    this.handlers = options.handlers;
    this.lastInboundAt = Date.now();
    // Before the URL is built, let alone dialed: the grant goes into the query string on the next line.
    assertRelayAttachUrlSecure(options.attachBaseUrl);
    const dialUrl = withGrantQuery(options.attachBaseUrl, options.grantJws);
    // Not a host method, and not classifiable as one: this is the single durable leg that multiplexes every unary call and every stream for a remote host, so anything queued behind it is queued behind all of them.
    // It holds a dial slot only while connecting, so it cannot squat.
    this.socket = options.webSocketFactory.create(dialUrl, "interactive");
    this.wireSocket(this.socket);
    this.dialTimer = setTimeout(() => {
      this.dialTimer = null;
      if (!this.opened) {
        this.fail(4000, "relay-dial-timeout");
      }
    }, RELAY_DIAL_TIMEOUT_MS);
  }

  /** Sends an opaque data frame (client leg: raw `[ciphertext]`, no sid). */
  sendData(ciphertext: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null || !this.opened) {
      return false;
    }
    try {
      socket.send(ciphertext);
      this.noteOutbound();
      return true;
    } catch {
      return false;
    }
  }

  /** Re-presents a fresh attach grant in-band on the live socket (§4b). */
  sendReauth(grantJws: string): boolean {
    return this.sendControl({ type: "reauth", grant: grantJws });
  }

  /**
   * Probes this socket now, for a caller that knows the runtime just un-froze (an OS wake, an app returning to the foreground).
   * And the drop itself is frequently silent - the peer never got to send a close, so the socket reads open and the layer above keeps parking work on a connection that will never answer.
   */
  pokeKeepalive(
    probeTimeoutMs: number,
    immediateRedialOnFailure: boolean,
  ): void {
    if (this.closed || !this.opened) {
      return;
    }
    const now = Date.now();
    if (this.probeTimer !== null) {
      // Join the in-flight arm: upgrade-only merge, no additional ping.
      this.probeImmediateRedialOnFailure =
        this.probeImmediateRedialOnFailure || immediateRedialOnFailure;
      const joinedDeadlineAt = now + probeTimeoutMs;
      if (joinedDeadlineAt < this.probeDeadlineAt) {
        this.probeDeadlineAt = joinedDeadlineAt;
        clearTimeout(this.probeTimer);
        this.probeTimer = setTimeout(
          this.probeDeadlineCallback(this.probeArmToken),
          probeTimeoutMs,
        );
      }
      return;
    }
    this.runKeepaliveTick();
    if (this.closed) {
      // The staleness check failed the socket synchronously - no arm was
      // raised, so the close that just happened inherited no probe policy.
      return;
    }
    this.probeArmToken += 1;
    this.probeUnanswered = true;
    this.probeImmediateRedialOnFailure = immediateRedialOnFailure;
    this.probeDeadlineAt = now + probeTimeoutMs;
    this.probeTimer = setTimeout(
      this.probeDeadlineCallback(this.probeArmToken),
      probeTimeoutMs,
    );
  }

  /**
   * The deadline for one specific arm, pinned by token: a callback whose arm has been retired (answered, or re-armed later) finds a different token and does nothing, however late the runtime delivers it.
   */
  private probeDeadlineCallback(token: number): () => void {
    return () => {
      if (this.closed || token !== this.probeArmToken) {
        return;
      }
      this.probeTimer = null;
      // Still unanswered at the deadline, so nothing answered the ping this
      // arm sent - the socket is open in name only.
      this.fail(
        RELAY_WAKE_PROBE_TIMEOUT_CLOSE_CODE,
        RELAY_WAKE_PROBE_TIMEOUT_CLOSE_REASON,
      );
    };
  }

  /** True while an unanswered wake-probe arm demands that a failure redial immediately. */
  hasUnansweredImmediateRedialProbe(): boolean {
    return this.probeUnanswered && this.probeImmediateRedialOnFailure;
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
      this.noteOutbound();
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
      const now = Date.now();
      this.lastInboundAt = now;
      this.awaitingResponse = false;
      this.awaitingSince = 0;
      this.lastPingSentAt = now;
      this.startKeepalive();
    };
    socket.onmessage = (event: StreamWebSocketMessageEvent) => {
      if (socket !== this.socket) {
        return;
      }
      this.noteInbound();
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
      // `noteInbound` already stamped it (and disarmed any wake probe); a pong carries no extra liveness meaning now that every inbound frame counts as proof the socket carries traffic.
      this.path.notePongReceived(Date.now());
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

  /**
   * True once this client has sent application traffic that nothing at all has come back after.
   * That is the literal definition of a half-open socket, and it is the only state worth paying the fast cadence for.
   */
  private isAwaitingResponse(): boolean {
    return this.awaitingResponse;
  }

  /** Records outbound application traffic. */
  private noteOutbound(): void {
    if (this.awaitingResponse) {
      return;
    }
    this.awaitingResponse = true;
    this.awaitingSince = Date.now();
  }

  /**
   * Any inbound frame proves the socket carries traffic, not just a pong, and closes whatever unanswered run was open.
   * Ordering inside `onmessage` is what makes the tie safe: this runs before the frame is dispatched, so a send issued from that dispatch re-opens the run under the same clock reading rather than being swallowed by it.
   */
  private noteInbound(): void {
    this.lastInboundAt = Date.now();
    this.awaitingResponse = false;
    // Any inbound frame is the liveness proof a wake-time probe is waiting
    // for - a pong carries no more evidence than a data frame does.
    this.clearProbe();
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      const awaiting = this.isAwaitingResponse();
      const silentSince = awaiting
        ? Math.max(this.lastInboundAt, this.awaitingSince)
        : this.lastInboundAt;
      // The awaiting lane is additionally capped, because one estimator sizes both windows and they are not the same kind of window.
      const floorMs = awaiting
        ? RELAY_AWAITING_PONG_TIMEOUT_MS
        : RELAY_PONG_TIMEOUT_MS;
      const derivedMs = this.path.deadlineMs(floorMs);
      const timeoutMs = awaiting
        ? Math.min(derivedMs, RELAY_AWAITING_DEADLINE_CAP_MULTIPLE * floorMs)
        : derivedMs;
      if (now - silentSince >= timeoutMs) {
        this.fail(4004, "relay-missed-pongs");
        return;
      }
      const socket = this.socket;
      if (socket === null || !this.opened) {
        return;
      }
      const pingIntervalMs = awaiting
        ? RELAY_AWAITING_PING_INTERVAL_MS
        : RELAY_PING_INTERVAL_MS;
      if (now - this.lastPingSentAt < pingIntervalMs) {
        return;
      }
      this.lastPingSentAt = now;
      try {
        socket.send(KEEPALIVE_PING);
        this.path.notePingSent(now);
      } catch {
        this.fail(4005, "relay-ping-send-failed");
      }
    }, RELAY_PING_TICK_MS);
  }

  /** Stamps `lastPingSentAt` so the scheduled tick does not double-send. */
  private runKeepaliveTick(): void {
    if (this.closed || !this.opened) {
      return;
    }
    if (
      Date.now() - this.lastInboundAt >=
      this.path.deadlineMs(RELAY_PONG_TIMEOUT_MS)
    ) {
      this.fail(4004, "relay-missed-pongs");
      return;
    }
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    // Deliberately not timed into the estimator: this ping is sent at wake, so its round trip carries the runtime's own resume cost and would report the path as far worse than it is.
    this.path.retireRun();
    this.lastPingSentAt = Date.now();
    try {
      socket.send(KEEPALIVE_PING);
    } catch {
      this.fail(4005, "relay-ping-send-failed");
    }
  }

  private clearKeepalive(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Retires the current wake-probe arm as answered: liveness is proven, so the arm's deadline, failure policy, and token all end here.
   */
  private clearProbe(): void {
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.probeUnanswered) {
      this.probeUnanswered = false;
      this.probeImmediateRedialOnFailure = false;
      this.probeArmToken += 1;
    }
  }

  private teardownTimers(): void {
    this.clearKeepalive();
    // Only the probe timer dies with the socket.
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
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

function withGrantQuery(attachBaseUrl: string, grantJws: string): string {
  const separator = attachBaseUrl.includes("?") ? "&" : "?";
  return `${attachBaseUrl}${separator}grant=${encodeURIComponent(grantJws)}`;
}

type RelayControlInbound =
  | { type: "attach_ack"; sid: number }
  | { type: "host_detached" }
  | { type: "host_attached" }
  | { type: "reauth_ack" }
  | { type: "peer_gone"; reason: RelayKillReason }
  | { type: "killed"; reason: RelayKillReason }
  | { type: "error"; code: string; message: string };

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
    typeof record.reason === "string"
  ) {
    const reason: RelayKillReason = record.reason;
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
