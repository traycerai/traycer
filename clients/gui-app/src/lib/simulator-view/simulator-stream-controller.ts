import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SimulatorOrientation } from "@traycer/protocol/host/simulator/actions";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import type {
  SimulatorHardwareButton,
  SimulatorStreamClientFrame,
  SimulatorStreamConfig,
  SimulatorStreamServerFrame,
} from "@traycer/protocol/host/simulator/stream-contracts";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  isIncompatibleCloseForMethod,
  type StreamCloseReason,
  type StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { SimulatorStreamClient } from "@traycer-clients/shared/host-transport/simulator-stream-client";
import {
  buildButtonFrame,
  buildKeyFrame,
  buildOrientationFrame,
  buildTouchFrame,
  nextOrientation,
  type FrameSize,
  type KeyLike,
  type NormalizedPoint,
  type SimulatorKeyPhase,
  type SimulatorTouchPhase,
} from "@/lib/simulator-view/simulator-input-encoding";
import {
  createSimulatorDecoder,
  defaultSimulatorDecoderRuntime,
  isWebCodecsSupported,
  type SimulatorDecoder,
  type SimulatorDecoderRuntime,
  type SimulatorFrameSink,
} from "@/lib/simulator-view/simulator-decoder";
import { getMobileAppPlatform } from "@/lib/mobile-app";

/**
 * One viewer's `simulator.stream`: open, keep open, paint, and carry input.
 *
 * The transport reconnects itself after a dropped socket and the host keeps
 * its own upstream alive through a hub restart, so what is left here is the
 * part neither of them owns: the first-frame watchdog, the retry after a
 * retryable refusal, the decoder's recovery (a fresh keyframe, or MJPEG when
 * this app cannot decode the profile), and the state a tile renders.
 *
 *   connecting ──first frame──▶ streaming ──socket drop──▶ reconnecting ──▶ streaming
 *   streaming ──no frame for 5 hub intervals──▶ streaming + stalled ──frame──▶ streaming
 *   connecting ──15 s silent──▶ error (Reconnect)
 *   any ──SIMULATOR_INIT_FAILED──▶ connecting, after 1 s
 *   any ──SESSION_CLOSED / NOT_FOUND / UNAUTHORIZED──▶ error, terminal
 */

export type SimulatorStreamLifecycle =
  | "idle"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "error";

export interface SimulatorInputState {
  readonly connected: boolean;
  readonly detail: string | null;
}

export interface SimulatorStreamState {
  readonly lifecycle: SimulatorStreamLifecycle;
  /** Copy for the lifecycle, where there is some: why it is reconnecting or failed. */
  readonly detail: string | null;
  /**
   * `true` when nothing this controller does will bring the stream back - the
   * session is gone or this viewer is not allowed - so the tile offers no
   * Reconnect and says what to do instead.
   */
  readonly terminal: boolean;
  readonly config: SimulatorStreamConfig | null;
  /** Which element paints: the canvas for decoded video, the image for MJPEG. */
  readonly plane: "canvas" | "image";
  readonly frameSize: FrameSize | null;
  readonly input: SimulatorInputState;
  /**
   * Streaming, but no frame has arrived for longer than the hub's own frame
   * cadence allows ({@link SIMULATOR_STALL_GAP_FRAME_INTERVALS}): the last
   * frame is still on screen and the tile says it is waiting. Cleared by the
   * next frame. Never true while the hub's frame interval is unknown.
   */
  readonly stalled: boolean;
}

export interface SimulatorStreamController {
  /** Notified after every state change; the hook reads it as an external store. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly stop: () => void;
  /** A person's Reconnect: drops everything and opens again at once. */
  readonly restart: () => void;
  readonly getState: () => SimulatorStreamState;
  readonly sendTouch: (
    phase: SimulatorTouchPhase,
    point: NormalizedPoint,
  ) => void;
  readonly sendKey: (event: KeyLike, phase: SimulatorKeyPhase) => void;
  readonly pressButton: (button: SimulatorHardwareButton) => void;
  /** iOS only: the next orientation on the wire. Android rotates through `simulator.action`. */
  readonly rotate: () => void;
  readonly setOrientation: (orientation: SimulatorOrientation) => void;
}

