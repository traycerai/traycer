import {
  PCM_CAPTURE_FINISH,
  PCM_CAPTURE_PROCESSOR,
  type PcmCaptureMessage,
} from "./pcm-capture-protocol";
import { writePcm16Frames } from "./wav";

/**
 * The lossless capture's audio-thread half: every render quantum of what it is
 * fed, as interleaved 16-bit stereo, handed to the page in batches. It runs on
 * the audio thread, so a busy page delays the batches and never loses a frame.
 *
 * Loaded with `audioWorklet.addModule` from a same-origin asset that Vite
 * builds (`?worker&url` in `mix-capture.ts`), which the desktop's `script-src
 * 'self'` already admits on `app://renderer/`.
 */

// The scope a worklet runs in, which the DOM library does not describe.
declare const currentFrame: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

// About 170 ms at 48 kHz: few messages, and little held if the page goes. A
// whole number of render quanta, so a quantum never straddles two batches.
const BATCH_FRAMES = 8192;
const RENDER_QUANTUM_FRAMES = 128;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private batch = new Int16Array(BATCH_FRAMES * 2);
  private held = 0;
  /** The context frame the next quantum should start on; null before one. */
  private nextFrame: number | null = null;
  private frames = 0;
  private droppedFrames = 0;
  private finished = false;

  constructor() {
    super();
    // Answered here and not in `process`, which a suspended context stops
    // calling: the page waits for `finished` either way.
    this.port.addEventListener("message", (event: MessageEvent) => {
      if (event.data === PCM_CAPTURE_FINISH) this.finish();
    });
    this.port.start();
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.finished) return false;
    // A starved audio thread can hand over a quantum under the frame number of
    // the one before it, and then skip one. Time goes on from the frames
    // already written, so the file never runs ahead of the clock.
    const frame =
      this.nextFrame === null
        ? currentFrame
        : Math.max(currentFrame, this.nextFrame);
    if (this.nextFrame === null) {
      this.post({ type: "first-frame", time: currentTime });
    } else if (frame > this.nextFrame) {
      // Frames the thread went past without calling here: silence keeps time.
      const missed = frame - this.nextFrame;
      this.droppedFrames += missed;
      this.writeSilence(missed);
    }
    // No channels while nothing is connected, or all of it is silent.
    const input = inputs.at(0) ?? [];
    const left = input.at(0);
    const count = left === undefined ? RENDER_QUANTUM_FRAMES : left.length;
    if (left === undefined) {
      this.writeSilence(count);
    } else {
      this.writeFrames(left, input.at(1) ?? left);
    }
    this.nextFrame = frame + count;
    return true;
  }

  private writeFrames(left: Float32Array, right: Float32Array): void {
    // Only after silence of an odd length can a quantum not fit what is left.
    if (this.held + left.length > BATCH_FRAMES) this.handOver();
    writePcm16Frames(left, right, this.batch, this.held);
    this.took(left.length);
  }

  private writeSilence(count: number): void {
    let written = 0;
    while (written < count) {
      const take = Math.min(count - written, BATCH_FRAMES - this.held);
      this.batch.fill(0, this.held * 2, (this.held + take) * 2);
      this.took(take);
      written += take;
    }
  }

  private took(frames: number): void {
    this.held += frames;
    this.frames += frames;
    if (this.held === BATCH_FRAMES) this.handOver();
  }

  private handOver(): void {
    if (this.held === 0) return;
    const buffer = this.batch.slice(0, this.held * 2).buffer;
    this.port.postMessage({ type: "pcm", buffer } satisfies PcmCaptureMessage, [
      buffer,
    ]);
    this.held = 0;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.handOver();
    this.post({
      type: "finished",
      frames: this.frames,
      droppedFrames: this.droppedFrames,
    });
  }

  private post(message: PcmCaptureMessage): void {
    this.port.postMessage(message);
  }
}

registerProcessor(PCM_CAPTURE_PROCESSOR, PcmCaptureProcessor);
