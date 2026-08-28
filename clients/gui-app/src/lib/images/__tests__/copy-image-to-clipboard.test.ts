import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyImageBlobPromiseToClipboard,
  copyImageBlobToClipboard,
} from "@/lib/images/copy-image-to-clipboard";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
class FakeClipboardItem {
  readonly items: Record<string, Blob | Promise<Blob>>;

  constructor(items: Record<string, Blob | Promise<Blob>>) {
    this.items = items;
  }
}

interface ImageClipboardPayload {
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

afterEach(() => {
  if (originalClipboardDescriptor === undefined) {
    // jsdom may not define clipboard; leave a clean slate.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("copyImageBlobToClipboard", () => {
  it("writes via ClipboardItem when the browser clipboard supports image write", async () => {
    const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>(() =>
      Promise.resolve(),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    await copyImageBlobToClipboard(blob);

    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(FakeClipboardItem);
  });

  it("falls back to the Electron runnerHost.platform.clipboard.writeImage bridge", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: vi.fn(() =>
          Promise.reject(new Error("MIME type not supported in renderer")),
        ),
      },
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    const writeImage = vi.fn<(payload: ImageClipboardPayload) => Promise<void>>(
      () => Promise.resolve(),
    );
    vi.stubGlobal("runnerHost", {
      platform: { clipboard: { writeImage } },
    });

    const bytes = new Uint8Array([9, 8, 7]);
    const blob = new Blob([bytes], { type: "image/png" });
    await copyImageBlobToClipboard(blob);

    expect(writeImage).toHaveBeenCalledTimes(1);
    const [payload] = writeImage.mock.calls[0];
    expect(payload.type).toBe("image/png");
    expect(payload.bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(payload.bytes)).toEqual(bytes);
  });

  it("uses the desktop bridge when ClipboardItem is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: vi.fn() },
    });
    vi.stubGlobal("ClipboardItem", undefined);

    const writeImage = vi.fn<(payload: ImageClipboardPayload) => Promise<void>>(
      () => Promise.resolve(),
    );
    vi.stubGlobal("runnerHost", {
      platform: { clipboard: { writeImage } },
    });

    await copyImageBlobToClipboard(
      new Blob([new Uint8Array([4])], { type: "image/jpeg" }),
    );
    expect(writeImage).toHaveBeenCalledTimes(1);
    expect(writeImage.mock.calls[0]?.[0]).toMatchObject({ type: "image/jpeg" });
  });

  it("throws when neither ClipboardItem write nor desktop bridge is available", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {},
    });
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("runnerHost", undefined);

    await expect(
      copyImageBlobToClipboard(
        new Blob([new Uint8Array([1])], { type: "image/png" }),
      ),
    ).rejects.toThrow(/Image clipboard is unavailable/);
  });
});

describe("copyImageBlobPromiseToClipboard", () => {
  it("issues the browser write against the still-pending blob", async () => {
    const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>(() =>
      Promise.resolve(),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    let resolveCapture: (blob: Blob) => void = () => undefined;
    const capture = new Promise<Blob>((resolve) => {
      resolveCapture = resolve;
    });
    const copied = copyImageBlobPromiseToClipboard(capture);

    // Synchronously - no `await` between the caller's click and the write, so
    // the write still carries the user activation WebKit requires.
    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0];
    const item = items[0];
    expect(item).toBeInstanceOf(FakeClipboardItem);
    if (!(item instanceof FakeClipboardItem)) throw new Error("no item");
    expect(item.items["image/png"]).toBe(capture);

    resolveCapture(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    );
    await copied;
  });

  it("awaits the capture and falls back to the desktop bridge when the browser write rejects", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: vi.fn(() =>
          Promise.reject(new Error("MIME type not supported in renderer")),
        ),
      },
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    const writeImage = vi.fn<(payload: ImageClipboardPayload) => Promise<void>>(
      () => Promise.resolve(),
    );
    vi.stubGlobal("runnerHost", {
      platform: { clipboard: { writeImage } },
    });

    const bytes = new Uint8Array([9, 8, 7]);
    await copyImageBlobPromiseToClipboard(
      Promise.resolve(new Blob([bytes], { type: "image/png" })),
    );

    expect(writeImage).toHaveBeenCalledTimes(1);
    const [payload] = writeImage.mock.calls[0];
    expect(new Uint8Array(payload.bytes)).toEqual(bytes);
  });

  it("surfaces a capture failure as itself rather than as an unavailable clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: vi.fn(() => Promise.reject(new Error("no activation"))) },
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("runnerHost", undefined);

    await expect(
      copyImageBlobPromiseToClipboard(
        Promise.reject(new Error("capture boom")),
      ),
    ).rejects.toThrow(/capture boom/);
  });
});
