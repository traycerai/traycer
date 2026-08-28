/**
 * The phone's native save leg. A WKWebView honours no browser save route, so
 * these cases are the whole difference between an export that reaches the user
 * and one that resolves successfully having written nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileFileSave } from "../src/file-save";

const nativeMocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  share: vi.fn(),
}));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" },
  Filesystem: { writeFile: nativeMocks.writeFile },
}));

vi.mock("@capacitor/share", () => ({
  Share: { share: nativeMocks.share },
}));

/** The single `writeFile` payload, as the plugin received it. */
function writtenFile(): {
  path: string;
  data: string;
  directory: string;
  recursive: boolean;
} {
  const [call] = nativeMocks.writeFile.mock.calls;
  if (call === undefined) throw new Error("Nothing was written.");
  return call[0] as {
    path: string;
    data: string;
    directory: string;
    recursive: boolean;
  };
}

/** The bytes the plugin was handed, decoded back out of its base64 payload. */
function writtenBytes(): Uint8Array {
  const binary = atob(writtenFile().data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function request(name: string, bytes: Uint8Array) {
  return {
    name,
    type: "image/png",
    // A fresh, exactly-sized buffer: `bytes.buffer` on a subarray would carry
    // the whole backing store.
    bytes: bytes.slice().buffer,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeMocks.writeFile.mockResolvedValue({
    uri: "file:///cache/traycer-exports/diagram.png",
  });
  nativeMocks.share.mockResolvedValue({
    activityType: "com.apple.DocumentsApp",
  });
});

describe("MobileFileSave", () => {
  it("stages the bytes in the cache container and offers that file to the share sheet", async () => {
    const saved = await new MobileFileSave().saveFile(
      request("diagram.png", new Uint8Array([1, 2, 3])),
    );

    expect(writtenFile()).toMatchObject({
      path: "traycer-exports/diagram.png",
      directory: "CACHE",
      recursive: true,
    });
    expect(nativeMocks.share).toHaveBeenCalledWith({
      title: "diagram.png",
      files: ["file:///cache/traycer-exports/diagram.png"],
    });
    // No path: the sheet says which activity ran, never where it put the file.
    expect(saved).toEqual({ name: "diagram.png", path: null });
  });

  it("hands over the exact bytes it was given", async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 200, 255]);

    await new MobileFileSave().saveFile(request("blob.bin", bytes));

    expect(Array.from(writtenBytes())).toEqual(Array.from(bytes));
  });

  it("encodes a payload far past the argument limit without losing a byte", async () => {
    // The exports this path exists for are megabytes; a whole-buffer spread
    // into `String.fromCharCode` throws well below that size.
    const bytes = new Uint8Array(300_000);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }

    await new MobileFileSave().saveFile(request("big.bin", bytes));

    const written = writtenBytes();
    expect(written.length).toBe(bytes.length);
    expect(Array.from(written.subarray(0, 4))).toEqual([0, 1, 2, 3]);
    expect(Array.from(written.subarray(-4))).toEqual(
      Array.from(bytes.subarray(-4)),
    );
  });

  it("reports a dismissed sheet as no save rather than a failure", async () => {
    nativeMocks.share.mockRejectedValue(new Error("Share canceled"));

    await expect(
      new MobileFileSave().saveFile(
        request("diagram.png", new Uint8Array([1])),
      ),
    ).resolves.toBeNull();
  });

  it("propagates a real share failure so the caller can toast it", async () => {
    nativeMocks.share.mockRejectedValue(new Error("Share API not available"));

    await expect(
      new MobileFileSave().saveFile(
        request("diagram.png", new Uint8Array([1])),
      ),
    ).rejects.toThrow("Share API not available");
  });

  it("keeps a composed name inside the export directory", async () => {
    // Suggested names are built from user content (an image's alt text, an
    // epic title), so a separator in one must not choose a directory.
    await new MobileFileSave().saveFile(
      request("../../escape/notes.md", new Uint8Array([1])),
    );

    expect(writtenFile().path).toBe("traycer-exports/notes.md");
  });

  it("falls back to a name rather than writing to the directory itself", async () => {
    const saved = await new MobileFileSave().saveFile(
      request("   ", new Uint8Array([1])),
    );

    expect(writtenFile().path).toBe("traycer-exports/traycer-export");
    expect(saved).toEqual({ name: "traycer-export", path: null });
  });

  it("never offers a re-open route, having learned no path to re-open", () => {
    expect(new MobileFileSave().openSavedFile).toBeNull();
  });
});
