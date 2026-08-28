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

/** The nth `writeFile` payload, as the plugin received it. */
function writtenFile(index: number): {
  path: string;
  data: string;
  directory: string;
  recursive: boolean;
} {
  const call = nativeMocks.writeFile.mock.calls[index];
  if (call === undefined) throw new Error("Nothing was written.");
  return call[0] as {
    path: string;
    data: string;
    directory: string;
    recursive: boolean;
  };
}

/** The file name the OS would show, i.e. the last segment of a staged path. */
function stagedBaseName(index: number): string {
  return writtenFile(index).path.split("/").at(-1) ?? "";
}

/** The directory a request staged into, everything above its basename. */
function stagingDirectory(index: number): string {
  const segments = writtenFile(index).path.split("/");
  return segments.slice(0, -1).join("/");
}

/** The bytes the plugin was handed, decoded back out of its base64 payload. */
function writtenBytes(): Uint8Array {
  const binary = atob(writtenFile(0).data);
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

    expect(writtenFile(0)).toMatchObject({
      directory: "CACHE",
      recursive: true,
    });
    // The name the OS shows is the suggested one, staged somewhere under the
    // export root - the directory in between is this module's business.
    expect(stagedBaseName(0)).toBe("diagram.png");
    expect(stagingDirectory(0).startsWith("traycer-exports/")).toBe(true);
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

    expect(stagedBaseName(0)).toBe("notes.md");
    expect(writtenFile(0).path.split("/")).not.toContain("..");
  });

  it("falls back to a name rather than writing to the directory itself", async () => {
    const saved = await new MobileFileSave().saveFile(
      request("   ", new Uint8Array([1])),
    );

    expect(stagedBaseName(0)).toBe("traycer-export");
    expect(saved).toEqual({ name: "traycer-export", path: null });
  });

  it("stages a repeat of the same name somewhere else, so it cannot overwrite the first", async () => {
    // The sheet resolves on dismissal, which on Android can precede the
    // receiving app finishing its read of the granted URI. Two exports sharing
    // a path would let the second replace bytes the first recipient is still
    // consuming - the same late-read fact that makes deleting unsafe.
    const host = new MobileFileSave();
    await host.saveFile(request("mermaid-diagram.png", new Uint8Array([1])));
    await host.saveFile(request("mermaid-diagram.png", new Uint8Array([2])));

    expect(stagedBaseName(0)).toBe("mermaid-diagram.png");
    expect(stagedBaseName(1)).toBe("mermaid-diagram.png");
    expect(stagingDirectory(1)).not.toBe(stagingDirectory(0));
  });

  it("bounds a staged name by encoded bytes, not characters, keeping its extension", async () => {
    // Callers bound their suggestions by CODE POINT - artifact export allows
    // 120 - which says nothing about bytes. 120 CJK characters is 360 bytes,
    // past the component limit, and the write would reject before the sheet
    // was ever reached.
    const title = "経過報告".repeat(30);
    expect(title.length).toBe(120);

    const saved = await new MobileFileSave().saveFile(
      request(`${title}.md`, new Uint8Array([1])),
    );

    const staged = stagedBaseName(0);
    expect(new TextEncoder().encode(staged).length).toBeLessThanOrEqual(255);
    // The extension survives: it is what the receiving app dispatches on.
    expect(staged.endsWith(".md")).toBe(true);
    // A prefix of the real title, cut on a character boundary - no severed
    // multi-byte character, and nothing invented to pad it out.
    expect(title.startsWith(staged.slice(0, -".md".length))).toBe(true);
    expect(staged).not.toContain("�");
    expect(saved).toEqual({ name: staged, path: null });
  });

  it("bounds a name whose characters are wider still", async () => {
    // Four bytes each: the same 120-code-point allowance is 480 bytes here.
    const title = "🌊".repeat(120);

    await new MobileFileSave().saveFile(
      request(`${title}.png`, new Uint8Array([1])),
    );

    const staged = stagedBaseName(0);
    expect(new TextEncoder().encode(staged).length).toBeLessThanOrEqual(255);
    expect(staged.endsWith(".png")).toBe(true);
    expect(staged).not.toContain("�");
  });

  it("leaves a name that already fits exactly as it was suggested", async () => {
    await new MobileFileSave().saveFile(
      request("mermaid-diagram.png", new Uint8Array([1])),
    );

    expect(stagedBaseName(0)).toBe("mermaid-diagram.png");
  });

  it("never offers a re-open route, having learned no path to re-open", () => {
    expect(new MobileFileSave().openSavedFile).toBeNull();
  });
});
