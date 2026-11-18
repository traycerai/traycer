/**
 * What `saveBlobToDisk` / `downloadBlobToDevice` hand a native shell about the
 * source's lifetime: a local `stillWanted` the shell asks at each boundary, a
 * retirement reported as the retirement itself, and no dispatch at all once the
 * source retired while the bytes were being read.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  FileSaveRequest,
  IFileSaveHost,
  SavedFileLocation,
} from "@traycer-clients/shared/platform/runner-host";
import {
  downloadBlobToDevice,
  saveBlobToDisk,
} from "@/lib/files/save-blob-to-disk";

const SAVED: SavedFileLocation = { name: "roadmap.zip", path: null };

function retirementOf(state: { retired: boolean }): () => void {
  return () => {
    if (state.retired)
      throw new DOMException("The source retired", "AbortError");
  };
}

function shell(
  saveFile: IFileSaveHost["saveFile"],
  downloadFile: IFileSaveHost["downloadFile"],
): IFileSaveHost {
  return {
    saveFile,
    saveRoute: "download",
    openSavedFile: null,
    downloadFile,
    downloadUrl: null,
  };
}

const BLOB = new Blob(["zip"], { type: "application/zip" });

describe("saveBlobToDisk on a native shell", () => {
  it("hands the shell a local stillWanted that turns false when the source retires", async () => {
    const state = { retired: false };
    const asked: boolean[] = [];
    const saveFile = vi.fn<IFileSaveHost["saveFile"]>(
      (request: FileSaveRequest) => {
        const wanted = request.stillWanted;
        if (wanted === null) throw new Error("no stillWanted was handed over");
        asked.push(wanted());
        state.retired = true;
        asked.push(wanted());
        return Promise.resolve(SAVED);
      },
    );

    await saveBlobToDisk(
      BLOB,
      "roadmap.zip",
      shell(saveFile, null),
      retirementOf(state),
    );

    expect(asked).toEqual([true, false]);
  });

  it("hands none when the source has no lifetime", async () => {
    const saveFile = vi.fn<IFileSaveHost["saveFile"]>(() =>
      Promise.resolve(SAVED),
    );

    await saveBlobToDisk(BLOB, "roadmap.zip", shell(saveFile, null), null);

    expect(saveFile.mock.calls[0]?.[0].stillWanted).toBeNull();
  });

  it("reports the retirement itself when the shell answers a retired source as a dismissal", async () => {
    const state = { retired: false };
    const saveFile = vi.fn<IFileSaveHost["saveFile"]>(() => {
      state.retired = true;
      return Promise.resolve(null);
    });

    await expect(
      saveBlobToDisk(
        BLOB,
        "roadmap.zip",
        shell(saveFile, null),
        retirementOf(state),
      ),
    ).rejects.toThrow("The source retired");
  });
});

describe("downloadBlobToDevice on a shell with a direct write", () => {
  it("dispatches nothing when the source retired while the bytes were read", async () => {
    const state = { retired: false };
    const downloadFile = vi.fn<NonNullable<IFileSaveHost["downloadFile"]>>(() =>
      Promise.resolve(SAVED),
    );
    const gate = Promise.withResolvers<ArrayBuffer>();
    const arrayBufferSpy = vi
      .spyOn(Blob.prototype, "arrayBuffer")
      .mockReturnValue(gate.promise);
    try {
      const pending = downloadBlobToDevice(
        BLOB,
        "roadmap.zip",
        shell(vi.fn(), downloadFile),
        retirementOf(state),
      );
      await vi.waitFor(() => expect(arrayBufferSpy).toHaveBeenCalled());

      state.retired = true;
      gate.resolve(new ArrayBuffer(1));

      await expect(pending).rejects.toThrow("The source retired");
      expect(downloadFile).not.toHaveBeenCalled();
    } finally {
      arrayBufferSpy.mockRestore();
    }
  });
});
