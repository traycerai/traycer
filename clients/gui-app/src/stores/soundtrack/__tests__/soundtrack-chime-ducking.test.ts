/**
 * A chime reaching the open session's duck, end to end: the real chime player
 * over a fake `window.Audio` as long as the real wav, the real singleton store
 * and its listener, and a fake audio device. Which plays are heard is
 * `notification-chime.test.ts`, and a chime while off is `soundtrack-store.test.ts`.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  disposeNotificationChimeAudio,
  playNotificationChimeSound,
} from "@/lib/notifications/notification-chime";
import {
  openedFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { chimeSeconds } from "@/lib/soundtrack/__tests__/wav-seconds";
import { useSoundtrackStore } from "../soundtrack-store";

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return { openWebAudioPorts: openFakePorts };
});

const RIPPLE_SECONDS = chimeSeconds("ripple");

class FakeAudio {
  preload = "";
  currentTime = 0;
  readonly duration = RIPPLE_SECONDS;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly pause = vi.fn();
  readonly load = vi.fn();

  constructor(public src: string) {}

  removeAttribute(): void {
    this.src = "";
  }

  play(): Promise<void> {
    return Promise.resolve();
  }
}

beforeEach(() => {
  resetFakePorts();
  vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
  useSoundtrackStore.getState().disable();
  disposeNotificationChimeAudio();
  vi.unstubAllGlobals();
});

it("ducks the open session for as long as the chime lasts", async () => {
  useSoundtrackStore.getState().enable();
  expect(openedFakePorts).toHaveLength(1);

  playNotificationChimeSound("ripple");

  await vi.waitFor(() => {
    expect(openedFakePorts[0].duck).toHaveBeenCalledExactlyOnceWith(
      RIPPLE_SECONDS,
    );
  });
});
