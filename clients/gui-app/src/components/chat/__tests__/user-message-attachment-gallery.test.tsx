import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

describe("UserMessageAttachmentGallery", () => {
  it("surfaces an unavailable image in both the thumbnail and dialog", async () => {
    vi.mocked(useChatAttachmentBlobSrc).mockReturnValue({
      status: "unavailable",
      src: null,
    });

    const { container } = renderWithQueryClient(
      <UserMessageAttachmentGallery
        align="end"
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
