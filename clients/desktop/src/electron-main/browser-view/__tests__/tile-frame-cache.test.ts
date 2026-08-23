import { describe, expect, it } from "vitest";
import {
  TileFrameCache,
  defaultTileFrameEncoder,
  type EncodedTileFrame,
  type TileFrameCacheOptions,
  type TileFrameCacheWebContents,
  type TileFrameImage,
} from "../tile-frame-cache";

interface FakeImageInit {
  readonly width: number;
  readonly height: number;
  readonly empty?: boolean;
  readonly jpegByteLength?: number;
}

class FakeImage implements TileFrameImage {
  readonly emptyValue: boolean;
  readonly size: { readonly width: number; readonly height: number };
  readonly jpegByteLength: number;
  resizeCalls = 0;

  constructor(init: FakeImageInit) {
    this.emptyValue = init.empty ?? false;
    this.size = { width: init.width, height: init.height };
    this.jpegByteLength = init.jpegByteLength ?? 16;
  }

  isEmpty(): boolean {
    return this.emptyValue;
  }

  getSize(): { readonly width: number; readonly height: number } {
    return this.size;
  }

  resize(options: {
    readonly width: number;
    readonly height: number;
  }): TileFrameImage {
    this.resizeCalls += 1;
    return new FakeImage({
      width: options.width,
      height: options.height,
      jpegByteLength: this.jpegByteLength,
    });
  }

  toJPEG(_quality: number): Buffer {
    return Buffer.alloc(this.jpegByteLength, 7);
  }
}

interface GuestFixture {
  readonly webContents: TileFrameCacheWebContents;
  readonly emitted: Array<(image: TileFrameImage) => void>;
  endCount(): number;
}

function makeGuest(): GuestFixture {
  const emitted: Array<(image: TileFrameImage) => void> = [];
  let beginCount = 0;
  let endCount = 0;
  return {
    emitted,
    webContents: {
      beginFrameSubscription(callback) {
        beginCount += 1;
        emitted.push(callback);
      },
      endFrameSubscription() {
        if (beginCount <= endCount) {
          throw new Error("endFrameSubscription without subscription");
        }
        endCount += 1;
      },
    },
    endCount: () => endCount,
  };
}

function firstEmitted(guest: GuestFixture): (image: TileFrameImage) => void {
  const callback = guest.emitted[0];
  if (callback === undefined) throw new Error("subscription missing");
  return callback;
}

function makeHarness(overrides?: {
  readonly encodeFail?: boolean;
  readonly maxAttached?: number;
}): { cache: TileFrameCache; time: { value: number }; evicted: string[] } {
  const time = { value: 0 };
  const evicted: string[] = [];
  const options: TileFrameCacheOptions = {
    minIntervalMs: 75,
    staleAfterMs: 250,
    maxDimension: 1600,
    jpegQuality: 80,
    maxAttached: overrides?.maxAttached ?? 12,
    onEvict: (key) => {
      evicted.push(key);
    },
    now: () => time.value,
    encode: (image) => {
      if (overrides?.encodeFail === true) return null;
      if (image.isEmpty()) return null;
      const size = image.getSize();
      const frame: EncodedTileFrame = {
        dataUrl: `data:image/jpeg;base64,${Buffer.from(image.toJPEG(80)).toString("base64")}`,
        width: size.width,
        height: size.height,
      };
      return frame;
    },
  };
  return { cache: new TileFrameCache(options), time, evicted };
}

