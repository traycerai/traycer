/**
 * `setSetPiecesEnabled` on the soundtrack store: gated on the desktop
 * staging bridge (`desktopSoundtrackBridge`), defaults to on for a fresh
 * session, and reaches the real session underneath.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComposedTrack,
  SoundtrackManifest,
} from "@/lib/soundtrack/manifest";
import type { SoundtrackPorts } from "@/lib/soundtrack/session";
import { SoundtrackLogRelay } from "@/lib/soundtrack/session-log";
import type { MixSignals } from "@/lib/soundtrack/signals";
import { makeAudioBuffer } from "@/lib/soundtrack/__tests__/audio-buffer";
import {
  captureNothing,
  FakeOutput,
  FakeStems,
} from "@/lib/soundtrack/__tests__/fakes";
import { createSoundtrackStore } from "../soundtrack-store";

function pieceOf(name: string, recording: string): ComposedTrack {
  return { kind: "composed", name, title: name, recording };
}

const MANIFEST: SoundtrackManifest = {
  tracks: [pieceOf("piece", "master")],
  views: { home: ["piece"], task: [], bot: [], settings: [] },
  stems: { tracks: [], recordings: [{ name: "master", file: "piece.opus" }] },
};

function signalsOf(overrides: Partial<MixSignals>): MixSignals {
  return {
    view: "home",
    working: 0,
    blocking: 0,
    failure: 0,
    done: 0,
    ...overrides,
  };
}

function harness() {
  const output = new FakeOutput();
  const fakeStems = new FakeStems(2.2);
  const openPorts = vi.fn((): SoundtrackPorts => ({
    output,
    stems: {
      load: fakeStems.load.bind(fakeStems),
      loadRecording: () => Promise.resolve(makeAudioBuffer(10, 10)),
    },
    setDimmed: () => undefined,
    setVolume: () => undefined,
    duck: () => undefined,
    close: () => undefined,
    log: new SoundtrackLogRelay(),
    captureMix: captureNothing,
    pause: () => output.stopClock(),
    resume: () => output.startClock(),
  }));
  const store = createSoundtrackStore({
    readManifest: () => MANIFEST,
    openPorts,
    random: () => 0,
    recordingChannel: () => null,
    openMediaSession: () => null,
  });
  return { store, output };
}

let hadHost = false;
let originalHost: unknown;

function installBridge(): void {
  Reflect.set(globalThis, "runnerHost", {
    soundtrackSourceAvailable: true,
    readSoundtrackSet: () => Promise.resolve({ kind: "unavailable" as const }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  hadHost = Reflect.has(globalThis, "runnerHost");
  originalHost = Reflect.get(globalThis, "runnerHost");
  Reflect.deleteProperty(globalThis, "runnerHost");
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "runnerHost");
  if (hadHost) Reflect.set(globalThis, "runnerHost", originalHost);
  vi.restoreAllMocks();
});

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

describe("soundtrack store: set pieces", () => {
  it("ignores the choice with no desktop bridge, leaving the session untouched", async () => {
    const { store, output } = harness();
    store.getState().enable();
    store.getState().setSignals(signalsOf({}));
    await advance(1);
    expect(output.cuts()).toEqual([]);

    store.getState().setSetPiecesEnabled(false);

    expect(store.getState().setPiecesEnabled).toBe(true);
    expect(output.cuts()).toEqual([]);
  });

  it("stops a sounding piece through the real session once the bridge is present", async () => {
    installBridge();
    const { store, output } = harness();
    store.getState().enable();
    store.getState().setSignals(signalsOf({}));
    await advance(1);
    expect(output.allPlays().length).toBeGreaterThan(0);

    store.getState().setSetPiecesEnabled(false);

    expect(store.getState().setPiecesEnabled).toBe(false);
    expect(output.cuts().length).toBeGreaterThan(0);
    expect(store.getState().soundingView).toBeNull();
  });

  it("applies the window's choice to a session opened after it was turned off", async () => {
    installBridge();
    const { store, output } = harness();
    store.getState().setSetPiecesEnabled(false);
    store.getState().enable();
    store.getState().setSignals(signalsOf({}));
    await advance(1);

    expect(output.allPlays()).toEqual([]);
    expect(store.getState().soundingView).toBeNull();
  });
});
