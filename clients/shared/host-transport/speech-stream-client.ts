import {
  speechDictateServerFrameSchema,
  type SpeechDictateClientFrame,
  type SpeechDictateServerFrame,
} from "@traycer/protocol/host/speech/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { WsStreamClient } from "./ws-stream-client";

/**
 * Typed handlers for a `speech.dictate@1.0` session. The renderer's dictation
 * hook binds these so raw stream envelopes never leak into React.
 */
export interface SpeechStreamCallbacks {
  readonly onReady: (
    frame: Extract<SpeechDictateServerFrame, { readonly kind: "ready" }>,
  ) => void;
  readonly onTranscript: (
    frame: Extract<SpeechDictateServerFrame, { readonly kind: "transcript" }>,
  ) => void;
  readonly onFlushed: () => void;
  readonly onError: (
    frame: Extract<SpeechDictateServerFrame, { readonly kind: "error" }>,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface SpeechStreamClientOptions {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  readonly language: string;
  readonly sampleRate: number;
  readonly callbacks: SpeechStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for a single dictation session. Streams
 * PCM16 mono audio to the host recognizer (`sendAudio`); on `flush` the
 * recognizer replies with a final `transcript` then `flushed`, surfaced through
 * the bound callbacks.
 */
export class SpeechStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: SpeechStreamCallbacks;
  private closed: boolean;

  constructor(options: SpeechStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;
    this.session = options.wsStreamClient.subscribe("speech.dictate", {
      language: options.language,
      sampleRate: options.sampleRate,
    });
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    this.session.sendClientFrame(
      { kind: "audio", hasBinaryPayload: true },
      pcm,
    );
  }

  flush(): void {
    this.sendControl({ kind: "flush", hasBinaryPayload: false });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private sendControl(frame: SpeechDictateClientFrame): void {
    if (this.closed) return;
    this.session.sendClientFrame(frame, null);
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (binaryPayload !== null) return;
    const parsed = speechDictateServerFrameSchema.safeParse(envelope);
    if (!parsed.success) return;
    const frame: SpeechDictateServerFrame = parsed.data;
    switch (frame.kind) {
      case "ready":
        this.callbacks.onReady(frame);
        return;
      case "transcript":
        this.callbacks.onTranscript(frame);
        return;
      case "flushed":
        this.callbacks.onFlushed();
        return;
      case "error":
        this.callbacks.onError(frame);
        return;
    }
  }
}
