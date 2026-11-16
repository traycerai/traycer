/**
 * What the store and the system's media controls name as sounding, against what
 * the REAL session has started on the (fake) audio device. A recording's length
 * says which piece is audible: A is 10 s, B is 12 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundtrackManifest } from "@/lib/soundtrack/manifest";
import type { MediaSessionHandlers } from "@/lib/soundtrack/media-session";
import type { SoundtrackPorts } from "@/lib/soundtrack/session";
import { SoundtrackLogRelay } from "@/lib/soundtrack/session-log";
import type { MixSignals } from "@/lib/soundtrack/signals";
import { makeAudioBuffer } from "@/lib/soundtrack/__tests__/audio-buffer";
import { captureNothing, FakeStems } from "@/lib/soundtrack/__tests__/fakes";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import { RecordingOutput } from "@/lib/soundtrack/__tests__/recording-output";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { createSoundtrackStore } from "../soundtrack-store";

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};
const TASK: MixSignals = { ...HOME, view: "task" };

const SECONDS_BY_TITLE = new Map([
  ["Piece A", 10],
  ["Piece B", 12],
  ["Piece C", 14],
]);

function manifestOf(
  tracks: SoundtrackManifest["tracks"],
  views: SoundtrackManifest["views"],
): SoundtrackManifest {
  return {
    tracks,
    views,
    stems: {
      tracks: [],
      recordings: [
        { name: "ma", file: "a.opus" },
        { name: "mb", file: "b.opus" },
        { name: "mc", file: "c.opus" },
      ],
    },
  };
}

const PIECES = manifestOf(
  [
    { kind: "composed", name: "a", title: "Piece A", recording: "ma" },
    { kind: "composed", name: "b", title: "Piece B", recording: "mb" },
  ],
  { home: ["a", "b"], task: [], bot: [], settings: [] },
);

const CALM_THEN_PIECE = manifestOf(
  [
    { ...playbackTrack("calm", 60), title: "Calm" },
    { kind: "composed", name: "a", title: "Piece A", recording: "ma" },
  ],
  { home: ["calm", "a"], task: [], bot: [], settings: [] },
);

const NAVIGATION = manifestOf(
  [
    { kind: "composed", name: "a", title: "Piece A", recording: "ma" },
    { kind: "composed", name: "c", title: "Piece C", recording: "mc" },
  ],
  { home: ["a"], task: ["c"], bot: [], settings: [] },
);

function newWindow(manifest: SoundtrackManifest) {
  const output = new RecordingOutput();
  const titles: (string | null)[] = [];
  const handlers: MediaSessionHandlers[] = [];
  const stems = new FakeStems(2.2);
  const lengths = new Map([
    ["ma", 10],
    ["mb", 12],
    ["mc", 14],
  ]);
  const ports: SoundtrackPorts = {
    output,
    stems: {
      load: stems.load.bind(stems),
      loadRecording: (name) =>
        Promise.resolve(makeAudioBuffer(lengths.get(name) ?? 10, 10)),
    },
    setDimmed: () => undefined,
    setVolume: () => undefined,
    duck: () => undefined,
    close: () => undefined,
    log: new SoundtrackLogRelay(),
    captureMix: captureNothing,
    pause: () => output.stopClock(),
    resume: () => output.startClock(),
  };
  const store = createSoundtrackStore({
    readManifest: () => manifest,
    openPorts: () => ports,
    random: () => 0,
    recordingChannel: () => null,
    openMediaSession: (given) => {
      handlers.push(given);
      return {
        setTrack: (title) => titles.push(title),
        setPaused: () => undefined,
        close: () => undefined,
      };
    },
  });
  store.getState().setDirector("static");
  return { store, output, titles, handlers };
}

/** The title of the newest recording still playing, null if none is. */
function audible(output: RecordingOutput): string | null {
  const live = output.recordings.filter((call) => !call.cancelled).at(-1);
  if (live === undefined) return null;
  for (const [title, seconds] of SECONDS_BY_TITLE) {
    if (seconds === live.duration) return title;
  }
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.getState().setSoundtrackPaused(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

describe("soundtrack store: what is named as sounding is what is audible", () => {
  it("follows an automatic end into the next piece once its audio starts", async () => {
    const { store, output, titles } = newWindow(PIECES);
    store.getState().enable();
    store.getState().setSignals(HOME);
    await advance(5.1);
    output.recordings[0].ended();
    // The silence is 8 s; step until the next piece's audio starts.
    for (let i = 0; i < 100 && output.recordings.length < 2; i += 1) {
      await advance(0.1);
    }
    expect(audible(output)).toBe("Piece B");
    expect(store.getState().soundingTrack?.title).toBe("Piece B");
    expect(titles.at(-1)).toBe("Piece B");
    store.getState().disable();
  });

  it("names the piece a Next in the silence after an automatic end starts", async () => {
    const { store, output, titles } = newWindow(PIECES);
    store.getState().enable();
    store.getState().setSignals(HOME);
    await advance(5.1);
    output.recordings[0].ended();
    await advance(0.5);
    store.getState().next();
    await advance(0.1);
    expect(audible(output)).toBe("Piece B");
    expect(store.getState().soundingTrack?.title).toBe("Piece B");
    expect(titles.at(-1)).toBe("Piece B");
    store.getState().disable();
  });

  it("names the piece the system's Next starts in that silence", async () => {
    const { store, output, titles, handlers } = newWindow(PIECES);
    store.getState().enable();
    store.getState().setSignals(HOME);
    await advance(5.1);
    output.recordings[0].ended();
    await advance(0.5);
    handlers[0].next();
    await advance(0.1);
    expect(audible(output)).toBe("Piece B");
    expect(titles.at(-1)).toBe("Piece B");
    store.getState().disable();
  });

  it("names the piece a Next in the silence after a generative run ends starts", async () => {
    const { store, output, titles } = newWindow(CALM_THEN_PIECE);
    store.getState().enable();
    store.getState().setSignals(HOME);
    // 62 s is past Calm's 60 s run and inside the silence before the piece.
    await advance(62);
    expect(output.recordings).toHaveLength(0);
    store.getState().next();
    await advance(0.1);
    expect(audible(output)).toBe("Piece A");
    expect(store.getState().soundingTrack?.title).toBe("Piece A");
    expect(titles.at(-1)).toBe("Piece A");
    store.getState().disable();
  });

  it("goes back to the piece before with Previous after a Next in the silence", async () => {
    const { store, output, titles } = newWindow(PIECES);
    store.getState().enable();
    store.getState().setSignals(HOME);
    await advance(5.1);
    output.recordings[0].ended();
    await advance(0.5);
    store.getState().next();
    await advance(0.1);
    store.getState().previous();
    expect(store.getState().soundingTrack?.title).toBe("Piece A");
    expect(titles.at(-1)).toBe("Piece A");
    store.getState().disable();
  });

  it("goes back to the generative track with Previous after an automatic move into a piece", async () => {
    const { store, output, titles } = newWindow(CALM_THEN_PIECE);
    store.getState().enable();
    store.getState().setSignals(HOME);
    for (let i = 0; i < 300 && output.recordings.length < 1; i += 1) {
      await advance(1);
    }
    expect(audible(output)).toBe("Piece A");
    expect(titles.at(-1)).toBe("Piece A");
    store.getState().previous();
    expect(store.getState().soundingTrack?.title).toBe("Calm");
    expect(titles.at(-1)).toBe("Calm");
    store.getState().disable();
  });

  it("names the next piece when Play comes back during the silence of an automatic end", async () => {
    const { store, output, titles } = newWindow(PIECES);
    store.getState().enable();
    store.getState().setSignals(HOME);
    await advance(5.1);
    output.recordings[0].ended();
    await advance(0.5);
    store.getState().setPaused(true);
    await advance(30);
    expect(output.recordings).toHaveLength(1);
    store.getState().setPaused(false);
    expect(titles.at(-1)).toBe("Piece B");
    for (let i = 0; i < 100 && output.recordings.length < 2; i += 1) {
      await advance(0.1);
    }
    expect(audible(output)).toBe("Piece B");
    expect(titles.at(-1)).toBe("Piece B");
    store.getState().disable();
  });

  it("names a piece's own title after a view change and back", async () => {
    const { store, titles } = newWindow(NAVIGATION);
    store.getState().enable();
    store.getState().setSignals(HOME);
    await advance(1);
    expect(titles.at(-1)).toBe("Piece A");
    store.getState().setSignals(TASK);
    await advance(1);
    expect(store.getState().soundingView).toBe("task");
    expect(titles.at(-1)).toBe("Piece C");
    store.getState().setSignals(HOME);
    await advance(1);
    expect(store.getState().soundingView).toBe("home");
    expect(titles.at(-1)).toBe("Piece A");
    store.getState().disable();
  });
});
