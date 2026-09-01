/**
 * The phone's native save leg. A WKWebView honours no browser save route, so
 * these cases are the whole difference between an export that reaches the user
 * and one that resolves successfully having written nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FileSaveRequest,
  SavedFileLocation,
} from "@traycer-clients/shared/platform/runner-host";
import { MobileFileSave, supportsDirectDownload } from "../src/file-save";

const nativeMocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  stat: vi.fn(),
  share: vi.fn(),
  getPlatform: vi.fn<() => string>(),
  getInfo: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: nativeMocks.getPlatform },
}));

vi.mock("@capacitor/device", () => ({
  Device: { getInfo: nativeMocks.getInfo },
}));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE", Documents: "DOCUMENTS" },
  Filesystem: { writeFile: nativeMocks.writeFile, stat: nativeMocks.stat },
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

function requestOfType(name: string, bytes: Uint8Array, type: string) {
  return {
    name,
    type,
    // A fresh, exactly-sized buffer: `bytes.buffer` on a subarray would carry
    // the whole backing store.
    bytes: bytes.slice().buffer,
  };
}

function request(name: string, bytes: Uint8Array) {
  return requestOfType(name, bytes, "image/png");
}

/**
 * The byte bound a single path component may occupy, as `file-save.ts`
 * enforces it. Restated here rather than exported, so a test that pushes a
 * name to the limit is pinned to the platform's rule and not to the module's.
 */
const MAX_FILE_NAME_BYTES = 255;

/**
 * A rejection shaped like the plugin's own "there is no file there": the code
 * both native shells reject with, which is the signal absence is read from.
 */
function fileNotFoundRejection(): Error {
  const error = new Error("'stat' failed because file does not exist.");
  return Object.assign(error, { code: "OS-PLUG-FILE-0008" });
}

/**
 * The direct-download route of a shell that HAS the capability, narrowed once
 * so the cases below read as calls rather than as null checks.
 */
function directDownload(): (
  request: FileSaveRequest,
) => Promise<SavedFileLocation> {
  const download = new MobileFileSave(true).downloadFile;
  if (download === null) {
    throw new Error("A capable shell must expose a direct download.");
  }
  return download;
}

/** The set of paths a stat should report as already taken. */
function occupyDocuments(paths: readonly string[]): void {
  nativeMocks.stat.mockImplementation((options: { path: string }) =>
    paths.includes(options.path)
      ? Promise.resolve({ uri: `file:///docs/${options.path}` })
      : // The plugin REJECTS a stat of a missing file rather than reporting
        // absence - "not there" only ever arrives as a failure.
        Promise.reject(fileNotFoundRejection()),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeMocks.writeFile.mockResolvedValue({
    uri: "file:///cache/traycer-exports/diagram.png",
  });
  occupyDocuments([]);
  nativeMocks.share.mockResolvedValue({
    activityType: "com.apple.DocumentsApp",
  });
  nativeMocks.getPlatform.mockReturnValue("ios");
  nativeMocks.getInfo.mockResolvedValue({ androidSDKVersion: 34 });
});

