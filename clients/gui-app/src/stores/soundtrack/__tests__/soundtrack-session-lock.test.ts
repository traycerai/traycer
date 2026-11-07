/**
 * One soundtrack session across the app's windows: two real stores, each a
 * window, over one fake `navigator.locks` as one app origin shares, and a fake
 * audio device. That the browser lets go of a closed window is the platform's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import { FakeLockManager } from "@/lib/soundtrack/__tests__/fake-locks";
import {
  openedFakePorts,
  openFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import {
  SOUNDTRACK_MANIFEST,
  type SoundtrackManifest,
} from "@/lib/soundtrack/manifest";
import type { SoundtrackPorts } from "@/lib/soundtrack/session";
import type { StemManifest } from "@/lib/soundtrack/stems";
import { createSoundtrackStore } from "../soundtrack-store";

type ReadManifest = () => SoundtrackManifest | Promise<SoundtrackManifest>;

const readBundled: ReadManifest = () => SOUNDTRACK_MANIFEST;

function openWindow(
  openPorts: (stems: StemManifest, volume: number) => SoundtrackPorts,
  readManifest: ReadManifest,
) {
  return createSoundtrackStore({
    readManifest,
    openPorts,
    random: () => 0.5,
    recordingChannel: () => null,
  }).getState;
}

/** A first read that fails when told to, and every later one that succeeds. */
function failingFirstRead(): {
  readonly readManifest: ReadManifest;
  readonly fail: () => void;
} {
  let fail: () => void = () => undefined;
  const first = new Promise<SoundtrackManifest>((_resolve, reject) => {
    fail = () => {
      reject(new Error("the chunk did not load"));
    };
  });
  const readManifest = vi
    .fn<ReadManifest>()
    .mockReturnValueOnce(first)
    .mockReturnValue(SOUNDTRACK_MANIFEST);
  return { readManifest, fail };
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
    const first = openWindow(openFakePorts, readBundled);
    const second = openWindow(openFakePorts, readBundled);

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
    const first = openWindow(openFakePorts, readBundled);
    const second = openWindow(openFakePorts, readBundled);

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
    const first = openWindow(openFakePorts, readBundled);
    const second = openWindow(openFakePorts, readBundled);

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
    }, readBundled);
    const second = openWindow(openFakePorts, readBundled);

    refused().enable();
    await settle();
    expect(refused().enabled).toBe(false);

    second().enable();
    await settle();
    expect(second().enabled).toBe(true);

    second().disable();
  });

  it("lets the queued window play, and this one try again, when its manifest read fails", async () => {
    vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    const { readManifest, fail } = failingFirstRead();
    const failing = openWindow(openFakePorts, readManifest);
    const queued = openWindow(openFakePorts, readBundled);

    failing().enable();
    await settle();
    queued().enable();
    await settle();
    expect(openedFakePorts).toHaveLength(0);

    fail();
    await settle();

    expect(failing().enabled).toBe(false);
    expect(queued().enabled).toBe(true);

    queued().disable();
    await settle();
    failing().enable();
    await settle();
    expect(failing().enabled).toBe(true);

    failing().disable();
  });

  it("keeps a newer session's lock when a read it dropped fails late", async () => {
    vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    const { readManifest, fail } = failingFirstRead();
    const playing = openWindow(openFakePorts, readManifest);
    const queued = openWindow(openFakePorts, readBundled);

    playing().enable();
    await settle();
    playing().disable();
    playing().enable();
    await settle();
    expect(playing().enabled).toBe(true);
    queued().enable();
    await settle();

    fail();
    await settle();

    expect(playing().enabled).toBe(true);
    expect(queued().enabled).toBe(false);

    playing().disable();
    await settle();
    expect(queued().enabled).toBe(true);

    queued().disable();
  });
});
