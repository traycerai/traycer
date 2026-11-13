import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserMessageAttachmentGallery } from "@/components/chat/user-message-attachment-gallery";
import { useChatAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";

vi.mock(
  "@/lib/attachments/use-attachment-blob-src",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attachments/use-attachment-blob-src")
    >()),
    useChatAttachmentBlobSrc: vi.fn(),
  }),
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const IMAGE_HASHES = ["hash-a", "hash-b", "hash-c"];

function srcForHash(hash: string): string {
  return `data:image/png;base64,${hash}`;
}

function threeImageAttachments() {
  return IMAGE_HASHES.map((hash) => ({
    kind: "image" as const,
    hash,
    mediaType: "image/png",
    dataUrl: null,
    name: `${hash}.png`,
    size: 128,
  }));
}

function renderGallery(ui: ReactElement): void {
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

function shownImageSrc(): string | null {
  return within(screen.getByRole("dialog"))
    .getByRole("img")
    .getAttribute("src");
}

describe("UserMessageAttachmentGallery", () => {
  it("steps through the images attached together and returns focus to the last one shown", async () => {
    vi.mocked(useChatAttachmentBlobSrc).mockImplementation((hash) => ({
      status: "ready",
      src: srcForHash(hash ?? ""),
      mediaType: "image/png",
    }));
    renderGallery(
      <UserMessageAttachmentGallery
        align="end"
        browserAnnotations={undefined}
        attachments={threeImageAttachments()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Open Image#2/ }));

    expect(
      await screen.findByRole("status", { name: "Image 2 of 3" }),
    ).toBeTruthy();
    expect(shownImageSrc()).toBe(srcForHash("hash-b"));

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));

    expect(screen.getByRole("status", { name: "Image 3 of 3" })).toBeTruthy();
    expect(shownImageSrc()).toBe(srcForHash("hash-c"));
    expect(
      screen
        .getByRole("button", { name: "Next image" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });

    expect(screen.getByRole("status", { name: "Image 2 of 3" })).toBeTruthy();
    expect(shownImageSrc()).toBe(srcForHash("hash-b"));

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^Open Image#3/ }),
      );
    });
  });

  it("draws no navigation for a single image", async () => {
    vi.mocked(useChatAttachmentBlobSrc).mockReturnValue({
      status: "ready",
      src: srcForHash("hash-a"),
      mediaType: "image/png",
    });
    renderGallery(
      <UserMessageAttachmentGallery
        align="end"
        browserAnnotations={undefined}
        attachments={threeImageAttachments().slice(0, 1)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Open Image#1/ }));

    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Previous image" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(screen.queryByRole("status", { name: /^Image \d+ of/ })).toBeNull();
  });

  it("surfaces an unavailable image in both the thumbnail and dialog", async () => {
    vi.mocked(useChatAttachmentBlobSrc).mockReturnValue({
      status: "unavailable",
      src: null,
    });

    const { container } = render(
      <UserMessageAttachmentGallery
        align="end"
        browserAnnotations={undefined}
        attachments={[
          {
            kind: "image",
            hash: "missing-hash",
            mediaType: "image/png",
            dataUrl: null,
            name: "missing.png",
            size: 128,
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open Image#1: missing.png (image unavailable)",
    });
    expect(
      trigger.querySelector("[data-user-message-image-unavailable]"),
    ).not.toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();

    fireEvent.click(trigger);

    expect(await screen.findByText("Image unavailable")).not.toBeNull();
  });
});
