import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExpandedImageDialogContent,
  type ExpandedImageState,
} from "@/components/chat/expanded-image-dialog";
import { Dialog } from "@/components/ui/dialog";
import type { SavedFile } from "@/lib/files/save-blob-to-disk";

const saveBlobToDiskMock = vi.hoisted(() =>
  vi.fn<(blob: Blob, suggestedName: string) => Promise<SavedFile | null>>(() =>
    Promise.resolve({ name: "generated.png", path: null }),
  ),
);
const copyImageMock = vi.hoisted(() =>
  vi.fn<(blob: Blob) => Promise<void>>(() => Promise.resolve()),
);

vi.mock("@/lib/files/save-blob-to-disk", () => ({
  saveBlobToDisk: (blob: Blob, suggestedName: string) =>
    saveBlobToDiskMock(blob, suggestedName),
  canOpenSavedFile: () => false,
  openSavedFile: () => Promise.resolve(),
}));

vi.mock("@/lib/images/copy-image-to-clipboard", () => ({
  copyImageBlobToClipboard: (blob: Blob) => copyImageMock(blob),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  appLogger: { errorSummary: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const TINY_PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

function renderOpenDialog(image: ExpandedImageState): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Dialog open modal={false}>
        <ExpandedImageDialogContent
          title="a misty pier"
          alt="a misty pier"
          image={image}
          suggestedName="pier.png"
          onCloseAutoFocus={undefined}
        />
      </Dialog>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  saveBlobToDiskMock.mockReset();
  saveBlobToDiskMock.mockResolvedValue({ name: "generated.png", path: null });
  copyImageMock.mockReset();
  copyImageMock.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(TINY_PNG_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<ExpandedImageDialogContent />", () => {
  it("shows Copy image and Download image for a clipboard-eligible ready image", () => {
    renderOpenDialog({
      status: "ready",
      src: "blob:http://localhost/raster",
      mediaType: "image/png",
    });

    expect(screen.getByRole("button", { name: "Copy image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download image" })).toBeTruthy();
  });

  it("routes Copy image through copyImageBlobToClipboard", async () => {
    const user = userEvent.setup();
    renderOpenDialog({
      status: "ready",
      src: "blob:http://localhost/raster",
      mediaType: "image/png",
    });

    await user.click(screen.getByRole("button", { name: "Copy image" }));

    await waitFor(() => {
      expect(copyImageMock).toHaveBeenCalledTimes(1);
    });
    const [blob] = copyImageMock.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
  });

  it("normalizes an octet-stream response to the known media type before copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(TINY_PNG_BYTES, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          }),
        ),
      ),
    );
    const user = userEvent.setup();
    renderOpenDialog({
      status: "ready",
      src: "blob:http://localhost/raster",
      mediaType: "image/png",
    });

    await user.click(screen.getByRole("button", { name: "Copy image" }));

    await waitFor(() => {
      expect(copyImageMock).toHaveBeenCalledTimes(1);
    });
    const [blob] = copyImageMock.mock.calls[0];
    expect(blob.type).toBe("image/png");
  });

  it("hides Copy image but keeps Download image for a non-clipboard media type", () => {
    renderOpenDialog({
      status: "ready",
      src: "blob:http://localhost/extended-webp",
      mediaType: "image/webp",
    });

    expect(screen.queryByRole("button", { name: "Copy image" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download image" })).toBeTruthy();
  });

  it("takes focus onto the dialog itself, not onto the Copy button", async () => {
    renderOpenDialog({
      status: "ready",
      src: "blob:http://localhost/raster",
      mediaType: "image/png",
    });

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(document.activeElement).toBe(dialog);
    });
  });

  it("shows no action buttons when the image is unavailable", () => {
    renderOpenDialog({ status: "unavailable" });

    expect(screen.getByRole("status").textContent).toContain(
      "Image unavailable",
    );
    expect(screen.queryByRole("button", { name: "Copy image" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
  });
});
