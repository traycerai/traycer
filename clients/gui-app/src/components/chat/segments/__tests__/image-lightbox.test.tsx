import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "@/components/chat/segments/image-lightbox";
import { UntrustedSvgLightbox } from "@/components/chat/segments/untrusted-svg-lightbox";
import { sanitizeUntrustedSvg } from "@/lib/images/untrusted-svg";

const saveBlobToDiskMock = vi.hoisted(() =>
  vi.fn<(blob: Blob, suggestedName: string) => Promise<string | null>>(() =>
    Promise.resolve("generated.png"),
  ),
);
const copyImageMock = vi.hoisted(() =>
  vi.fn<(blob: Blob) => Promise<void>>(() => Promise.resolve()),
);
const trustedMarkupSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/files/save-blob-to-disk", () => ({
  saveBlobToDisk: (blob: Blob, suggestedName: string) =>
    saveBlobToDiskMock(blob, suggestedName),
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

vi.mock("@/lib/trusted-markup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/trusted-markup")>(
    "@/lib/trusted-markup",
  );
  return {
    ...actual,
    trustedMarkupToReactNodes: (
      ...args: Parameters<typeof actual.trustedMarkupToReactNodes>
    ) => {
      trustedMarkupSpy(...args);
      return actual.trustedMarkupToReactNodes(...args);
    },
  };
});

const TINY_PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

const SAFE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#0af"/></svg>`;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

beforeEach(() => {
  saveBlobToDiskMock.mockReset();
  saveBlobToDiskMock.mockResolvedValue("generated.png");
  copyImageMock.mockReset();
  copyImageMock.mockResolvedValue(undefined);
  trustedMarkupSpy.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("svg") || url.endsWith(".svg")) {
        return Promise.resolve(
          new Response(SAFE_SVG, {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
        );
      }
      return Promise.resolve(
        new Response(TINY_PNG_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<ImageLightbox /> actions", () => {
  it("downloads through saveBlobToDisk with the suggested file name", async () => {
    render(
      <ImageLightbox
        src="blob:http://localhost/raster"
        alt="a misty pier"
        mediaType="image/png"
        suggestedName="pier.png"
        className={undefined}
      >
        <img src="blob:http://localhost/raster" alt="a misty pier" />
      </ImageLightbox>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download image" }));

    await waitFor(() => {
      expect(saveBlobToDiskMock).toHaveBeenCalledTimes(1);
    });
    const [blob, name] = saveBlobToDiskMock.mock.calls[0];
    expect(name).toBe("pier.png");
    // jsdom may not share Blob identity across realms; assert blob-shaped.
    expect(blob.size).toBeGreaterThan(0);
    expect(typeof blob.arrayBuffer).toBe("function");
  });

  it("copies through copyImageBlobToClipboard (ClipboardItem path lives there)", async () => {
    render(
      <ImageLightbox
        src="blob:http://localhost/raster"
        alt="copy me"
        mediaType="image/png"
        suggestedName={null}
        className={undefined}
      >
        <img src="blob:http://localhost/raster" alt="copy me" />
      </ImageLightbox>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));

    await waitFor(() => {
      expect(copyImageMock).toHaveBeenCalledTimes(1);
    });
    const [blob] = copyImageMock.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
    expect(typeof blob.arrayBuffer).toBe("function");
  });

  it("opens a dialog with the raster image on trigger click", async () => {
    render(
      <ImageLightbox
        src="blob:http://localhost/raster-open"
        alt="open me"
        mediaType="image/png"
        suggestedName={null}
        className={undefined}
      >
        <img src="blob:http://localhost/raster-open" alt="thumb" />
      </ImageLightbox>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open open me" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(
      dialog.querySelector('img[src="blob:http://localhost/raster-open"]'),
    ).not.toBeNull();
  });

  it("routes svg mediaType into the sanitized SVG lightbox path, not a raw dialog img", async () => {
    render(
      <ImageLightbox
        src="blob:http://localhost/safe.svg"
        alt="safe svg"
        mediaType="image/svg+xml"
        suggestedName="safe.svg"
        className={undefined}
      >
        <img src="blob:http://localhost/safe.svg" alt="safe svg thumb" />
      </ImageLightbox>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open safe svg" }));
    const dialog = await screen.findByRole("dialog");

    // mediaType === "image/svg+xml" mounts the lazy SVG viewer shell (not the
    // plain dialog <img> branch used for raster).
    await waitFor(() => {
      expect(
        dialog.querySelector('img[src="blob:http://localhost/safe.svg"]'),
      ).toBeNull();
    });
    // While the lazy chunk resolves we may still be in Suspense pulse; the key
    // pin is "not the raster img branch".
    expect(dialog.innerHTML).not.toContain(
      'src="blob:http://localhost/safe.svg"',
    );
  });
});

describe("<UntrustedSvgLightbox /> sanitized routing", () => {
  it("fetches, sanitizes, and renders via source=sanitized without trustedMarkupToReactNodes", async () => {
    // Prove the contract: provider/disk SVG never goes through trusted markup.
    const sanitized = sanitizeUntrustedSvg(SAFE_SVG);
    expect(sanitized.toLowerCase()).toContain("<svg");

    render(
      <UntrustedSvgLightbox
        src="blob:http://localhost/safe.svg"
        alt="safe svg"
      />,
    );

    expect(screen.getByLabelText("Loading SVG")).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByLabelText("Loading SVG")).toBeNull();
    });

    expect(trustedMarkupSpy).not.toHaveBeenCalled();
    // PanZoomSvgViewer mounts with source="sanitized" → DOMParser import path.
    expect(screen.getByLabelText("safe svg")).toBeTruthy();
    expect(document.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("toolbar", { name: "Diagram view controls" }),
    ).toBeTruthy();
  });

  it("surfaces a safe failure when the SVG cannot be sanitized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("<!DOCTYPE svg><svg></svg>", { status: 200 }),
        ),
      ),
    );

    render(
      <UntrustedSvgLightbox
        src="blob:http://localhost/bad.svg"
        alt="bad svg"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("SVG could not be displayed safely"),
      ).toBeTruthy();
    });
    expect(trustedMarkupSpy).not.toHaveBeenCalled();
  });
});