describe("supportsDirectDownload", () => {
  it("answers without asking the OS anywhere but Android", async () => {
    nativeMocks.getPlatform.mockReturnValue("ios");

    await expect(supportsDirectDownload()).resolves.toBe(true);
    // iOS writes into its own documents container, which no OS version gates,
    // so that platform must not pay a plugin round trip on the mount path.
    expect(nativeMocks.getInfo).not.toHaveBeenCalled();
  });

  it("withholds the capability on the one Android level with no route", async () => {
    // API 29 enforces scoped storage without the Documents relaxation that
    // follows it, so a direct write there could only ever fail.
    nativeMocks.getPlatform.mockReturnValue("android");
    nativeMocks.getInfo.mockResolvedValue({ androidSDKVersion: 29 });

    await expect(supportsDirectDownload()).resolves.toBe(false);
  });

  it("keeps the capability on the Android levels that do have a route", async () => {
    nativeMocks.getPlatform.mockReturnValue("android");
    for (const sdk of [26, 28, 30, 33, 36]) {
      nativeMocks.getInfo.mockResolvedValue({ androidSDKVersion: sdk });
      await expect(supportsDirectDownload()).resolves.toBe(true);
    }
  });

  it("assumes the capability when the probe fails", async () => {
    // A false negative would hide a working Download from every modern
    // Android; a false positive costs one API level a loud error beside a
    // Share that still works. The probe failing is a runtime anomaly and must
    // not take the common case down with it.
    nativeMocks.getPlatform.mockReturnValue("android");
    nativeMocks.getInfo.mockRejectedValue(new Error("plugin unavailable"));

    await expect(supportsDirectDownload()).resolves.toBe(true);
  });

  it("assumes the capability when the device names no SDK version", async () => {
    nativeMocks.getPlatform.mockReturnValue("android");
    nativeMocks.getInfo.mockResolvedValue({});

    await expect(supportsDirectDownload()).resolves.toBe(true);
  });

  it("gives up on a probe that never settles rather than blocking the mount", async () => {
    // This runs on the app's mount path: a plugin call that never resolves
    // would otherwise mean an app that never renders.
    vi.useFakeTimers();
    try {
      nativeMocks.getPlatform.mockReturnValue("android");
      nativeMocks.getInfo.mockReturnValue(new Promise(() => undefined));

      const settled = supportsDirectDownload();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(settled).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MobileFileSave capability", () => {
  it("withholds the direct download where the device has no destination", () => {
    // Absent rather than present-and-broken: a surface reads the capability
    // and simply does not offer a Download it could only ever fail.
    expect(new MobileFileSave(false).downloadFile).toBeNull();
  });

  it("still offers the share sheet without a direct download", async () => {
    const saved = await new MobileFileSave(false).saveFile(
      request("diagram.png", new Uint8Array([1])),
    );

    expect(nativeMocks.share).toHaveBeenCalledTimes(1);
    expect(saved).toEqual({ name: "diagram.png", path: null });
  });
});

describe("MobileFileSave", () => {
  it("stages the bytes in the cache container and offers that file to the share sheet", async () => {
    const saved = await new MobileFileSave(true).saveFile(
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

    await new MobileFileSave(true).saveFile(request("blob.bin", bytes));

    expect(Array.from(writtenBytes())).toEqual(Array.from(bytes));
  });

  it("encodes a payload far past the argument limit without losing a byte", async () => {
    // The exports this path exists for are megabytes; a whole-buffer spread
    // into `String.fromCharCode` throws well below that size.
    const bytes = new Uint8Array(300_000);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }

    await new MobileFileSave(true).saveFile(request("big.bin", bytes));

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
      new MobileFileSave(true).saveFile(
        request("diagram.png", new Uint8Array([1])),
      ),
    ).resolves.toBeNull();
  });

  it("propagates a real share failure so the caller can toast it", async () => {
    nativeMocks.share.mockRejectedValue(new Error("Share API not available"));

    await expect(
      new MobileFileSave(true).saveFile(
        request("diagram.png", new Uint8Array([1])),
      ),
    ).rejects.toThrow("Share API not available");
  });

  it("keeps a composed name inside the export directory", async () => {
    // Suggested names are built from user content (an image's alt text, an
    // epic title), so a separator in one must not choose a directory.
    await new MobileFileSave(true).saveFile(
      request("../../escape/notes.md", new Uint8Array([1])),
    );

    expect(stagedBaseName(0)).toBe("notes.md");
    expect(writtenFile(0).path.split("/")).not.toContain("..");
  });

  it("falls back to a name rather than writing to the directory itself", async () => {
    const saved = await new MobileFileSave(true).saveFile(
      request("   ", new Uint8Array([1])),
    );

    // The fallback stem, then the extension the blob's own type names.
    expect(stagedBaseName(0)).toBe("traycer-export.png");
    expect(saved).toEqual({ name: "traycer-export.png", path: null });
  });

  it("falls back for a padded dot, which names the staging directory itself", async () => {
    // Whitespace around the dots hides them from a strip that runs first, and
    // `.../.` is the directory rather than a file in it.
    await new MobileFileSave(true).saveFile(
      request(" . ", new Uint8Array([1])),
    );

    // The property is that it names a FILE, not the directory or its parent -
    // asserted as such, so the fallback's exact spelling stays free to move.
    expect(stagedBaseName(0)).not.toBe(".");
    expect(stagedBaseName(0)).not.toBe("..");
    expect(stagedBaseName(0).startsWith("traycer-export")).toBe(true);
  });

  it("falls back for a padded double dot, which names the parent", async () => {
    await new MobileFileSave(true).saveFile(
      request(" .. ", new Uint8Array([1])),
    );

    expect(stagedBaseName(0)).not.toBe(".");
    expect(stagedBaseName(0)).not.toBe("..");
    expect(stagedBaseName(0).startsWith("traycer-export")).toBe(true);
  });

  it("stages a repeat of the same name somewhere else, so it cannot overwrite the first", async () => {
    // The sheet resolves on dismissal, which on Android can precede the
    // receiving app finishing its read of the granted URI. Two exports sharing
    // a path would let the second replace bytes the first recipient is still
    // consuming - the same late-read fact that makes deleting unsafe.
    const host = new MobileFileSave(true);
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

    const saved = await new MobileFileSave(true).saveFile(
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

    await new MobileFileSave(true).saveFile(
      request(`${title}.png`, new Uint8Array([1])),
    );

    const staged = stagedBaseName(0);
    expect(new TextEncoder().encode(staged).length).toBeLessThanOrEqual(255);
    expect(staged.endsWith(".png")).toBe(true);
    expect(staged).not.toContain("�");
  });

  it("leaves a name that already fits exactly as it was suggested", async () => {
    await new MobileFileSave(true).saveFile(
      request("mermaid-diagram.png", new Uint8Array([1])),
    );

    expect(stagedBaseName(0)).toBe("mermaid-diagram.png");
  });

  it("gives an extensionless name one from the blob's own type", async () => {
    // `imageFileName` returns a source URL's last path segment verbatim, so an
    // attachment URL ending in an id arrives here with no extension. The sheet
    // is handed a file URI and nothing else, so the OS infers the type from
    // the path - extensionless reads as generic data, and "Save Image" is not
    // offered for it.
    const saved = await new MobileFileSave(true).saveFile(
      requestOfType("a1b2c3d4", new Uint8Array([1]), "image/png"),
    );

    expect(stagedBaseName(0)).toBe("a1b2c3d4.png");
    // The confirmation names what the user actually got.
    expect(saved).toEqual({ name: "a1b2c3d4.png", path: null });
  });

  it("leaves a name that already carries an extension alone", async () => {
    await new MobileFileSave(true).saveFile(
      requestOfType("photo.jpeg", new Uint8Array([1]), "image/png"),
    );

    // The suggestion wins over the type: renaming someone's file on the way
    // out is not this seam's call.
    expect(stagedBaseName(0)).toBe("photo.jpeg");
  });

  it("reads past a media type's parameters to reach the extension", async () => {
    // A Blob keeps the full type it was handed, so a response served as
    // `image/svg+xml; charset=utf-8` arrives with the charset attached.
    await new MobileFileSave(true).saveFile(
      requestOfType(
        "diagram",
        new Uint8Array([1]),
        "image/svg+xml; charset=utf-8",
      ),
    );

    expect(stagedBaseName(0)).toBe("diagram.svg");
  });

  it("reads a type case-insensitively, as media types are", async () => {
    await new MobileFileSave(true).saveFile(
      requestOfType("shot", new Uint8Array([1]), "IMAGE/PNG"),
    );

    expect(stagedBaseName(0)).toBe("shot.png");
  });

  it("invents no extension for a type it cannot name one for", async () => {
    await new MobileFileSave(true).saveFile(
      requestOfType("payload", new Uint8Array([1]), "application/x-unknown"),
    );

    expect(stagedBaseName(0)).toBe("payload");
  });

  it("never offers a re-open route, having learned no path to re-open", () => {
    expect(new MobileFileSave(true).openSavedFile).toBeNull();
  });
});

describe("MobileFileSave.downloadFile", () => {
  it("writes into the documents directory and offers nothing to the user", async () => {
    nativeMocks.writeFile.mockResolvedValue({
      uri: "file:///docs/Traycer/traycer-usage-30d.png",
    });

    const saved = await directDownload()(
      request("traycer-usage-30d.png", new Uint8Array([1, 2, 3])),
    );

    expect(writtenFile(0)).toMatchObject({
      path: "Traycer/traycer-usage-30d.png",
      directory: "DOCUMENTS",
      recursive: true,
    });
    // The whole difference from `saveFile`: no sheet, so nothing to dismiss
    // and no second app deciding where the bytes end up.
    expect(nativeMocks.share).not.toHaveBeenCalled();
    // The write itself says where it wrote, which the share sheet never does.
    expect(saved).toEqual({
      name: "traycer-usage-30d.png",
      path: "file:///docs/Traycer/traycer-usage-30d.png",
    });
  });

  it("hands over the exact bytes it was given", async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 200, 255]);

    await directDownload()(request("shot.png", bytes));

    expect(Array.from(writtenBytes())).toEqual(Array.from(bytes));
  });

  it("numbers a name that is already taken rather than overwriting it", async () => {
    // Two exports of the same usage window suggest the same name; replacing
    // the first would lose a file the user believes they still have.
    occupyDocuments(["Traycer/traycer-usage-30d.png"]);

    const saved = await directDownload()(
      request("traycer-usage-30d.png", new Uint8Array([1])),
    );

    expect(writtenFile(0).path).toBe("Traycer/traycer-usage-30d (2).png");
    // The confirmation names the file the user actually got, not the one that
    // was asked for.
    expect(saved.name).toBe("traycer-usage-30d (2).png");
  });

  it("keeps counting past the first free-looking number", async () => {
    occupyDocuments([
      "Traycer/usage.png",
      "Traycer/usage (2).png",
      "Traycer/usage (3).png",
    ]);

    await directDownload()(request("usage.png", new Uint8Array([1])));

    expect(writtenFile(0).path).toBe("Traycer/usage (4).png");
  });

  it("still writes something unique when every numbered name is taken", async () => {
    // The numbering is bounded so a pathological directory cannot turn one
    // download into an unbounded walk of the filesystem - but the download
    // must still land, and still not clobber anything.
    nativeMocks.stat.mockResolvedValue({ uri: "file:///docs/taken" });

    await directDownload()(request("usage.png", new Uint8Array([1])));

    const path = writtenFile(0).path;
    expect(path.startsWith("Traycer/usage")).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(path).not.toBe("Traycer/usage.png");
    expect(path).not.toBe("Traycer/usage (2).png");
  });

  it("keeps the collision suffix on a name already at the byte limit", async () => {
    // The insert is the ONLY thing making an occupied name free. Composing
    // first and bounding after truncates from the end and eats it, so every
    // numbered candidate would come back as the occupied name and the write
    // would replace the download it was meant to sit beside.
    const stem = "a".repeat(MAX_FILE_NAME_BYTES - ".png".length);
    const name = `${stem}.png`;
    expect(new TextEncoder().encode(name).length).toBe(MAX_FILE_NAME_BYTES);
    occupyDocuments([`Traycer/${name}`]);

    await directDownload()(request(name, new Uint8Array([1])));

    const written = writtenFile(0).path;
    const basename = written.split("/").at(-1) ?? "";
    expect(written).not.toBe(`Traycer/${name}`);
    expect(basename).toContain(" (2)");
    expect(basename.endsWith(".png")).toBe(true);
    expect(new TextEncoder().encode(basename).length).toBeLessThanOrEqual(
      MAX_FILE_NAME_BYTES,
    );
  });

  it("does not hand the same path to two downloads started in one tick", async () => {
    // The hard case: neither has claimed anything yet while both are awaiting
    // their stat, so the claim set alone closes no window - only serialising
    // the search does. Separate export surfaces have independent mutations, so
    // two overlapping downloads are reachable.
    const host = directDownload();

    await Promise.all([
      host(request("usage.png", new Uint8Array([1]))),
      host(request("usage.png", new Uint8Array([2]))),
    ]);

    const paths = [writtenFile(0).path, writtenFile(1).path];
    expect(new Set(paths).size).toBe(2);
    expect(paths).toContain("Traycer/usage.png");
    expect(paths).toContain("Traycer/usage (2).png");
  });

  it("keeps serving later downloads after a stat throws outright", async () => {
    // Serialising the search puts every download behind its predecessor, so a
    // predecessor that blew up must not leave the rest waiting forever.
    nativeMocks.stat.mockImplementationOnce(() => {
      throw new Error("bridge unavailable");
    });
    const host = directDownload();

    await expect(
      host(request("usage.png", new Uint8Array([1]))),
    ).resolves.toBeTruthy();
    await expect(
      host(request("later.png", new Uint8Array([1]))),
    ).resolves.toBeTruthy();
    expect(writtenFile(1).path).toBe("Traycer/later.png");
  });

  it("frees a claimed path again when its write fails", async () => {
    // A write that never landed leaves the path genuinely free; holding the
    // claim would push the user's retry onto a numbered name for nothing.
    nativeMocks.writeFile.mockRejectedValueOnce(new Error("Disk full"));
    const host = directDownload();

    await expect(
      host(request("usage.png", new Uint8Array([1]))),
    ).rejects.toThrow("Disk full");
    await host(request("usage.png", new Uint8Array([1])));

    expect(writtenFile(1).path).toBe("Traycer/usage.png");
  });

  it("takes a confirmed not-found as the name being free", async () => {
    // The ordinary case, and the one the whole probe rests on: nothing is
    // there, so the download keeps the name it asked for.
    await directDownload()(request("usage.png", new Uint8Array([1])));

    expect(writtenFile(0).path).toBe("Traycer/usage.png");
  });

  it("treats a stat that failed for any other reason as occupied", async () => {
    // The two mistakes are not equal. Reading an unknown failure as "free"
    // lets the write replace a file that was there all along - the exact loss
    // this collision handling exists to prevent - while reading it as "taken"
    // costs the download nothing but a numbered name.
    nativeMocks.stat.mockRejectedValue(new Error("I/O error"));

    await directDownload()(request("usage.png", new Uint8Array([1])));

    expect(writtenFile(0).path).not.toBe("Traycer/usage.png");
    expect(writtenFile(0).path.startsWith("Traycer/usage")).toBe(true);
  });

  it("normalises the suggested name the same way the share leg does", async () => {
    // Same seam, same rules: a separator must not choose a directory, and the
    // extension comes from the blob's own type when the name carries none.
    await directDownload()(
      requestOfType("../../escape/a1b2c3d4", new Uint8Array([1]), "image/png"),
    );

    expect(writtenFile(0).path).toBe("Traycer/a1b2c3d4.png");
  });

  it("propagates a failed write so the caller can toast it", async () => {
    // The API levels that still gate external storage reject the write; a
    // download that cannot land has to say so rather than resolve.
    nativeMocks.writeFile.mockRejectedValue(
      new Error("File permissions denied"),
    );

    await expect(
      directDownload()(request("usage.png", new Uint8Array([1]))),
    ).rejects.toThrow("File permissions denied");
  });
});
