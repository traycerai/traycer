/**
 * The soundtrack's entry in the system's media controls, against jsdom: it has
 * no `navigator.mediaSession`, no `MediaMetadata`, and media elements that play
 * nothing, so those three are the fakes. The fake session keeps what the page
 * set on it, and the OS pressing a button is the test calling the handler the
 * page registered.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import {
  openSoundtrackMediaSession,
  type MediaSessionHandlers,
} from "../media-session";

type MediaSessionAction = "play" | "pause" | "nexttrack" | "previoustrack";

class FakeMediaMetadata {
  constructor(readonly init: MediaMetadataInit) {}
}

class FakeMediaSession {
  metadata: FakeMediaMetadata | null = null;
  playbackState: MediaSessionPlaybackState = "none";
  position: MediaPositionState | null = null;
  readonly handlers = new Map<MediaSessionAction, () => void>();

  setActionHandler(action: MediaSessionAction, handler: (() => void) | null) {
    if (handler === null) this.handlers.delete(action);
    else this.handlers.set(action, handler);
  }

  setPositionState(state: MediaPositionState | undefined) {
    this.position = state ?? null;
  }

  /** The OS pressing the button for `action`. */
  press(action: MediaSessionAction): void {
    const handler = this.handlers.get(action);
    if (handler === undefined) throw new Error(`No handler for ${action}`);
    handler();
  }
}

function newHandlers(): MediaSessionHandlers {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
  };
}

const OBJECT_URL = "blob:silent-anchor";

let osSession: FakeMediaSession;
let play: MockInstance<() => Promise<void>>;
let pause: MockInstance<() => void>;
let createObjectURL: Mock<(blob: Blob) => string>;
let revokeObjectURL: Mock<(url: string) => void>;

/** The element the session plays, which jsdom's `play` was called on. */
function anchorElement(): HTMLAudioElement {
  const [anchor] = play.mock.contexts;
  if (!(anchor instanceof HTMLAudioElement)) {
    throw new Error("The session never played an audio element");
  }
  return anchor;
}

beforeEach(() => {
  osSession = new FakeMediaSession();
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: osSession,
  });
  vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
  play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(() => Promise.resolve());
  pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => undefined);
  // jsdom's `load` reports "not implemented" on the console.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
  createObjectURL = vi.fn<(blob: Blob) => string>(() => OBJECT_URL);
  revokeObjectURL = vi.fn<(url: string) => void>();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openSoundtrackMediaSession", () => {
  it("plays a looping anchor, offers the four buttons with no timeline, and routes each press to its handler", () => {
    const handlers = newHandlers();

    openSoundtrackMediaSession(handlers);

    const anchor = anchorElement();
    expect(play).toHaveBeenCalledTimes(1);
    expect(anchor.loop).toBe(true);
    expect(anchor.muted).toBe(false);
    expect(anchor.getAttribute("src")).toBe(OBJECT_URL);
    expect(osSession.position).toEqual({
      duration: 0,
      position: 0,
      playbackRate: 1,
    });
    expect(osSession.playbackState).toBe("playing");

    osSession.press("play");
    osSession.press("pause");
    osSession.press("nexttrack");
    osSession.press("previoustrack");
    expect(handlers.play).toHaveBeenCalledTimes(1);
    expect(handlers.pause).toHaveBeenCalledTimes(1);
    expect(handlers.next).toHaveBeenCalledTimes(1);
    expect(handlers.previous).toHaveBeenCalledTimes(1);
  });

  it("names the track after Traycer with the icon, and only Traycer while there is no track", () => {
    const session = openSoundtrackMediaSession(newHandlers());

    session?.setTrack("Aquilo");
    const { artwork, ...named } = osSession.metadata?.init ?? {};
    expect(named).toEqual({ title: "Aquilo", artist: "Traycer" });
    expect(artwork).toHaveLength(1);
    expect(artwork?.[0]?.src).toMatch(/traycer-icon\.png$/);
    expect(artwork?.[0]).toMatchObject({ sizes: "256x256", type: "image/png" });

    session?.setTrack(null);
    const { artwork: stillArtwork, ...alone } = osSession.metadata?.init ?? {};
    expect(alone).toEqual({ title: "Traycer" });
    expect(stillArtwork).toEqual(artwork);
  });

  it("pauses the anchor and reports paused, then plays it again at Play", () => {
    const session = openSoundtrackMediaSession(newHandlers());

    session?.setPaused(true);
    expect(pause.mock.contexts).toEqual([anchorElement()]);
    expect(osSession.playbackState).toBe("paused");

    session?.setPaused(false);
    expect(play.mock.contexts).toEqual([anchorElement(), anchorElement()]);
    expect(osSession.playbackState).toBe("playing");
  });

  it("takes everything back out of the system's controls when closed", () => {
    const session = openSoundtrackMediaSession(newHandlers());
    session?.setTrack("Aquilo");

    session?.close();

    expect(pause.mock.contexts).toEqual([anchorElement()]);
    expect(anchorElement().hasAttribute("src")).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    expect(osSession.handlers.size).toBe(0);
    expect(osSession.position).toBeNull();
    expect(osSession.metadata).toBeNull();
    expect(osSession.playbackState).toBe("none");
  });

  it("joins nothing where the system has no media controls", () => {
    Reflect.deleteProperty(navigator, "mediaSession");

    expect(openSoundtrackMediaSession(newHandlers())).toBeNull();
    expect(play).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("plays a valid 10 s mono 8-bit WAV of silence", async () => {
    openSoundtrackMediaSession(newHandlers());

    const [blob] = createObjectURL.mock.calls[0];
    expect(blob.type).toBe("audio/wav");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const tag = (offset: number): string =>
      String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const sampleCount = 10 * 8_000;

    expect(bytes.byteLength).toBe(44 + sampleCount);
    expect(tag(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + sampleCount);
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8_000);
    expect(view.getUint32(28, true)).toBe(8_000);
    expect(view.getUint16(32, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(8);
    expect(tag(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(sampleCount);
    expect([bytes[44], bytes[44 + sampleCount / 2], bytes.at(-1)]).toEqual([
      0x80, 0x80, 0x80,
    ]);
  });
});
