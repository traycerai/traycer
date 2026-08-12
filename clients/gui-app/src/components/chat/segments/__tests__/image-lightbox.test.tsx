import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "@/components/chat/segments/image-lightbox";
import { UntrustedSvgLightbox } from "@/components/chat/segments/untrusted-svg-lightbox";
import { sanitizeUntrustedSvg } from "@/lib/images/untrusted-svg";
import { RunnerHostContext } from "@/providers/runner-host-context";

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

let runnerHost: MockRunnerHost;

function renderWithRunner(children: ReactNode): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext.Provider value={runnerHost}>
        {children}
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

beforeEach(() => {
  runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
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
  it("keeps image actions from changing an enclosing editor selection", () => {
    const onMouseDown = vi.fn();
    renderWithRunner(
      <div role="presentation" onMouseDown={onMouseDown}>
        <ImageLightbox
          src="blob:http://localhost/raster"
          alt="a misty pier"
          mediaType="image/png"
          suggestedName="pier.png"
          className={undefined}
        >
          <img src="blob:http://localhost/raster" alt="a misty pier" />
        </ImageLightbox>
      </div>,
    );
    const event = createEvent.mouseDown(
      screen.getByRole("button", { name: "Copy image" }),
    );

    fireEvent(screen.getByRole("button", { name: "Copy image" }), event);

    expect(event.defaultPrevented).toBe(true);
    expect(onMouseDown).not.toHaveBeenCalled();
  });

  it("downloads through saveBlobToDisk with the suggested file name", async () => {
    renderWithRunner(
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
    expect(screen.getByRole("button", { name: "Copy image" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "blob:http://localhost/raster",
    );
    const [blob, name] = saveBlobToDiskMock.mock.calls[0];
    expect(name).toBe("pier.png");
    // jsdom may not share Blob identity across realms; assert blob-shaped.
    expect(blob.size).toBeGreaterThan(0);
    expect(typeof blob.arrayBuffer).toBe("function");
  });

  it("copies through copyImageBlobToClipboard (ClipboardItem path lives there)", async () => {
    const user = userEvent.setup();
    renderWithRunner(
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

    await user.tab();
    await user.tab();
    const copy = screen.getByRole("button", { name: "Copy image" });
    expect(document.activeElement).toBe(copy);
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(copyImageMock).toHaveBeenCalledTimes(1);
    });
    const [blob] = copyImageMock.mock.calls[0];
    expect(blob.size).toBeGreaterThan(0);
    expect(typeof blob.arrayBuffer).toBe("function");
  });

  it("opens CORS-less HTTPS images through the runner host", async () => {
    const openExternalLink = vi
      .spyOn(runnerHost, "openExternalLink")
      .mockResolvedValue(undefined);
    renderWithRunner(
      <ImageLightbox
        src="https://cdn.example.com/no-cors.png"
        alt="remote"
        mediaType={null}
        suggestedName="remote.png"
        className={undefined}
      >
        <img src="https://cdn.example.com/no-cors.png" alt="remote" />
      </ImageLightbox>,
    );

    expect(screen.queryByRole("button", { name: "Copy image" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    await waitFor(() => {
      expect(openExternalLink).toHaveBeenCalledWith(
        "https://cdn.example.com/no-cors.png",
      );
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps extended WebP downloadable but outside the clipboard allowlist", () => {
    renderWithRunner(
      <ImageLightbox
        src="blob:http://localhost/extended-webp"
        alt="extended webp"
        mediaType="image/webp"
        suggestedName="extended.webp"
        className={undefined}
      >
        <img src="blob:http://localhost/extended-webp" alt="extended webp" />
      </ImageLightbox>,
    );

    expect(screen.queryByRole("button", { name: "Copy image" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download image" })).toBeTruthy();
  });

  it("shows the standard spinner while a copy is pending", async () => {
    let resolveCopy = (): void => {
      throw new Error("copy promise was not initialized");
    };
    copyImageMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    renderWithRunner(
      <ImageLightbox
        src="blob:http://localhost/raster-pending"
        alt="pending copy"
        mediaType="image/png"
        suggestedName="pending.png"
        className={undefined}
      >
        <img src="blob:http://localhost/raster-pending" alt="pending copy" />
      </ImageLightbox>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    await waitFor(() => {
      expect(copyImageMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("image-action-spinner")).toBeTruthy();
    });
    resolveCopy();
    await waitFor(() => {
      expect(screen.queryByTestId("image-action-spinner")).toBeNull();
    });
  });

  it("opens a dialog with the raster image on trigger click", async () => {
    renderWithRunner(
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
    renderWithRunner(
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

    expect(screen.queryByRole("button", { name: "Copy image" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download image" })).toBeTruthy();

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

  it("shows an inert error when the SVG cannot be sanitized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("<html><body>nope</body></html>", { status: 200 }),
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
      expect(screen.queryByLabelText("Loading SVG")).toBeNull();
    });
    expect(
      screen.getByRole("status", {
        name: /bad svg: couldn't display this svg/i,
      }).textContent,
    ).toContain("Couldn't display this SVG.");
    expect(screen.queryByRole("img")).toBeNull();
    expect(trustedMarkupSpy).not.toHaveBeenCalled();
  });
});
