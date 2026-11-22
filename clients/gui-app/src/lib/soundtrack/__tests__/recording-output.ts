import type { OutputGain, OutputVoice } from "../output";
import { FakeOutput } from "./fakes";

export interface RecordingCall {
  readonly duration: number;
  readonly offset: number;
  /** What the audio device calls when the recording plays to its end. */
  readonly ended: () => void;
  cancelled: boolean;
}

/** A fake device that keeps each complete recording's `ended` callback. */
export class RecordingOutput extends FakeOutput {
  readonly recordings: RecordingCall[] = [];

  override createBus(): OutputGain {
    const wrap = (gain: OutputGain): OutputGain => ({
      ramp: (target, seconds) => gain.ramp(target, seconds),
      createChild: (initial, pan) => wrap(gain.createChild(initial, pan)),
      play: (buffer, when, fade) => gain.play(buffer, when, fade),
      playRecording: (buffer, _when, offset, ended): OutputVoice => {
        const call: RecordingCall = {
          duration: buffer.duration,
          offset,
          ended,
          cancelled: false,
        };
        this.recordings.push(call);
        return {
          cut: () => {
            call.cancelled = true;
          },
        };
      },
    });
    return wrap(super.createBus());
  }
}