export interface SimulatorStreamControllerArgs {
  readonly epicId: string;
  readonly simulatorId: string;
  readonly platform: SimulatorPlatform;
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly sink: SimulatorFrameSink;
  /**
   * Ask for MJPEG before the first byte rather than after a failed probe - the
   * mobile GUI on iOS WebKit ({@link prefersMjpegFirst}). Honoured only on an
   * iOS simulator; an Android stream has no MJPEG, so it still probes and
   * reports "cannot decode" when the probe fails - or, on this viewer, after
   * repeated decode errors rather than resetting for another keyframe.
   */
  readonly preferMjpeg: boolean;
  /** Injectable for tests; production passes {@link defaultSimulatorDecoderRuntime}. */
  readonly decoderRuntime: SimulatorDecoderRuntime | null;
}

/**
 * The hub's longest normal gap between two video frames, in milliseconds, as
 * its `streamConfig` reports it - the hub keeps an idle floor (it re-sends a
 * frame of a still screen at a fixed rate), so a longer silence is the
 * capture standing still, not the screen. `null` when the hub does not say,
 * which turns the stall overlay off rather than guessing.
 */
export function simulatorStreamFrameIntervalMs(
  config: SimulatorStreamConfig,
): number | null {
  return config.frameIntervalMs;
}

/**
 * How many of the hub's frame intervals may pass in silence before the tile
 * says it is waiting. One missed interval is a dropped frame or a decoder
 * that is briefly behind, and must show nothing; five is a second at the
 * hub's 5 fps idle floor, long enough that a busy machine never flashes the
 * notice and short enough that a frozen capture reads as "waiting" within
 * the second, where the live walk saw a still frame for 90 s with no word.
 */
export const SIMULATOR_STALL_GAP_FRAME_INTERVALS = 5;

/** The silence that reads as a stall for `config`, or null when unknown. */
export function simulatorStallGapMs(
  config: SimulatorStreamConfig,
): number | null {
  const interval = simulatorStreamFrameIntervalMs(config);
  if (interval === null || !(interval > 0)) return null;
  return interval * SIMULATOR_STALL_GAP_FRAME_INTERVALS;
}

/**
 * Whether this viewer opens iOS streams on MJPEG: the installed app on iOS,
 * whose WebKit cannot be relied on to decode the simulators' H.264 profile,
 * so probing first would only add a failed decode before every stream.
 * Android's WebView keeps the probe, and so does the mobile bundle's dev
 * browser tab, whose platform is `null`.
 */
export function prefersMjpegFirst(): boolean {
  return getMobileAppPlatform() === "ios";
}

export const SIMULATOR_STREAM_RETRY_DELAY_MS = 1_000;
export const SIMULATOR_FIRST_FRAME_TIMEOUT_MS = 15_000;
/** Floor between two keyframe requests, so a stalled decoder cannot flood the hub. */
const KEYFRAME_REQUEST_FLOOR_MS = 1_000;
/**
 * Decode errors inside this window before an iOS stream gives up on H.264, or
 * an Android stream on the iOS app gives up altogether.
 */
const DECODE_ERROR_WINDOW_MS = 10_000;
const DECODE_ERRORS_BEFORE_FALLBACK = 3;

/** Stream error codes after which no reopen can help (T4's relay). */
const TERMINAL_STREAM_CODES: ReadonlySet<string> = new Set([
  "UNAUTHORIZED",
  "SIMULATOR_SESSION_NOT_FOUND",
  "SIMULATOR_SESSION_CLOSED",
]);

export const SIMULATOR_NO_VIDEO_MESSAGE =
  "No video arrived from the simulator.";
export const SIMULATOR_CANNOT_DECODE_MESSAGE =
  "This app cannot show this emulator's video.";
export const SIMULATOR_HOST_TOO_OLD_MESSAGE =
  "This host needs an update before it can show simulators.";

function terminalMessage(code: string, reason: string | null): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "You do not have access to this simulator.";
    case "SIMULATOR_SESSION_NOT_FOUND":
      return "This simulator is not open in this task.";
    case "SIMULATOR_SESSION_CLOSED":
      return "This simulator was closed.";
    default:
      return reason ?? "The simulator stream ended.";
  }
}

