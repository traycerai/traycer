import { appLogger, describeLogError } from "@/lib/logger";
import {
  VoiceEngineError,
  type VoiceEngine,
  type VoiceEngineCloseReason,
  type VoiceEngineConnectInput,
  type VoiceEngineEvents,
  type VoiceUsage,
} from "./engine";

/**
 * The live-model engine over WebRTC: the microphone track goes out on the
 * peer, the voice comes back on it, and the vendor's events and the app's
 * appends travel the `oai-events` data channel, created before the offer so
 * it is in the SDP the app's server exchanges. Client delegation: the model
 * hands every spoken request to the app as a `session.delegation.created`
 * event and speaks its own acknowledgement; the app answers with commentary
 * under that delegation's id.
 *
 * The vendor's event names and payload shapes live in this file alone (the
 * probe of 2026-10-30 confirmed them on the wire); the seam in `engine.ts`
 * is what the rest of the app sees.
 */

const DATA_CHANNEL_LABEL = "oai-events";
/**
 * The vendor takes the offer whole, candidates included (no trickle), so the
 * offer waits for gathering to finish; bounded so a stuck gatherer still lets
 * the exchange proceed with what it has.
 */
const ICE_GATHERING_TIMEOUT_MS = 2_000;
/** After `session.close`, how long the vendor's `session.closed` is waited for. */
const CLOSE_CONFIRM_TIMEOUT_MS = 2_000;

/**
 * The slice of a data channel the engine drives, so a test can hand it a
 * fake without a browser; `RTCDataChannel` satisfies it.
 */
export interface GptLiveDataChannel {
  readonly readyState: RTCDataChannelState;
  send(data: string): void;
  onmessage: ((message: MessageEvent<unknown>) => void) | null;
}

/** The slice of a peer connection the engine drives; `RTCPeerConnection` satisfies it. */
export interface GptLivePeer {
  readonly iceGatheringState: RTCIceGatheringState;
  readonly connectionState: RTCPeerConnectionState;
  readonly localDescription: { readonly sdp: string } | null;
  ontrack: ((event: RTCTrackEvent) => void) | null;
  onconnectionstatechange: ((event: Event) => void) | null;
  createDataChannel(label: string): GptLiveDataChannel;
  addTrack(track: MediaStreamTrack): unknown;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addEventListener(type: "icegatheringstatechange", listener: () => void): void;
  removeEventListener(
    type: "icegatheringstatechange",
    listener: () => void,
  ): void;
  close(): void;
}

/** The peer the engine drives: injected so a test runs it without a browser. */
export interface GptLiveEngineDeps {
  readonly createPeer: () => GptLivePeer;
}

interface VendorEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

function isVendorEvent(value: unknown): value is VendorEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "type") === "string"
  );
}

function stringAt(
  value: unknown,
  ...path: ReadonlyArray<string>
): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = Reflect.get(current, key);
  }
  return typeof current === "string" ? current : null;
}

function numberAt(
  value: unknown,
  ...path: ReadonlyArray<string>
): number | null {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = Reflect.get(current, key);
  }
  return typeof current === "number" && Number.isFinite(current)
    ? current
    : null;
}

/** A transcript delta's text, whichever of the documented spellings carries it. */
function transcriptDeltaOf(event: VendorEvent): string {
  return stringAt(event, "delta") ?? stringAt(event, "text") ?? "";
}

function usageOf(event: VendorEvent): VoiceUsage {
  return {
    seconds: numberAt(event, "usage", "seconds") ?? 0,
    contextUsageRatio:
      numberAt(event, "context_window", "usage_ratio") ??
      numberAt(event, "session", "context_window", "usage_ratio"),
  };
}

