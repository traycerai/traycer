import { afterEach, describe, expect, it, vi } from "vitest";

const { captureBrowserTabPreview } = vi.hoisted(() => ({
  captureBrowserTabPreview: vi.fn(),
}));

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  captureBrowserTabPreview,
}));

import type { BrowserTabMentionEntry } from "@/lib/composer/types";
import {
  browserTabPreviewText,
  fetchBrowserTabPreviewImage,
} from "../browser-tab-preview";

function previewEntry(
  fields: Partial<BrowserTabMentionEntry>,
): BrowserTabMentionEntry {
  return {
    kind: "browser-tab",
    id: "browser-tab:tab-1",
    tabId: "tab-1",
    sessionId: "session-1",
    label: "Example",
    url: "https://example.com",
    hostId: "host-1",
    hostLabel: "Canvas Host",
    coordinatorKey: "coord-1",
    contextOnly: true,
    coLocated: false,
    lastActivityAt: 0,
    dormant: false,
    ...fields,
  };
}

afterEach(() => {
  captureBrowserTabPreview.mockReset();
});

describe("browserTabPreviewText", () => {
  it("names the host so a same-named tab on another host is not ambiguous", () => {
    const text = browserTabPreviewText(
      previewEntry({
        hostLabel: "Canvas Host",
        label: "Example",
        url: "https://example.com",
      }),
    );
    expect(text).toBe(
      "browser tab on Canvas Host: Example - https://example.com",
    );
  });
});

describe("fetchBrowserTabPreviewImage", () => {
  it("returns an image attachment from an ok preview", async () => {
    captureBrowserTabPreview.mockResolvedValue({
      ok: true,
      screenshotBase64: "base64-bytes",
      url: "https://example.com",
      title: "Example",
      reason: null,
    });

    const image = await fetchBrowserTabPreviewImage(
      previewEntry({ coordinatorKey: "coord-1", tabId: "tab-1" }),
    );

    expect(captureBrowserTabPreview).toHaveBeenCalledWith("coord-1", "tab-1");
    expect(image).not.toBeNull();
    expect(image?.mimeType).toBe("image/jpeg");
    expect(image?.b64content).toBe("base64-bytes");
    expect(image?.size).toBeNull();
  });

  it("returns null for a dormant tab (ok: false)", async () => {
    captureBrowserTabPreview.mockResolvedValue({
      ok: false,
      screenshotBase64: null,
      url: null,
      title: null,
      reason: "dormant",
    });

    const image = await fetchBrowserTabPreviewImage(previewEntry({}));

    expect(image).toBeNull();
  });

  it("returns null when the capture request rejects", async () => {
    captureBrowserTabPreview.mockRejectedValue(
      new Error("Browser sessions stream is not ready."),
    );

    const image = await fetchBrowserTabPreviewImage(previewEntry({}));

    expect(image).toBeNull();
  });
});
