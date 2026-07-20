import { describe, expect, it } from "vitest";

import {
  classifyFileTransferDrag,
  dataTransferHasUsableClipboardData,
  type FileTransferClipboardMetadata,
  type FileTransferDragItem,
  type FileTransferDragMetadata,
} from "@/lib/files/file-transfer-paths";

function dragMetadata(
  items: ReadonlyArray<FileTransferDragItem>,
  types: ReadonlyArray<string>,
): FileTransferDragMetadata {
  return { items, types };
}

function clipboardMetadata(
  values: Readonly<Record<string, string>>,
  files: ReadonlyArray<File>,
  items: ReadonlyArray<FileTransferDragItem>,
): FileTransferClipboardMetadata {
  return {
    files,
    items,
    types: Object.keys(values),
    getData: (type) => values[type] ?? "",
  };
}

describe("classifyFileTransferDrag", () => {
  it("keeps the image variant for an all-image drag", () => {
    expect(
      classifyFileTransferDrag(
        dragMetadata(
          [
            { kind: "file", type: "image/png" },
            { kind: "file", type: "image/gif" },
          ],
          ["Files"],
        ),
      ),
    ).toBe("images");
  });

  it("uses the path variant for non-image and unknown file metadata", () => {
    expect(
      classifyFileTransferDrag(
        dragMetadata(
          [
            { kind: "file", type: "application/pdf" },
            { kind: "file", type: "" },
          ],
          ["Files"],
        ),
      ),
    ).toBe("paths");
  });

  it("uses the mixed variant when image and path files arrive together", () => {
    expect(
      classifyFileTransferDrag(
        dragMetadata(
          [
            { kind: "file", type: "image/jpeg" },
            { kind: "file", type: "text/plain" },
          ],
          ["Files"],
        ),
      ),
    ).toBe("mixed");
  });

  it("keeps URI-only candidates in the path variant while content is unreadable", () => {
    expect(classifyFileTransferDrag(dragMetadata([], ["text/uri-list"]))).toBe(
      "paths",
    );
  });
});

describe("dataTransferHasUsableClipboardData", () => {
  it.each([
    ["a real File item", {}, [new File(["a"], "notes.txt")], []],
    ["a URI list", { "text/uri-list": "file:///repo/notes.txt" }, [], []],
    [
      "a public file URL",
      { "public.file-url": "file:///repo/notes.txt" },
      [],
      [],
    ],
    ["rich text", { "text/html": "<p>notes</p>" }, [], []],
    ["plain text", { "text/plain": "notes" }, [], []],
    [
      "the Traycer composer payload",
      { "application/x-traycer-composer+json": '{"version":1}' },
      [],
      [],
    ],
  ] as const)(
    "treats %s as usable DOM clipboard data",
    (_label, values, files, items) => {
      expect(
        dataTransferHasUsableClipboardData(
          clipboardMetadata(values, files, items),
        ),
      ).toBe(true);
    },
  );

  it("allows the native fallback only for an empty DOM clipboard snapshot", () => {
    expect(
      dataTransferHasUsableClipboardData(clipboardMetadata({}, [], [])),
    ).toBe(false);
  });
});
