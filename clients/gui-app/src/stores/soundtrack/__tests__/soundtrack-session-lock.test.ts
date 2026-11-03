/**
 * One soundtrack session across the app's windows: two real stores, each a
 * window, over one fake `navigator.locks` as one app origin shares, and a fake
 * audio device. That the browser lets go of a closed window is the platform's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import {
  openedFakePorts,
  openFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { SOUNDTRACK_MANIFEST } from "@/lib/soundtrack/manifest";
import type { SoundtrackPorts } from "@/lib/soundtrack/session";
import type { StemManifest } from "@/lib/soundtrack/stems";
import { createSoundtrackStore } from "../soundtrack-store";

/** The one exclusive, first-come lock `holdSoundtrackSessionLock` asks for. */
class FakeLockManager {
  private held = false;
  private readonly waiting: Array<() => void> = [];

  request(_name: string, granted: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.held = true;
        void granted().then(() => {
          this.held = false;
          this.waiting.shift()?.();
          resolve();
        });
      };
      if (this.held) this.waiting.push(grant);
      else grant();
    });
  }
}

function openWindow(
  openPorts: (stems: StemManifest, volume: number) => SoundtrackPorts,
) {
  return createSoundtrackStore({
    readManifest: () => SOUNDTRACK_MANIFEST,
    openPorts,
    random: () => 0.5,
  }).getState;
}

/** Lets every turn already due happen, past which nothing else will. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFakePorts();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: new FakeLockManager(),
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the soundtrack across windows", () => {
  it("keeps a second window silent while the first plays, and hands over when it ends", async () => {
    const first = openWindow(openFakePorts);
    const second = openWindow(openFakePorts);

    first().enable();
    await settle();
    second().enable();
    await settle();

    expect(openedFakePorts).toHaveLength(1);
    expect(first().enabled).toBe(true);
    expect(second().enabled).toBe(false);

    first().disable();
    await settle();

    expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
    expect(openedFakePorts).toHaveLength(2);
    expect(second().enabled).toBe(true);

    second().disable();
  });

  it("opens nothing for a window that turned off while waiting", async () => {
    const first = openWindow(openFakePorts);
    const second = openWindow(openFakePorts);

    first().enable();
    await settle();
    second().enable();
    await settle();
    second().disable();
    first().disable();
    await settle();

    expect(openedFakePorts).toHaveLength(1);
    expect(second().enabled).toBe(false);
  });

  it("opens nothing for a turn that arrives after the window turned off, and leaves the lock free", async () => {
    const first = openWindow(openFakePorts);
    const second = openWindow(openFakePorts);

    first().enable();
    first().disable();
    await settle();
    expect(openedFakePorts).toHaveLength(0);

    second().enable();
    await settle();
    expect(second().enabled).toBe(true);

    second().disable();
  });

  it("lets the next window play when this one's device will not open", async () => {
    vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    const refused = openWindow(() => {
      throw new Error("no output device");
    });
    const second = openWindow(openFakePorts);

    refused().enable();
    await settle();
    expect(refused().enabled).toBe(false);

    second().enable();
    await settle();
    expect(second().enabled).toBe(true);

    second().disable();
  });
});
