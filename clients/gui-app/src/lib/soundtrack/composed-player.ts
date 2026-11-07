import { appLogger } from "@/lib/logger";
import type { ComposedTrack } from "./manifest";
import type { OutputGain, OutputVoice, SoundtrackOutput } from "./output";
import type { StemSource } from "./stems";

/** One complete recording, with cancellation qualified by its playback generation. */
export class ComposedPlayer {
  private readonly track: ComposedTrack;
  private readonly output: SoundtrackOutput;
  private readonly stems: StemSource;
  private bus: OutputGain | null = null;
  private fadeInSeconds = 0.01;
  private readonly onEnd: () => void;
  private voice: OutputVoice | null = null;
  private generation = 0;
  private position: number;
  private startedAt: number | null = null;
  private held = false;
  private endedWhileHeld = false;
  private pending: { buffer: AudioBuffer; generation: number } | null = null;
  private fadeTimer: number | null = null;
  private fadeEndsAt: number | null = null;

  constructor(options: {
    track: ComposedTrack;
    output: SoundtrackOutput;
    stems: StemSource;
    position: number;
    onEnd: () => void;
  }) {
    this.track = options.track;
    this.output = options.output;
    this.stems = options.stems;
    this.position = options.position;
    this.onEnd = options.onEnd;
  }

  start(from: number, fade: number): void {
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.fadeEndsAt = null;
    this.fadeInSeconds = Math.max(0.01, fade);
    if (this.voice !== null) {
      this.bus?.ramp(1, this.fadeInSeconds);
      return;
    }
    if (this.pending !== null) return;
    this.position = Math.max(0, from);
    const generation = ++this.generation;
    void this.load(generation);
  }

  private async load(generation: number): Promise<void> {
    if (this.stems.loadRecording === undefined) {
      this.reportFailure(generation, "unavailable");
      return;
    }
    let buffer: AudioBuffer;
    try {
      buffer = await this.stems.loadRecording(this.track.recording);
    } catch {
      this.reportFailure(generation, "load");
      return;
    }
    if (generation !== this.generation) return;
    if (this.held) this.pending = { buffer, generation };
    else this.startBuffer(buffer, generation);
  }

  private reportFailure(
    generation: number,
    stage: "unavailable" | "load" | "play",
  ): void {
    if (generation !== this.generation) return;
    // Error messages and stacks can contain signed URLs; do not log them.
    appLogger.warn("[soundtrack] could not play a recording", {
      track: this.track.name,
      recording: this.track.recording,
      stage,
    });
  }

  private startBuffer(buffer: AudioBuffer, generation: number): void {
    try {
      this.playBuffer(buffer, generation);
    } catch {
      this.startedAt = null;
      this.bus = null;
      this.voice = null;
      this.reportFailure(generation, "play");
    }
  }

  private playBuffer(buffer: AudioBuffer, generation: number): void {
    if (this.position >= buffer.duration) {
      this.position = 0;
      this.generation += 1;
      this.onEnd();
      return;
    }
    this.startedAt = this.output.currentTime();
    const bus = this.output.createBus(0);
    this.bus = bus;
    bus.ramp(1, this.fadeInSeconds);
    this.voice = bus.playRecording(
      buffer,
      this.startedAt,
      this.position,
      () => {
        if (generation !== this.generation) return;
        this.voice = null;
        this.bus = null;
        this.startedAt = null;
        this.position = 0;
        this.generation += 1;
        if (this.held) this.endedWhileHeld = true;
        else this.onEnd();
      },
    );
  }

  elapsed(): number {
    return this.startedAt === null
      ? this.position
      : this.position + Math.max(0, this.output.currentTime() - this.startedAt);
  }

  stop(fade: number): void {
    this.position = this.elapsed();
    this.startedAt = null;
    this.generation += 1;
    this.pending = null;
    this.endedWhileHeld = false;
    this.voice?.cut(Math.max(0.01, fade));
    this.voice = null;
    this.bus = null;
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.fadeEndsAt = null;
  }

  rewind(fade: number): void {
    this.stop(fade);
    this.position = 0;
  }
  fadeOut(seconds: number): void {
    if (this.voice === null) {
      this.stop(0.01);
      return;
    }
    this.bus?.ramp(0, seconds);
    this.fadeEndsAt = this.output.currentTime() + seconds;
    this.fadeTimer = window.setTimeout(() => this.stop(0.01), seconds * 1000);
  }
  hold(): void {
    this.held = true;
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }
  release(): void {
    this.held = false;
    if (this.endedWhileHeld) {
      this.endedWhileHeld = false;
      this.onEnd();
    }
    if (this.fadeEndsAt !== null) {
      this.fadeTimer = window.setTimeout(
        () => this.stop(0.01),
        Math.max(0, this.fadeEndsAt - this.output.currentTime()) * 1000,
      );
    }
    const pending = this.pending;
    this.pending = null;
    if (pending !== null && pending.generation === this.generation)
      this.startBuffer(pending.buffer, pending.generation);
  }
  describe() {
    return {
      track: this.track.name,
      state: null,
      trackTime: this.elapsed(),
      layers: [],
      samples: [],
    };
  }
}
