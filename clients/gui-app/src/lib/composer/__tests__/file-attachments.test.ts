import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { composerAttachmentsHoldSend } from "@/hooks/composer/use-composer-paste";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import {
  containsFileAttachments,
  containsPendingFileAttachment,
  countFileAttachments,
  fileAttachmentAttrsOf,
  fileAttachmentFamily,
} from "@/lib/composer/file-attachments";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";

const IDLE = {
  isIngestingImages: false,
  isResolvingFilePaths: false,
  isAttachingFiles: false,
};

function fileDoc(uploadState: "pending" | null): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "fileAttachment",
            attrs: {
              id: "node-1",
              hash: "d".repeat(64),
              fileName: "a.zip",
              mediaType: "application/zip",
              size: "12",
              uploadState,
            },
          },
        ],
      },
    ],
  };
}

describe("a draft holding a file", () => {
  it("is held from sending while the file is pending, and released once confirmed", () => {
    const pending = fileDoc("pending");
    const stored = fileDoc(null);

    expect(
      composerAttachmentsHoldSend(IDLE, containsPendingFileAttachment(pending)),
    ).toBe(true);
    expect(
      composerAttachmentsHoldSend(IDLE, containsPendingFileAttachment(stored)),
    ).toBe(false);
  });

  it("is submittable and not a blank Start Page, with no text at all", () => {
    for (const doc of [fileDoc("pending"), fileDoc(null)]) {
      expect(containsFileAttachments(doc)).toBe(true);
      expect(contentIsSubmittable(doc)).toBe(true);
      expect(isEmptyLandingDraftContent(doc)).toBe(false);
    }
    const blank: JsonContent = {
      type: "doc",
      content: [{ type: "paragraph" }],
    };
    expect(contentIsSubmittable(blank)).toBe(false);
    expect(isEmptyLandingDraftContent(blank)).toBe(true);
  });
});

describe("fileAttachmentAttrsOf", () => {
  it("reads a clipboard-round-tripped size string and drops the composer-only state", () => {
    const attrs = fileDoc("pending").content?.[0].content?.[0].attrs;
    expect(fileAttachmentAttrsOf(attrs)).toEqual({
      id: "node-1",
      hash: "d".repeat(64),
      fileName: "a.zip",
      mediaType: "application/zip",
      size: 12,
    });
  });

  it("is null for attrs that do not parse", () => {
    expect(fileAttachmentAttrsOf({ id: "x", hash: "short" })).toBeNull();
    expect(fileAttachmentAttrsOf(undefined)).toBeNull();
  });
});

describe("fileAttachmentFamily", () => {
  it.each([
    ["video/mp4", "a.bin", "video"],
    ["audio/mpeg", "a.bin", "audio"],
    ["application/pdf", "a.bin", "pdf"],
    ["application/octet-stream", "Report.PDF", "pdf"],
    ["application/zip", "a.bin", "archive"],
    ["application/octet-stream", "a.tar", "archive"],
    ["text/plain", "a.txt", "other"],
    ["", "noextension", "other"],
  ])("%s %s is %s", (mediaType, fileName, family) => {
    expect(fileAttachmentFamily(mediaType, fileName)).toBe(family);
  });
});

describe("countFileAttachments", () => {
  function node(hash: string, fileName: string): JsonContent {
    return {
      type: "fileAttachment",
      attrs: { id: `${hash}-${fileName}`, hash, fileName },
    };
  }
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  it.each([
    ["the same hash and name twice", [node(A, "x.txt"), node(A, "x.txt")], 1],
    ["the same hash under two names", [node(A, "x.txt"), node(A, "y.txt")], 2],
    ["two hashes under one name", [node(A, "x.txt"), node(B, "x.txt")], 2],
    [
      "images beside a file",
      [
        {
          type: "imageAttachment",
          attrs: { id: "i", hash: A, fileName: "x.txt" },
        },
        node(A, "x.txt"),
      ],
      1,
    ],
  ])("%s", (_label, nodes, expected) => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: nodes },
        { type: "paragraph", content: nodes },
      ],
    };
    expect(countFileAttachments(doc)).toBe(expected);
  });
});