describe("TileFrameCache", () => {
  it("accepts the first frame immediately and throttles within the interval", () => {
    const { cache, time } = makeHarness();
    const guest = makeGuest();
    cache.attach("tile-a", guest.webContents);
    const onFrame = firstEmitted(guest);

    time.value = 100;
    onFrame(new FakeImage({ width: 400, height: 300 }));
    expect(cache.get("tile-a")).toMatchObject({ width: 400, height: 300 });

    time.value = 150;
    onFrame(new FakeImage({ width: 402, height: 302 }));
    expect(cache.get("tile-a")).toMatchObject({ width: 400, height: 300 });

    time.value = 200;
    onFrame(new FakeImage({ width: 404, height: 304 }));
    expect(cache.get("tile-a")).toMatchObject({ width: 404, height: 304 });
    expect(cache.stats()).toMatchObject({
      attached: 1,
      framesAccepted: 2,
      framesSkipped: 1,
      emptyFrames: 0,
      encodeFailures: 0,
    });
  });

  it("treats a slot as fresh only inside the staleness window", () => {
    const { cache, time } = makeHarness();
    const guest = makeGuest();
    cache.attach("tile-a", guest.webContents);
    const onFrame = firstEmitted(guest);

    time.value = 1000;
    onFrame(new FakeImage({ width: 320, height: 200 }));
    expect(cache.isFresh("tile-a")).toBe(true);
    expect(cache.ageMs("tile-a")).toBe(0);

    time.value = 1200;
    expect(cache.isFresh("tile-a")).toBe(true);
    expect(cache.ageMs("tile-a")).toBe(200);

    time.value = 1400;
    expect(cache.isFresh("tile-a")).toBe(false);
    expect(cache.get("tile-a")).not.toBeNull();
  });

  it("ignores empty frames and counts encoder failures without clobbering the slot", () => {
    const { cache, time } = makeHarness({ encodeFail: true });
    const guest = makeGuest();
    cache.attach("tile-a", guest.webContents);
    const onFrame = firstEmitted(guest);

    time.value = 10;
    onFrame(new FakeImage({ width: 300, height: 200 }));
    expect(cache.get("tile-a")).toBeNull();

    time.value = 200;
    onFrame(new FakeImage({ width: 300, height: 200, empty: true }));
    expect(cache.stats()).toMatchObject({
      attached: 1,
      framesAccepted: 0,
      emptyFrames: 1,
      encodeFailures: 1,
    });
  });

  it("detaches by unsubscribing exactly once and drops the slot", () => {
    const { cache } = makeHarness();
    const guest = makeGuest();
    cache.attach("tile-a", guest.webContents);
    cache.detach("tile-a");
    expect(guest.endCount()).toBe(1);
    expect(cache.has("tile-a")).toBe(false);
    // Double detach is a no-op; unknown keys never throw.
    cache.detach("tile-a");
    cache.detach("never-attached");
  });

  it("detachAll clears every slot", () => {
    const { cache } = makeHarness();
    const a = makeGuest();
    const b = makeGuest();
    cache.attach("tile-a", a.webContents);
    cache.attach("tile-b", b.webContents);
    cache.detachAll();
    expect(a.endCount()).toBe(1);
    expect(b.endCount()).toBe(1);
    expect(cache.stats().attached).toBe(0);
  });

  it("default encoder downscales past the dimension cap and reports scaled size", () => {
    const encode = defaultTileFrameEncoder(80, 800);
    const big = new FakeImage({ width: 3200, height: 1600 });

    const encoded = encode(big);

    expect(encoded).not.toBeNull();
    expect(encoded?.width).toBe(800);
    expect(encoded?.height).toBe(400);
    expect(big.resizeCalls).toBe(1);

    const small = new FakeImage({ width: 640, height: 480 });
    const untouched = encode(small);
    expect(untouched?.width).toBe(640);
    expect(small.resizeCalls).toBe(0);
    expect(
      untouched?.dataUrl.startsWith("data:image/jpeg;base64,"),
    ).toBe(true);
  });

  it("default encoder rejects empty images", () => {
    const encode = defaultTileFrameEncoder(80, 800);
    expect(encode(new FakeImage({ width: 10, height: 10, empty: true }))).toBe(
      null,
    );
  });

  it("evicts the least-recently-accepted slot when the attach cap is hit (BT-205)", () => {
    const { cache, time, evicted } = makeHarness({ maxAttached: 2 });
    const a = makeGuest();
    const b = makeGuest();
    const c = makeGuest();

    cache.attach("tile-a", a.webContents);
    cache.attach("tile-b", b.webContents);
    time.value = 100;
    a.emitted[0]?.(new FakeImage({ width: 100, height: 80 }));
    // tile-a now most-recently-accepted; attaching the third must evict the
    // never-accepted tile-b first.
    cache.attach("tile-c", c.webContents);

    expect(cache.has("tile-a")).toBe(true);
    expect(cache.has("tile-b")).toBe(false);
    expect(cache.has("tile-c")).toBe(true);
    expect(b.endCount()).toBe(1);
    expect(evicted).toEqual(["tile-b"]);
  });

  it("never evicts the incoming key and re-attaching an evicted slot works", () => {
    const { cache, evicted } = makeHarness({ maxAttached: 1 });
    const a = makeGuest();
    const b = makeGuest();

    cache.attach("tile-a", a.webContents);
    cache.attach("tile-a", a.webContents); // same key: no-op
    expect(a.emitted).toHaveLength(1);
    expect(evicted).toEqual([]);

    cache.attach("tile-b", b.webContents);
    expect(cache.has("tile-b")).toBe(true);
    expect(evicted).toEqual(["tile-a"]);
    expect(a.endCount()).toBe(1);

    // Re-attaching an evicted slot re-subscribes and evicts the incumbent.
    cache.attach("tile-a", a.webContents);
    expect(cache.has("tile-a")).toBe(true);
    expect(evicted).toEqual(["tile-a", "tile-b"]);
    expect(b.endCount()).toBe(1);
  });
});
