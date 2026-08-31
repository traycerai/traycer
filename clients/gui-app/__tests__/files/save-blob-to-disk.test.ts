import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileSaveRequest,
  SavedFileLocation,
} from "@traycer-clients/shared/platform/runner-host";
import {
  downloadBlobToDevice,
  hasSeparateDownloadRoute,
  saveBlobToDisk,
} from "@/lib/files/save-blob-to-disk";

const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

function restoreUrlMethod(
  name: "createObjectURL" | "revokeObjectURL",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    return;
  }
  Object.defineProperty(URL, name, descriptor);
}

afterEach(() => {
  window.showSaveFilePicker = undefined;
  restoreUrlMethod("createObjectURL", createObjectUrlDescriptor);
  restoreUrlMethod("revokeObjectURL", revokeObjectUrlDescriptor);
  vi.restoreAllMocks();
});

describe("saveBlobToDisk", () => {
  it("treats save picker cancellation as a no-op", async () => {
    const createObjectURL = vi.fn(() => "blob:mermaid");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    window.showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));

    await expect(
      saveBlobToDisk(
        new Blob(["png"], { type: "image/png" }),
        "diagram.png",
        null,
      ),
    ).resolves.toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to the anchor download after a save picker write failure", async () => {
    const writable = {
      write: vi.fn().mockRejectedValue(new Error("write failed")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const createWritable = vi.fn().mockResolvedValue(writable);
    const createObjectURL = vi.fn(() => "blob:mermaid");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: revokeObjectURL,
    });
    window.showSaveFilePicker = vi.fn().mockResolvedValue({
      name: "diagram.png",
      createWritable,
    });

    // A recoverable (non-cancel) write failure must not lose the file: the
    // browser falls through to the <a download> anchor and still saves it.
    await expect(
      saveBlobToDisk(
        new Blob(["png"], { type: "image/png" }),
        "diagram.png",
        null,
      ),
    ).resolves.toEqual({ name: "diagram.png", path: null });
    expect(createWritable).toHaveBeenCalledTimes(1);
    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("uses the shell's native save host before browser save APIs", async () => {
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve({ name: "diagram.png", path: "/tmp/diagram.png" }));
    const createObjectURL = vi.fn(() => "blob:mermaid");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    window.showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException("not allowed", "NotAllowedError"));

    const blob = new Blob(["png"], { type: "image/png" });
    await expect(
      saveBlobToDisk(blob, "diagram.png", {
        saveFile,
        openSavedFile: () => Promise.resolve(),
        downloadFile: null,
      }),
    ).resolves.toEqual({
      name: "diagram.png",
      path: "/tmp/diagram.png",
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith({
      name: "diagram.png",
      type: "image/png",
      bytes: await blob.arrayBuffer(),
    });
    expect(window.showSaveFilePicker).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("downloadBlobToDevice", () => {
  it("takes the shell's chooser-free route when it has one", async () => {
    // The whole point of the second route: a shell whose `saveFile` reaches a
    // share sheet must not send a "Download" through it.
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve(null));
    const downloadFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation>
    >(() =>
      Promise.resolve({
        name: "usage.png",
        path: "file:///docs/Traycer/usage.png",
      }),
    );

    const blob = new Blob(["png"], { type: "image/png" });
    await expect(
      downloadBlobToDevice(blob, "usage.png", {
        saveFile,
        openSavedFile: null,
        downloadFile,
      }),
    ).resolves.toEqual({
      name: "usage.png",
      path: "file:///docs/Traycer/usage.png",
    });
    expect(downloadFile).toHaveBeenCalledWith({
      name: "usage.png",
      type: "image/png",
      bytes: await blob.arrayBuffer(),
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("falls back to the shell's own save route where there is no separate one", async () => {
    // A desktop save dialog IS the download - routing around it would open a
    // second, worse one.
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve({ name: "usage.png", path: "/tmp/usage.png" }));

    await expect(
      downloadBlobToDevice(
        new Blob(["png"], { type: "image/png" }),
        "usage.png",
        { saveFile, openSavedFile: null, downloadFile: null },
      ),
    ).resolves.toEqual({ name: "usage.png", path: "/tmp/usage.png" });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to the browser save APIs with no shell at all", async () => {
    const createObjectURL = vi.fn(() => "blob:usage");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    await expect(
      downloadBlobToDevice(
        new Blob(["png"], { type: "image/png" }),
        "usage.png",
        null,
      ),
    ).resolves.toEqual({ name: "usage.png", path: null });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe("hasSeparateDownloadRoute", () => {
  it("is false for no shell and for a shell whose save route is the download", () => {
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve(null));
    expect(hasSeparateDownloadRoute(null)).toBe(false);
    expect(
      hasSeparateDownloadRoute({
        saveFile,
        openSavedFile: null,
        downloadFile: null,
      }),
    ).toBe(false);
  });

  it("is true exactly where the shell owns a chooser-free download", () => {
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve(null));
    expect(
      hasSeparateDownloadRoute({
        saveFile,
        openSavedFile: null,
        downloadFile: () => Promise.resolve({ name: "u.png", path: null }),
      }),
    ).toBe(true);
  });
});
