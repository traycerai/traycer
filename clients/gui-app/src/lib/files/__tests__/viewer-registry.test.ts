import { describe, expect, it } from "vitest";

import {
  familyAcceptsDirectUrl,
  mediaTypeFamily,
  type ViewerFamily,
} from "@/lib/files/media-type-family";
import {
  resolveViewer,
  VIEWER_REGISTRY,
  type FileViewerEntry,
} from "@/lib/files/viewer-registry";
import type { FileByteSourceKind } from "@/lib/files/byte-source";

const ALL_SOURCE_KINDS: readonly FileByteSourceKind[] = [
  "workspace-path",
  "git-object",
  "chat-attachment",
  "epic-file",
];

const REPRESENTATIVE_MEDIA_TYPES: ReadonlyArray<{
  readonly mediaType: string;
  readonly family: ViewerFamily;
}> = [
  { mediaType: "image/png", family: "image" },
  { mediaType: "image/svg+xml", family: "image" },
  { mediaType: "video/mp4", family: "video" },
  { mediaType: "application/pdf", family: "pdf" },
  { mediaType: "text/plain", family: "text" },
  { mediaType: "text/markdown", family: "text" },
  { mediaType: "application/json", family: "text" },
  { mediaType: "text/html", family: "html" },
  { mediaType: "application/octet-stream", family: "binary" },
];

describe("mediaTypeFamily / VIEWER_REGISTRY resolution table", () => {
  it.each(REPRESENTATIVE_MEDIA_TYPES)(
    "resolves $mediaType to family $family and its registered entry",
    ({ mediaType, family }) => {
      expect(mediaTypeFamily(mediaType)).toBe(family);
      const entry = resolveViewer(mediaType, "workspace-path");
      expect(entry.family).toBe(family);
      expect(entry.component).toBe(VIEWER_REGISTRY[family].component);
    },
  );

  it("strips parameters and normalizes case before matching", () => {
    expect(mediaTypeFamily("text/html; charset=utf-8")).toBe("html");
    expect(mediaTypeFamily("IMAGE/PNG")).toBe("image");
    expect(mediaTypeFamily("text/html")).toBe(
      mediaTypeFamily("text/html; charset=utf-8"),
    );
    expect(mediaTypeFamily("image/png")).toBe(mediaTypeFamily("IMAGE/PNG"));
  });

  it.each(["", "nonsense", "application/vnd.acme.thing"])(
    "falls back to binary for unknown/garbage media type %j without throwing",
    (mediaType) => {
      expect(() => mediaTypeFamily(mediaType)).not.toThrow();
      expect(mediaTypeFamily(mediaType)).toBe("binary");
    },
  );

  it("resolves text/html to html, not text (precedence)", () => {
    expect(mediaTypeFamily("text/html")).toBe("html");
    expect(mediaTypeFamily("text/html")).not.toBe("text");
  });
});

describe("familyAcceptsDirectUrl", () => {
  it("is true only for image and video", () => {
    const families: readonly ViewerFamily[] = [
      "image",
      "video",
      "pdf",
      "text",
      "html",
      "binary",
    ];
    for (const family of families) {
      expect(familyAcceptsDirectUrl(family)).toBe(
        family === "image" || family === "video",
      );
    }
  });

  it("agrees with every registry entry's capabilities.acceptsDirectUrl", () => {
    for (const family of Object.keys(VIEWER_REGISTRY) as ViewerFamily[]) {
      const entry: FileViewerEntry = VIEWER_REGISTRY[family];
      expect(entry.capabilities.acceptsDirectUrl).toBe(
        familyAcceptsDirectUrl(family),
      );
    }
  });
});

describe("resolveViewer opensInBrowser", () => {
  it("is true only for text/html resolved against an epic-file source", () => {
    expect(
      resolveViewer("text/html", "epic-file").capabilities.opensInBrowser,
    ).toBe(true);
  });

  it("is false for every non-epic-file source kind on html", () => {
    for (const sourceKind of ALL_SOURCE_KINDS) {
      if (sourceKind === "epic-file") continue;
      expect(
        resolveViewer("text/html", sourceKind).capabilities.opensInBrowser,
      ).toBe(false);
    }
  });

  it("is false for every non-html family, regardless of source kind", () => {
    const nonHtmlMediaTypes: ReadonlyArray<string> = [
      "image/png",
      "video/mp4",
      "application/pdf",
      "text/plain",
      "application/octet-stream",
    ];
    for (const sourceKind of ALL_SOURCE_KINDS) {
      for (const mediaType of nonHtmlMediaTypes) {
        expect(
          resolveViewer(mediaType, sourceKind).capabilities.opensInBrowser,
        ).toBe(false);
      }
    }
  });
});