const INITIAL_STATE: SimulatorStreamState = {
  lifecycle: "idle",
  detail: null,
  terminal: false,
  config: null,
  plane: "canvas",
  frameSize: null,
  input: { connected: false, detail: null },
  stalled: false,
};

export function createSimulatorStreamController(
  args: SimulatorStreamControllerArgs,
): SimulatorStreamController {
  const { epicId, simulatorId, platform, client, sink } = args;
  const listeners = new Set<() => void>();
  const runtime = args.decoderRuntime ?? defaultSimulatorDecoderRuntime();
  const webCodecs = isWebCodecsSupported();

  let state: SimulatorStreamState = INITIAL_STATE;
  let stream: SimulatorStreamClient | null = null;
  let decoder: SimulatorDecoder | null = null;
  let streamOpen = false;
  let started = false;
  let firstFrame = false;
  let wantMjpeg = platform === "ios" && (args.preferMjpeg || !webCodecs);
  let mjpegRequested = false;
  let watchdog: number | null = null;
  let retryTimer: number | null = null;
  let stallTimer: number | null = null;
  let stallGapMs: number | null = null;
  let lastKeyframeRequestAt = Number.NEGATIVE_INFINITY;
  // A request that fell inside the floor, held until the floor ends: the
  // decoder asks once per gap and never again, so a dropped ask would leave
  // the picture frozen until the hub sent a keyframe on its own.
  let heldKeyframeRequest: number | null = null;
  let decodeErrorTimes: number[] = [];
  // Bumped on every open so a callback from a stream that was replaced
  // (a retry, a restart) cannot touch the one that replaced it.
  let generation = 0;

  const publish = (patch: Partial<SimulatorStreamState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const clearWatchdog = (): void => {
    if (watchdog !== null) window.clearTimeout(watchdog);
    watchdog = null;
  };

  const clearRetry = (): void => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const clearStallTimer = (): void => {
    if (stallTimer !== null) window.clearTimeout(stallTimer);
    stallTimer = null;
  };

  /**
   * Re-arms the silence clock. Called on every presented frame, and when the
   * config (so the gap) changes under a stream that is already showing
   * frames. No clock while the gap is unknown.
   */
  const armStallTimer = (): void => {
    clearStallTimer();
    if (stallGapMs === null) return;
    stallTimer = window.setTimeout(() => {
      stallTimer = null;
      if (!started || state.lifecycle !== "streaming") return;
      publish({ stalled: true });
    }, stallGapMs);
  };

  /** A frame was shown: not stalled, and the clock starts over. */
  const noteFrame = (): void => {
    if (state.stalled) publish({ stalled: false });
    armStallTimer();
  };

  const send = (frame: SimulatorStreamClientFrame): void => {
    if (stream === null || !streamOpen) return;
    stream.sendClientFrame(frame);
  };

  const clearHeldKeyframeRequest = (): void => {
    if (heldKeyframeRequest !== null) window.clearTimeout(heldKeyframeRequest);
    heldKeyframeRequest = null;
  };

  const requestKeyframe = (): void => {
    const now = Date.now();
    const wait = lastKeyframeRequestAt + KEYFRAME_REQUEST_FLOOR_MS - now;
    if (wait > 0) {
      if (heldKeyframeRequest === null) {
        heldKeyframeRequest = window.setTimeout(() => {
          heldKeyframeRequest = null;
          requestKeyframe();
        }, wait);
      }
      return;
    }
    lastKeyframeRequestAt = now;
    send({ kind: "requestKeyframe", hasBinaryPayload: false });
  };

  const requestMjpeg = (): void => {
    wantMjpeg = true;
    if (mjpegRequested || stream === null || !streamOpen) return;
    mjpegRequested = true;
    stream.sendClientFrame({ kind: "preferMjpeg", hasBinaryPayload: false });
  };

  const closeDecoder = (): void => {
    decoder?.close();
    decoder = null;
  };

  const closeStream = (): void => {
    const discarded = stream;
    stream = null;
    streamOpen = false;
    discarded?.close();
    closeDecoder();
    clearWatchdog();
    clearStallTimer();
    clearHeldKeyframeRequest();
  };

  const fail = (detail: string, terminal: boolean): void => {
    closeStream();
    clearRetry();
    publish({
      lifecycle: "error",
      detail,
      terminal,
      input: { connected: false, detail: null },
      stalled: false,
    });
  };

  const armWatchdog = (): void => {
    clearWatchdog();
    firstFrame = false;
    watchdog = window.setTimeout(() => {
      watchdog = null;
      if (!started || firstFrame) return;
      fail(SIMULATOR_NO_VIDEO_MESSAGE, false);
    }, SIMULATOR_FIRST_FRAME_TIMEOUT_MS);
  };

  const scheduleRetry = (detail: string | null): void => {
    closeStream();
    publish({
      lifecycle: "reconnecting",
      detail,
      input: { connected: false, detail: null },
      stalled: false,
    });
    clearRetry();
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      if (started) open();
    }, SIMULATOR_STREAM_RETRY_DELAY_MS);
  };

  const makeDecoder = (): SimulatorDecoder =>
    createSimulatorDecoder({
      platform,
      sink,
      runtime,
      events: {
        onFrame: (size) => {
          const nextSize =
            size !== null &&
            (state.frameSize === null ||
              state.frameSize.width !== size.width ||
              state.frameSize.height !== size.height)
              ? size
              : null;
          const wasFirst = !firstFrame;
          if (wasFirst) {
            firstFrame = true;
            clearWatchdog();
          }
          const toStreaming = wasFirst || state.lifecycle !== "streaming";
          if (nextSize !== null || toStreaming) {
            publish({
              ...(nextSize === null ? {} : { frameSize: nextSize }),
              ...(toStreaming
                ? { lifecycle: "streaming" as const, detail: null }
                : {}),
            });
          }
          noteFrame();
        },
        onConfigRejected: () => {
          if (platform === "ios") {
            requestMjpeg();
            return;
          }
          fail(SIMULATOR_CANNOT_DECODE_MESSAGE, true);
        },
        onKeyframeNeeded: () => {
          requestKeyframe();
        },
        onDecodeError: () => {
          const now = Date.now();
          decodeErrorTimes = decodeErrorTimes.filter(
            (at) => now - at < DECODE_ERROR_WINDOW_MS,
          );
          decodeErrorTimes.push(now);
          if (decodeErrorTimes.length >= DECODE_ERRORS_BEFORE_FALLBACK) {
            if (platform === "ios") {
              closeDecoder();
              requestMjpeg();
              return;
            }
            // Android has no MJPEG. On the iOS app, whose WebKit decoder is
            // the likely cause, the reset loop would only hold a spinner up
            // until the first-frame watchdog; say so now instead.
            if (args.preferMjpeg) {
              fail(SIMULATOR_CANNOT_DECODE_MESSAGE, true);
              return;
            }
          }
          decoder?.reset();
          requestKeyframe();
        },
      },
    });

  const handleConfig = (config: SimulatorStreamConfig): void => {
    const plane = config.codec === "mjpeg" ? "image" : "canvas";
    if (plane === "image") {
      // The host switched its upstream; whatever the decoder held is from the
      // stream that ended.
      closeDecoder();
    } else if (decoder === null && !wantMjpeg) {
      // While MJPEG is asked for, the H.264 config the host opened with is
      // not probed: its units are dropped until the MJPEG config arrives.
      decoder = makeDecoder();
    }
    stallGapMs = simulatorStallGapMs(config);
    publish({
      config,
      plane,
      ...(stallGapMs === null ? { stalled: false } : {}),
    });
    // A config that changes under a running stream re-times the clock; one
    // that arrives before the first frame leaves it to that frame.
    if (firstFrame) armStallTimer();
  };

  const handleServerFrame = (
    openGeneration: number,
    frame: SimulatorStreamServerFrame,
    bytes: Uint8Array | null,
  ): void => {
    if (openGeneration !== generation) return;
    switch (frame.kind) {
      case "streamConfig":
        handleConfig(frame.config);
        return;
      case "video":
        if (bytes === null) return;
        if (frame.unit === "jpeg") {
          if (!sink.presentJpeg(bytes)) return;
          if (!firstFrame) {
            firstFrame = true;
            clearWatchdog();
            publish({ lifecycle: "streaming", detail: null, plane: "image" });
          } else if (state.lifecycle !== "streaming") {
            // The first frame after a transport drop, which keeps
            // `firstFrame` so the last frame stays on screen meanwhile.
            publish({ lifecycle: "streaming", detail: null });
          }
          noteFrame();
          return;
        }
        if (decoder === null) {
          if (wantMjpeg) return;
          decoder = makeDecoder();
        }
        decoder.feed(frame.unit, bytes);
        return;
      case "inputState":
        publish({
          input: { connected: frame.connected, detail: frame.detail },
        });
        return;
      case "error":
        // The host closes right after; the close decides between a retry and
        // a terminal stop. The reason is kept so the tile can say why.
        publish({ detail: frame.reason });
        return;
    }
  };

  const handleStatus = (
    openGeneration: number,
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void => {
    if (openGeneration !== generation || !started) return;
    switch (status) {
      case "connecting":
        return;
      case "open":
        streamOpen = true;
        if (wantMjpeg) requestMjpeg();
        return;
      case "reconnecting":
        // The transport re-declares the subscription on its own; the host
        // then starts over with a config and a keyframe. Keep the last frame
        // on screen, drop what the decoder queued for the socket that died.
        streamOpen = false;
        // The re-declared subscription is a new one on the host and opens on
        // H.264 again, so MJPEG is asked for again on the next `open`.
        mjpegRequested = false;
        decoder?.reset();
        clearStallTimer();
        publish({
          lifecycle: "reconnecting",
          detail: null,
          input: { connected: false, detail: null },
          stalled: false,
        });
        return;
      case "closed": {
        if (reason === null || reason.kind === "caller") return;
        if (isIncompatibleCloseForMethod(reason, "simulator.stream")) {
          // The host predates the stream: no reopen can change that.
          fail(SIMULATOR_HOST_TOO_OLD_MESSAGE, true);
          return;
        }
        const code = reason.details.code;
        if (TERMINAL_STREAM_CODES.has(code)) {
          fail(terminalMessage(code, state.detail), true);
          return;
        }
        scheduleRetry(state.detail ?? reason.details.reason);
        return;
      }
    }
  };

  function open(): void {
    closeStream();
    if (platform === "android" && !webCodecs) {
      fail(SIMULATOR_CANNOT_DECODE_MESSAGE, true);
      return;
    }
    generation++;
    const openGeneration = generation;
    mjpegRequested = false;
    publish({
      lifecycle: "connecting",
      terminal: false,
      detail: null,
      input: { connected: false, detail: null },
      stalled: false,
    });
    armWatchdog();
    stream = new SimulatorStreamClient({
      epicId,
      simulatorId,
      wsStreamClient: client,
      callbacks: {
        onServerFrame: (frame, bytes) =>
          handleServerFrame(openGeneration, frame, bytes),
        onConnectionStatus: (status, reason) =>
          handleStatus(openGeneration, status, reason),
      },
    });
    // A session that was already open replayed `open` inside the constructor,
    // while `stream` was still null: send what that status would have sent.
    if (streamOpen && wantMjpeg) requestMjpeg();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started) return;
      started = true;
      open();
    },
    stop() {
      if (!started) return;
      started = false;
      clearRetry();
      closeStream();
      publish({ ...INITIAL_STATE, config: state.config, plane: state.plane });
    },
    restart() {
      started = true;
      clearRetry();
      decodeErrorTimes = [];
      wantMjpeg = platform === "ios" && (args.preferMjpeg || !webCodecs);
      open();
    },
    getState: () => state,
    sendTouch(phase, point) {
      if (!state.input.connected) return;
      send(buildTouchFrame(phase, point));
    },
    sendKey(event, phase) {
      if (!state.input.connected) return;
      send(buildKeyFrame(event, phase));
    },
    pressButton(button) {
      send(buildButtonFrame(button));
    },
    rotate() {
      if (platform !== "ios") return;
      send(
        buildOrientationFrame(
          nextOrientation(state.config?.orientation ?? "portrait"),
        ),
      );
    },
    setOrientation(orientation) {
      if (platform !== "ios") return;
      send(buildOrientationFrame(orientation));
    },
  };
}
