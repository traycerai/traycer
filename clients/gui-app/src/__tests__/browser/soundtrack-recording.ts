import { TrackPlayer } from "@/lib/soundtrack/player";
import type {
  RecordingFile,
  RecordingQuality,
  RecordingSaveChannel,
} from "@/lib/soundtrack/recording";
import {
  SessionRecorder,
  type RecordingOutcome,
} from "@/lib/soundtrack/session-recorder";
import type { StemSource } from "@/lib/soundtrack/stems";
import type { VariableTrack } from "@/lib/soundtrack/variable-sound";
import { openWebAudioPorts } from "@/lib/soundtrack/web-audio-ports";

/**
 * Browser fixture for a real recording of the mix: the real Web Audio ports,
 * the real player on a one-layer track whose only sample is a test tone made
 * here, and the real recorder, writing to a save channel that keeps the bytes
 * in memory. The page then decodes what it recorded and finds each tone's
 * onset in it, to set beside the start the log gave the same sample.
 *
 * WHY IT CANNOT BE A JSDOM TEST. jsdom has no audio clock, no `MediaRecorder`
 * and no audio worklet; only a browser renders and encodes the frames whose
 * timing is the claim. See `browser-tests/soundtrack-recording.spec.ts`.
 */

const TONE_HZ = 1000;
const TONE_AMPLITUDE = 0.8;
const TONE_SECONDS = 0.25;
// The player fades every sample in over this long (`SAMPLE_FADE_SECONDS`).
const SAMPLE_FADE_SECONDS = 0.01;
// An onset is the first sample louder than this; the ideal tone crosses it
// a known number of frames after its start, which is taken off.
const ONSET_THRESHOLD = 0.02;
// Where around a logged start an onset is looked for.
const ONSET_SEARCH_SECONDS = 0.15;

interface RecordRequest {
  readonly quality: RecordingQuality;
  /** Wall-clock seconds to record for. */
  readonly seconds: number;
  /**
   * Holds the main thread for `forMs` every `everyMs` while recording, so the
   * capture is shown to keep its frames while the page is busy; null leaves it
   * idle.
   */
  readonly busy: { readonly everyMs: number; readonly forMs: number } | null;
}

interface Recorded {
  readonly outcome: RecordingOutcome;
  readonly audioBytes: number;
  readonly logLines: readonly unknown[];
  readonly sampleRate: number;
  readonly decodedSeconds: number;
  /** Per logged sample: its onset in the audio minus its logged start, in ms. */
  readonly onsetOffsetsMs: readonly number[];
  /** Interleaved 16-bit stereo frames the WAV holds; null for WebM. */
  readonly wavFrames: number | null;
}

const track: VariableTrack = {
  name: "test-tone",
  title: "Test tone",
  lengthSeconds: 600,
  alignmentSeconds: 0.25,
  layers: [
    {
      name: "tone",
      variants: 1,
      role: null,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    },
  ],
  states: [
    {
      name: "only",
      layersProperties: [
        {
          enabled: true,
          startPause: [0.5, 0.5],
          sequenceLength: [1, 1],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [0.75, 0.75],
          playsPerRun: null,
        },
      ],
      numberOfEnabledLayers: [1, 1],
    },
  ],
  intro: null,
  outro: null,
  phases: [],
};

function toneBuffer(sampleRate: number): AudioBuffer {
  const length = Math.round(TONE_SECONDS * sampleRate);
  const buffer = new AudioBuffer({ length, numberOfChannels: 1, sampleRate });
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    data[index] =
      TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * index) / sampleRate);
  }
  return buffer;
}

/** Frames after its start that the faded-in tone first passes the threshold. */
function idealOnsetFrames(sampleRate: number): number {
  for (let index = 0; ; index += 1) {
    const fade = Math.min(1, index / (SAMPLE_FADE_SECONDS * sampleRate));
    const value =
      TONE_AMPLITUDE *
      fade *
      Math.sin((2 * Math.PI * TONE_HZ * index) / sampleRate);
    if (Math.abs(value) > ONSET_THRESHOLD) return index;
  }
}

