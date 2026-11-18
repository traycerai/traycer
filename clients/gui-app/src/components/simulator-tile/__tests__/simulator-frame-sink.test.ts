import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttachableFrameSink } from "@/components/simulator-tile/simulator-frame-sink";

let urlCounter = 0;
const createObjectURL = vi.fn(
  (_obj: Blob | MediaSource) => `blob:mock/${String(++urlCounter)}`,
);
const revokeObjectURL = vi.fn((_url: string) => undefined);
// jsdom may define neither; the descriptors put back whatever was there.
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function restore(
  name: "createObjectURL" | "revokeObjectURL",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(URL, name);
  else Object.defineProperty(URL, name, descriptor);
}

beforeEach(() => {
  urlCounter = 0;
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  restore("createObjectURL", originalCreate);
  restore("revokeObjectURL", originalRevoke);
  vi.clearAllMocks();
});

describe("createAttachableFrameSink", () => {
  it("revokes the last JPEG's object URL once its elements detach", () => {
    const sink = createAttachableFrameSink();
    const image = document.createElement("img");
    sink.attachCanvas(document.createElement("canvas"));
    sink.attachImage(image);

    expect(sink.presentJpeg(new Uint8Array([0xff, 0xd8]))).toBe(true);
    expect(sink.presentJpeg(new Uint8Array([0xff, 0xd8]))).toBe(true);
    // Each frame revokes the one before it.
    expect(revokeObjectURL.mock.calls).toEqual([["blob:mock/1"]]);
    expect(image.src).toBe("blob:mock/2");

    // The surface unmounting detaches both elements through its refs.
    sink.attachCanvas(null);
    sink.attachImage(null);
    expect(revokeObjectURL.mock.calls).toEqual([
      ["blob:mock/1"],
      ["blob:mock/2"],
    ]);
    expect(sink.presentJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });
});
