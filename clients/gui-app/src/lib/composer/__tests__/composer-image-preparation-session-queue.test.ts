/**
 * `createComposerImagePreparationSession`'s queue: the session-level
 * mechanism behind the structured-paste concurrency fix. Every call site
 * (structured paste's per-node background jobs, remount re-entry, a chat
 * composer's rapid double-paste) launches `prepare` calls synchronously and
 * without awaiting one another - the queue is what turns that into "one
 * decoded bitmap alive at a time" for a given session. Higher-level proof
 * that call sites actually route through it lives in
 * `landing-paste-lifecycle.test.tsx` (structured paste + remount) and
 * `composer-paste-preparation.test.tsx` (chat composer double-paste); this
 * file pins the mechanism itself, directly against the session.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createComposerImagePreparationSession } from "@/lib/composer/composer-image-preparation";
import { pngBytesOfSize } from "./prompt-stash-image-fixtures";

const originalCreateImageBitmap = globalThis.createImageBitmap;

afterEach(() => {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
  vi.restoreAllMocks();
});

/** Distinct valid-PNG-magic, header-less bytes so two `prepare` calls hit the
 * DECODE fallback (this file's fixture bytes deliberately carry no IHDR). */
function distinctPngBytes(tag: number): Uint8Array<ArrayBuffer> {
  const bytes = pngBytesOfSize(16);
  bytes[15] = tag;
  return bytes;
}

interface TestBitmap {
  readonly width: number;
  readonly height: number;
  readonly close: () => void;
}

interface DecodeOrderDouble {
  readonly events: string[];
  readonly gates: Array<() => void>;
}

/** Records each decode's START synchronously and holds it open until the
 * test releases it, so order (not just eventual completion) is provable. */
function installGatedDecodeDouble(): DecodeOrderDouble {
  const events: string[] = [];
  const gates: Array<() => void> = [];
  let index = 0;
  const createImageBitmapDouble = vi.fn(
    (
      _source: ImageBitmapSource,
      _opts: ImageBitmapOptions | undefined,
    ): Promise<TestBitmap> => {
      const label = index;
      index += 1;
      events.push(`decode-call:${label}`);
      return new Promise((resolve) => {
        gates.push(() =>
          resolve({
            width: 100,
            height: 100,
            close: () => events.push(`close:${label}`),
          }),
        );
      });
    },
  );
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: createImageBitmapDouble,
  });
  return { events, gates };
}

describe("createComposerImagePreparationSession - the queue", () => {
  it("serializes two prepare calls issued in the same tick: the second does not begin until the first settles", async () => {
    const double = installGatedDecodeDouble();
    const session = createComposerImagePreparationSession();

    // Both issued synchronously, one after the other, with no await between
    // them - exactly how a structured paste launches its background jobs.
    const promiseA = session.prepare({
      bytes: distinctPngBytes(1),
      fileName: "a.png",
      declaredMimeType: "image/png",
    });
    const promiseB = session.prepare({
      bytes: distinctPngBytes(2),
      fileName: "b.png",
      declaredMimeType: "image/png",
    });

    // Without the queue, both would call `createImageBitmap` in this same
    // tick - the defect the queue exists to close.
    await vi.waitFor(() => expect(double.gates).toHaveLength(1));
    expect(double.events).toEqual(["decode-call:0"]);

    double.gates[0]?.();
    await promiseA;
    // The second decode starts only after the first bitmap's close ran. The
    // queue's tail-advance and B's own launch are separate microtask hops
    // past `promiseA` settling, so poll rather than assert immediately.
    await vi.waitFor(() => expect(double.gates).toHaveLength(2));
    expect(double.events).toEqual([
      "decode-call:0",
      "close:0",
      "decode-call:1",
    ]);

    double.gates[1]?.();
    const preparedB = await promiseB;
    expect(double.events).toEqual([
      "decode-call:0",
      "close:0",
      "decode-call:1",
      "close:1",
    ]);
    expect(preparedB.step).toBe("verbatim");
  });

  it("a rejecting first prepare call releases the queue without rejecting the second, which gets its own result", async () => {
    let callIndex = 0;
    const createImageBitmapDouble = vi.fn(
      (
        _source: ImageBitmapSource,
        _opts: ImageBitmapOptions | undefined,
      ): Promise<TestBitmap> => {
        const index = callIndex;
        callIndex += 1;
        if (index === 0) {
          return Promise.reject(new Error("decode boom"));
        }
        return Promise.resolve({
          width: 100,
          height: 100,
          close: () => undefined,
        });
      },
    );
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: createImageBitmapDouble,
    });

    const session = createComposerImagePreparationSession();
    const promiseA = session.prepare({
      bytes: distinctPngBytes(3),
      fileName: "fails.png",
      declaredMimeType: "image/png",
    });
    const promiseB = session.prepare({
      bytes: distinctPngBytes(4),
      fileName: "succeeds.png",
      declaredMimeType: "image/png",
    });

    await expect(promiseA).rejects.toThrow(/could not be decoded/);
    // B is NOT rejected by A's failure - the tail tracks settlement only, so
    // one caller's rejection releases the queue without propagating into the
    // next caller's own promise.
    const preparedB = await promiseB;
    expect(preparedB.fileName).toBe("succeeds.png");
    expect(preparedB.step).toBe("verbatim");
    expect(createImageBitmapDouble).toHaveBeenCalledTimes(2);
  });
});