function memoryChannel(): {
  readonly channel: RecordingSaveChannel;
  readonly files: Record<RecordingFile, Uint8Array[]>;
  readonly header: { bytes: Uint8Array | null };
} {
  const files: Record<RecordingFile, Uint8Array[]> = { audio: [], log: [] };
  const header: { bytes: Uint8Array | null } = { bytes: null };
  return {
    files,
    header,
    channel: {
      open: () =>
        Promise.resolve({
          kind: "opened",
          recordingId: "fixture",
          name: "session-fixture",
        }),
      append: (_recordingId, file, bytes) => {
        files[file].push(bytes.slice());
        return Promise.resolve({ kind: "ok" });
      },
      close: (_recordingId, audioHeader) => {
        header.bytes = audioHeader;
        return Promise.resolve({ kind: "ok" });
      },
      reveal: () => Promise.resolve(true),
    },
  };
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

function holdMainThread(forMs: number): void {
  const until = performance.now() + forMs;
  while (performance.now() < until) {
    // Busy on purpose: the claim is about a page that is.
  }
}

function deviceSampleRate(): Promise<number> {
  const probe = new AudioContext();
  const { sampleRate } = probe;
  return probe.close().then(() => sampleRate);
}

async function record(request: RecordRequest): Promise<Recorded> {
  const sampleRate = await deviceSampleRate();
  const tone = toneBuffer(sampleRate);
  const ports = openWebAudioPorts({ tracks: [] }, 0.5);
  const stems: StemSource = { load: () => Promise.resolve(tone) };
  const { channel, files, header } = memoryChannel();
  let resolveStopped: (outcome: RecordingOutcome) => void = () => undefined;
  const stopped = new Promise<RecordingOutcome>((resolve) => {
    resolveStopped = resolve;
  });
  let resolveListening: () => void = () => undefined;
  const listening = new Promise<void>((resolve) => {
    resolveListening = resolve;
  });
  const recorder = new SessionRecorder({
    channel,
    ports,
    quality: request.quality,
    limitSeconds: null,
    manifest: {
      tracks: [track],
      views: { home: [track.name], task: [], bot: [], settings: [] },
      stems: { tracks: [] },
    },
    director: "static",
    onListening: resolveListening,
    onProgress: () => undefined,
    onStopped: resolveStopped,
  });
  void recorder.start();
  await listening;
  const player = new TrackPlayer({
    track,
    output: ports.output,
    stems,
    random: () => 0.5,
    log: ports.log,
    silenceSeconds: [1, 1],
    resumeAt: 0,
    onRunStart: () => undefined,
    onRunEnd: () => undefined,
  });
  player.start(0, 0.01);
  const busyTimer =
    request.busy === null
      ? null
      : window.setInterval(
          holdMainThread,
          request.busy.everyMs,
          request.busy.forMs,
        );
  await new Promise((resolve) => {
    window.setTimeout(resolve, request.seconds * 1000);
  });
  if (busyTimer !== null) window.clearInterval(busyTimer);
  recorder.stop("switch");
  const outcome = await stopped;
  player.stop(0.01);
  ports.close(0);

  const audio = joined(files.audio);
  if (header.bytes !== null) audio.set(header.bytes, 0);
  const logLines = new TextDecoder()
    .decode(joined(files.log))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
  const decoder = new OfflineAudioContext(2, 1, sampleRate);
  const decoded = await decoder.decodeAudioData(audio.slice().buffer);
  const left = decoded.getChannelData(0);
  const ideal = idealOnsetFrames(decoded.sampleRate) / decoded.sampleRate;
  const onsetOffsetsMs: number[] = [];
  for (const line of logLines) {
    if (typeof line !== "object" || line === null) continue;
    if (Reflect.get(line, "type") !== "sample") continue;
    const start: unknown = Reflect.get(line, "start");
    if (typeof start !== "number") continue;
    const from = Math.max(
      0,
      Math.floor((start - ONSET_SEARCH_SECONDS) * decoded.sampleRate),
    );
    const to = Math.min(
      left.length,
      Math.ceil((start + ONSET_SEARCH_SECONDS) * decoded.sampleRate),
    );
    for (let index = from; index < to; index += 1) {
      if (Math.abs(left[index]) > ONSET_THRESHOLD) {
        onsetOffsetsMs.push(
          (index / decoded.sampleRate - ideal - start) * 1000,
        );
        break;
      }
    }
  }
  return {
    outcome,
    audioBytes: audio.length,
    logLines,
    sampleRate,
    decodedSeconds: decoded.duration,
    onsetOffsetsMs,
    wavFrames: request.quality === "lossless" ? (audio.length - 44) / 4 : null,
  };
}

declare global {
  interface Window {
    __soundtrackRecordingProbe?: {
      record: (request: RecordRequest) => Promise<Recorded>;
    };
  }
}

window.__soundtrackRecordingProbe = { record };
