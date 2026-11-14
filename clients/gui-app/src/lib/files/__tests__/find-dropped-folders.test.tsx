import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { findDroppedFolders } from "@/lib/files/file-transfer-paths";

afterEach(() => {
  cleanup();
});

/** A `webkitGetAsEntry()` answer: all the helper reads is a name and a kind. */
interface FakeEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

function entry(name: string, isDirectory: boolean): FakeEntry {
  return { name, isDirectory, isFile: !isDirectory };
}

interface FakeItem {
  readonly kind: string;
  readonly type: string;
  readonly getAsFile: () => File | null;
  readonly webkitGetAsEntry?: () => FakeEntry | null;
}

function fileItem(
  file: File,
  webkitGetAsEntry: (() => FakeEntry | null) | undefined,
): FakeItem {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => file,
    ...(webkitGetAsEntry === undefined ? {} : { webkitGetAsEntry }),
  };
}

/**
 * Runs the helper where the app does: inside a drop handler, on the transfer
 * React hands it, so the argument is a real `DataTransfer` and not a cast.
 */
function collectOnDrop(
  items: ReadonlyArray<FakeItem>,
  files: ReadonlyArray<File>,
): ReadonlySet<File> {
  const collected: ReadonlySet<File>[] = [];
  render(
    <div
      data-testid="zone"
      onDrop={(event) => {
        collected.push(findDroppedFolders(event.dataTransfer, files));
      }}
    />,
  );
  fireEvent.drop(screen.getByTestId("zone"), {
    dataTransfer: { files, items, types: ["Files"], getData: () => "" },
  });
  const folders = collected.at(0);
  if (folders === undefined) throw new Error("the drop handler never ran");
  return folders;
}

describe("findDroppedFolders", () => {
  it("marks the File of an item whose entry is a directory", () => {
    const folder = new File([], "my-folder", { type: "" });

    const folders = collectOnDrop(
      [fileItem(folder, () => entry("my-folder", true))],
      [folder],
    );

    expect([...folders]).toEqual([folder]);
  });

  it("leaves the File of an item whose entry is a file", () => {
    const report = new File(["x"], "report.pdf", { type: "application/pdf" });

    const folders = collectOnDrop(
      [fileItem(report, () => entry("report.pdf", false))],
      [report],
    );

    expect(folders.size).toBe(0);
  });

  it("pairs each item with its file by position, so only the folder of a mixed drop is marked", () => {
    const report = new File(["x"], "report.pdf", { type: "application/pdf" });
    const folder = new File([], "my-folder", { type: "" });
    const notes = new File(["y"], "notes.txt", { type: "text/plain" });

    const folders = collectOnDrop(
      [
        fileItem(report, () => entry("report.pdf", false)),
        fileItem(folder, () => entry("my-folder", true)),
        fileItem(notes, () => entry("notes.txt", false)),
      ],
      [report, folder, notes],
    );

    expect([...folders]).toEqual([folder]);
  });

  it("pairs only the file items, so a string item beside the folder does not shift it", () => {
    const folder = new File([], "my-folder", { type: "" });
    const textItem: FakeItem = {
      kind: "string",
      type: "text/plain",
      getAsFile: () => null,
      webkitGetAsEntry: () => null,
    };

    const folders = collectOnDrop(
      [textItem, fileItem(folder, () => entry("my-folder", true))],
      [folder],
    );

    expect([...folders]).toEqual([folder]);
  });

  it("is empty when the item has no webkitGetAsEntry at all", () => {
    const folder = new File([], "my-folder", { type: "" });

    const folders = collectOnDrop([fileItem(folder, undefined)], [folder]);

    expect(folders.size).toBe(0);
  });

  it("is empty when webkitGetAsEntry answers null", () => {
    const folder = new File([], "my-folder", { type: "" });

    const folders = collectOnDrop([fileItem(folder, () => null)], [folder]);

    expect(folders.size).toBe(0);
  });

  it("is empty when the transfer has more files than items to pair them with", () => {
    const folder = new File([], "my-folder", { type: "" });
    const report = new File(["x"], "report.pdf", { type: "application/pdf" });

    const folders = collectOnDrop(
      [fileItem(folder, () => entry("my-folder", true))],
      [folder, report],
    );

    expect(folders.size).toBe(0);
  });

  it("is empty when the transfer has more items than collected files", () => {
    const folder = new File([], "my-folder", { type: "" });
    const report = new File(["x"], "report.pdf", { type: "application/pdf" });

    const folders = collectOnDrop(
      [
        fileItem(folder, () => entry("my-folder", true)),
        fileItem(report, () => entry("report.pdf", false)),
      ],
      [folder],
    );

    expect(folders.size).toBe(0);
  });

  it("does not mark a directory entry whose name is not its file's", () => {
    const report = new File(["x"], "report.pdf", { type: "application/pdf" });

    const folders = collectOnDrop(
      [fileItem(report, () => entry("some-other-folder", true))],
      [report],
    );

    expect(folders.size).toBe(0);
  });
});
