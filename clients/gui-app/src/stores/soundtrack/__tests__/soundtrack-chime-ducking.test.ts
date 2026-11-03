/**
 * A chime reaching the session's duck, end to end, across windows. Each window is
 * its own module graph, as a renderer is: the real chime player, the real
 * singleton store and its listener. What real windows share is faked at the
 * boundary: the channel, the lock, a `window.Audio` as long as the real wav, and
 * the audio device. Which plays one window hears is `notification-chime.test.ts`,
 * and a chime while off is `soundtrack-store.test.ts`.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { NotificationChimeSound } from "@/lib/notifications/notification-chime";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { FakeLockManager } from "@/lib/soundtrack/__tests__/fake-locks";
import type { OpenedFakePorts } from "@/lib/soundtrack/__tests__/fake-ports";
import { chimeSeconds } from "@/lib/soundtrack/__tests__/wav-seconds";
import type { SoundtrackPorts } from "@/lib/soundtrack/session";
import type { StemManifest } from "@/lib/soundtrack/stems";

// Hoisted, so that every window's module graph reports to this one list.
const devices = vi.hoisted((): { opened: OpenedFakePorts[] } => ({
  opened: [],
}));

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts, openedFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return {
    openWebAudioPorts: (
      stems: StemManifest,
      volume: number,
    ): SoundtrackPorts => {
      const ports = openFakePorts(stems, volume);
      devices.opened.push(openedFakePorts[openedFakePorts.length - 1]);
      return ports;
    },
  };
});

const RIPPLE_SECONDS = chimeSeconds("ripple");

let refusePlay = false;

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
    return refusePlay
      ? Promise.reject(new Error("autoplay refused"))
      : Promise.resolve();
  }
}

/** Delivers later, and to every channel of the name but the sender, as real ones do. */
class FakeBroadcastChannel {
  private static readonly open = new Set<FakeBroadcastChannel>();
  private readonly listeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  constructor(readonly name: string) {
    FakeBroadcastChannel.open.add(this);
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.add(listener);
  }

  postMessage(data: unknown): void {
    for (const peer of FakeBroadcastChannel.open) {
      if (peer === this || peer.name !== this.name) continue;
      setTimeout(() => {
        for (const listener of peer.listeners) {
          listener(new MessageEvent("message", { data }));
        }
      }, 0);
    }
  }

  close(): void {
    FakeBroadcastChannel.open.delete(this);
  }
}

interface RendererWindow {
  readonly play: (sound: NotificationChimeSound) => void;
  readonly disposeChimes: () => void;
  readonly enable: () => void;
  readonly disable: () => void;
}

async function openWindow(): Promise<RendererWindow> {
  vi.resetModules();
  const chimes = await import("@/lib/notifications/notification-chime");
  const { useSoundtrackStore } = await import("../soundtrack-store");
  return {
    play: chimes.playNotificationChimeSound,
    disposeChimes: chimes.disposeNotificationChimeAudio,
    enable: () => {
      useSoundtrackStore.getState().enable();
    },
    disable: () => {
      useSoundtrackStore.getState().disable();
    },
  };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10);
}

describe("a chime and the window holding the soundtrack", () => {
  let holding: RendererWindow;
  let focused: RendererWindow;

  beforeAll(async () => {
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: new FakeLockManager(),
    });
    holding = await openWindow();
    focused = await openWindow();
  });

  afterAll(() => {
    Reflect.deleteProperty(navigator, "locks");
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    refusePlay = false;
    devices.opened.length = 0;
    holding.enable();
    await settle();
    focused.enable();
    await settle();
    expect(devices.opened).toHaveLength(1);
  });

  afterEach(async () => {
    focused.disable();
    holding.disable();
    await settle();
    holding.disposeChimes();
    focused.disposeChimes();
    vi.useRealTimers();
  });

  it("ducks the music for as long as a chime in another window lasts", async () => {
    focused.play("ripple");
    await settle();

    expect(devices.opened[0].duck).toHaveBeenCalledExactlyOnceWith(
      RIPPLE_SECONDS,
    );
  });

  it("ducks once for a chime in its own window", async () => {
    holding.play("ripple");
    await settle();

    expect(devices.opened[0].duck).toHaveBeenCalledExactlyOnceWith(
      RIPPLE_SECONDS,
    );
  });

  it("ducks once for a chime another window restarted before it was heard", async () => {
    focused.play("ripple");
    focused.play("ripple");
    await settle();

    expect(devices.opened[0].duck).toHaveBeenCalledExactlyOnceWith(
      RIPPLE_SECONDS,
    );
  });

  it("does not duck for a chime another window was refused", async () => {
    refusePlay = true;

    focused.play("ripple");
    await settle();

    expect(devices.opened[0].duck).not.toHaveBeenCalled();
  });

  it("ignores a relay it cannot read", async () => {
    const stranger = new FakeBroadcastChannel(
      persistKey(STORE_KEYS.notificationChimesChannel),
    );
    stranger.postMessage({ chimeSeconds: "soon" });
    stranger.close();
    await settle();

    expect(devices.opened[0].duck).not.toHaveBeenCalled();
  });
});
