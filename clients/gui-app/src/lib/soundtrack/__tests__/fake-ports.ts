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
}

/** Every device a store opened since the last reset, oldest first. */
export const openedFakePorts: OpenedFakePorts[] = [];

/** Stands in for `openWebAudioPorts`: the audio device is the one fake. */
export const openFakePorts = vi.fn(
  (_stems: StemManifest, volume: number): SoundtrackPorts => {
    const setVolume = vi.fn<(volume: number) => void>();
    const duck = vi.fn<(chimeSeconds: number) => void>();
    const close = vi.fn<(afterSeconds: number) => void>();
    const ports: SoundtrackPorts = {
      output: new FakeOutput(),
      stems: new FakeStems(SAMPLE_SECONDS),
      setDimmed: vi.fn<(dimmed: boolean) => void>(),
      setVolume,
      duck,
      close,
    };
    openedFakePorts.push({ volumeAtOpen: volume, setVolume, duck, close });
    return ports;
  },
);

export function resetFakePorts(): void {
  openedFakePorts.length = 0;
  openFakePorts.mockClear();
}