export function createGptLiveEngine(deps: GptLiveEngineDeps): VoiceEngine {
  let peer: GptLivePeer | null = null;
  let channel: GptLiveDataChannel | null = null;
  let events: VoiceEngineEvents | null = null;
  let started = false;
  let closed = false;
  let closeTimer: number | null = null;
  /** Rejects a `connect` still waiting for `session.started`. */
  let rejectStart: (() => void) | null = null;
  // Read through a call: `closed` is written by `finish` from event handlers,
  // which control flow cannot see.
  const isClosed = (): boolean => closed;

  const finish = (reason: VoiceEngineCloseReason): void => {
    if (closed) return;
    closed = true;
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    const pendingStart = rejectStart;
    rejectStart = null;
    pendingStart?.();
    const activePeer = peer;
    peer = null;
    channel = null;
    try {
      activePeer?.close();
    } catch (error) {
      appLogger.warn("[voice] peer close failed", {
        error: describeLogError(error),
      });
    }
    events?.onClosed(reason);
  };

  const send = (payload: Record<string, unknown>): void => {
    if (closed || channel === null || channel.readyState !== "open") {
      throw new VoiceEngineError(
        "NOT_CONNECTED",
        "The voice session is not connected.",
      );
    }
    channel.send(JSON.stringify(payload));
  };

  const handleEvent = (event: VendorEvent, onStarted: () => void): void => {
    if (events === null) return;
    switch (event.type) {
      case "session.started":
        started = true;
        onStarted();
        return;
      case "session.input_transcript.delta":
        events.onInputTranscriptDelta(transcriptDeltaOf(event));
        return;
      case "session.output_transcript.delta":
        events.onOutputTranscriptDelta(transcriptDeltaOf(event));
        return;
      case "session.delegation.created": {
        const id = stringAt(event, "delegation", "id");
        if (id !== null) events.onDelegationCreated(id);
        return;
      }
      case "session.usage.updated":
        events.onUsage(usageOf(event));
        return;
      case "session.closed":
        // The vendor confirmed a close the app asked for, or ended the
        // session itself; `closeTimer` is set only in the first case.
        finish(closeTimer !== null ? "app" : "vendor");
        return;
      default:
        return;
    }
  };

  return {
    async connect(input: VoiceEngineConnectInput): Promise<void> {
      if (peer !== null || closed) {
        throw new VoiceEngineError(
          "PEER_FAILED",
          "The voice engine was already used.",
        );
      }
      events = input.events;
      const activePeer = deps.createPeer();
      peer = activePeer;
      const activeChannel = activePeer.createDataChannel(DATA_CHANNEL_LABEL);
      channel = activeChannel;
      activePeer.addTrack(input.micTrack);
      activePeer.ontrack = (event: RTCTrackEvent) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        input.onRemoteAudio(stream);
      };
      // A `disconnected` state is left alone: one that recovers is nothing
      // the app needs to know, and one that does not ends in `failed`.
      activePeer.onconnectionstatechange = () => {
        const state = activePeer.connectionState;
        if (state === "failed" || state === "closed") {
          finish(started ? "connection" : "failed");
        }
      };

      const startedPromise = new Promise<void>((resolve, reject) => {
        // A close before the session starts rejects `connect`; the consumer
        // still hears `onClosed` once, from `finish`.
        rejectStart = () =>
          reject(
            new VoiceEngineError(
              "PEER_FAILED",
              "The voice session closed before it started.",
            ),
          );
        activeChannel.onmessage = (message: MessageEvent<unknown>) => {
          let parsed: unknown;
          try {
            parsed =
              typeof message.data === "string"
                ? JSON.parse(message.data)
                : null;
          } catch {
            return;
          }
          if (!isVendorEvent(parsed)) return;
          handleEvent(parsed, () => {
            rejectStart = null;
            resolve();
          });
        };
      });

      try {
        const offer = await activePeer.createOffer();
        await activePeer.setLocalDescription(offer);
        await waitForIceGathering(activePeer);
        const offerSdp = activePeer.localDescription?.sdp ?? offer.sdp ?? "";
        const answerSdp = await input.exchangeSdp(offerSdp);
        // The peer may have failed while the exchange was out; `finish`
        // already reported it.
        if (isClosed()) return;
        await activePeer.setRemoteDescription({
          type: "answer",
          sdp: answerSdp,
        });
      } catch (error) {
        const failure =
          error instanceof VoiceEngineError
            ? error
            : new VoiceEngineError(
                "EXCHANGE_FAILED",
                error instanceof Error ? error.message : String(error),
              );
        finish("failed");
        throw failure;
      }
      await startedPromise;
    },

    appendCommentary(text: string, delegationId: string | null): void {
      send({
        type: "session.commentary.append",
        delegation_id: delegationId,
        content: text,
      });
    },

    appendThinking(text: string, delegationId: string): void {
      send({
        type: "session.thinking.append",
        delegation_id: delegationId,
        content: text,
      });
    },

    close(): void {
      if (closed) return;
      if (channel === null || channel.readyState !== "open") {
        finish("app");
        return;
      }
      try {
        channel.send(JSON.stringify({ type: "session.close" }));
      } catch (error) {
        appLogger.warn("[voice] session close send failed", {
          error: describeLogError(error),
        });
        finish("app");
        return;
      }
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        finish("app");
      }, CLOSE_CONFIRM_TIMEOUT_MS);
    },
  };
}

function waitForIceGathering(peer: GptLivePeer): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    function done(): void {
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange(): void {
      if (peer.iceGatheringState === "complete") done();
    }
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

/** The engine the app runs today, over the browser's own peer connection. */
export function createBrowserGptLiveEngine(): VoiceEngine {
  return createGptLiveEngine({ createPeer: () => new RTCPeerConnection() });
}
