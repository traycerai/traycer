import { vi, type Mock } from "vitest";
import type { SoundtrackPorts } from "../session";
import type { StemManifest } from "../stems";
import { FakeOutput, FakeStems } from "./fakes";

const SAMPLE_SECONDS = 2.2;

export interface OpenedFakePorts {
  /** The volume `openPorts` was handed. */
  readonly volumeAtOpen: number;
  readonly setVolume: Mock<(volume: number) => void>;
  readonly duck: Mock<(chimeSeconds: number) => void>;
  readonly close: Mock<(afterSeconds: number) => void>;
  readonly output: FakeOutput;
  /** From now on a resume is refused at once, the clock left stopped. */
  readonly refuseResumes: () => void;
  /** From now on a resume is left unanswered until `grantHeld` or `refuseHeld`. */
  readonly holdResumes: () => void;
  /** Answers every held resume: the device starts, and the clock with it. */
  readonly grantHeld: () => void;
  /** Answers every held resume with a refusal, the clock left stopped. */
  readonly refuseHeld: () => void;
}

type ResumeAnswer = "grant" | "refuse" | "hold";

interface HeldResume {
  readonly grant: () => void;
  readonly refuse: () => void;
}

/** Every device a store opened since the last reset, oldest first. */
export const openedFakePorts: OpenedFakePorts[] = [];

/** Stands in for `openWebAudioPorts`: the audio device is the one fake. */
export const openFakePorts = vi.fn(
  (_stems: StemManifest, volume: number): SoundtrackPorts => {
    const setVolume = vi.fn<(volume: number) => void>();
    const duck = vi.fn<(chimeSeconds: number) => void>();
    const close = vi.fn<(afterSeconds: number) => void>();
    const output = new FakeOutput();
    let answer: ResumeAnswer = "grant";
    const held: HeldResume[] = [];
    const ports: SoundtrackPorts = {
      output,
      stems: new FakeStems(SAMPLE_SECONDS),
      setDimmed: vi.fn<(dimmed: boolean) => void>(),
      setVolume,
      duck,
      close,
      pause: () => {
        output.stopClock();
      },
      resume: (onRefused) => {
        const grant = (): void => {
          output.startClock();
        };
        if (answer === "grant") grant();
        else if (answer === "refuse") {
          void Promise.resolve().then(onRefused);
        } else held.push({ grant, refuse: onRefused });
      },
    };
    openedFakePorts.push({
      volumeAtOpen: volume,
      setVolume,
      duck,
      close,
      output,
      refuseResumes: () => {
        answer = "refuse";
      },
      holdResumes: () => {
        answer = "hold";
      },
      grantHeld: () => {
        for (const resume of held.splice(0)) resume.grant();
      },
      refuseHeld: () => {
        for (const resume of held.splice(0)) resume.refuse();
      },
    });
    return ports;
  },
);

export function resetFakePorts(): void {
  openedFakePorts.length = 0;
  openFakePorts.mockClear();
}
