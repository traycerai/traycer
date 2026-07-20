import { describe, expect, it } from "vitest";

import {
  classifyFileTransferDrag,
  type FileTransferDragItem,
  type FileTransferDragMetadata,
} from "@/lib/files/file-transfer-paths";

function dragMetadata(
  items: ReadonlyArray<FileTransferDragItem>,
  types: ReadonlyArray<string>,
): FileTransferDragMetadata {
  return { items, types };
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
