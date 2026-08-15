import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageResolutionEntry } from "@traycer/protocol/persistence/epic/messages";
import {
  AssistantMarkdownImageNode,
  AssistantMarkdownImageProvider,
} from "@/components/chat/segments/assistant-markdown-image";
import { TraycerMarkdown } from "@/markdown";
import {
  ChatScrollToBlockContext,
  type ScrollToChatBlock,
} from "@/components/chat/chat-scroll-to-block";
import type {
  AssistantMarkdownImageContext,
  AssistantMarkdownImageResolution,
  AssistantMarkdownImageTarget,
} from "@/stores/composer/chat-store";

const blobSrcState = vi.hoisted(() => ({
  value: {
    status: "loading",
    src: null as string | null,
    // The EFFECTIVE type of the resolved blob (host-sniffed when the byte
    // source had a verdict), not the type stored on the message.
    mediaType: "image/png",
  },
}));

vi.mock(
  "@/lib/attachments/use-attachment-blob-src",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attachments/use-attachment-blob-src")
    >()),
    useChatAttachmentBlobSrc: () => blobSrcState.value,
  }),
);

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;
const SVG_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
const UNSAFE_SVG_DATA_URL = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="8" height="8"/></svg>',
)}`;
const JPEG_PIXEL_BOMB_DATA_URL = (() => {
  const bytes = new Uint8Array(40);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  bytes.set(
    [
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x20, 0x00, 0x20, 0x00, 0x01, 0x01, 0x11,
      0x00,
    ],
    20,
  );
  return `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`;
})();
const JPEG_SOF_AFTER_PREFIX_DATA_URL = (() => {
  const bytes = new Uint8Array(65_560);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff], 0);
  const sofOffset = 65_539;
  bytes.set(
    [
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x20, 0x00, 0x01, 0x01,
      0x11, 0x00,
    ],
    sofOffset,
  );
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return `data:image/jpeg;base64,${btoa(binary)}`;
})();
const JPEG_TEM_DATA_URL = (() => {
  const bytes = new Uint8Array(32);
  bytes.set(
    [
      0xff, 0xd8, 0xff, 0x01, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00,
      0x20, 0x00, 0x01, 0x01, 0x11, 0x00,
    ],
    0,
  );
  return `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`;
})();

const EMPTY_DEDUP_TARGETS: ReadonlyMap<string, AssistantMarkdownImageTarget> =
  new Map();

const BASE_CONTEXT: AssistantMarkdownImageContext = {
  epicId: "epic-1",
  chatId: "chat-1",
  resolutions: [],
  deduplicatedTargetsBySource: EMPTY_DEDUP_TARGETS,
};

function dedupTarget(
  toolBlockId: string,
  rowId: string,
): AssistantMarkdownImageTarget {
  return { toolBlockId, rowId };
}

function targetsBySource(
  entries: ReadonlyArray<readonly [string, AssistantMarkdownImageTarget]>,
): ReadonlyMap<string, AssistantMarkdownImageTarget> {
  return new Map(entries);
}

const ASSISTANT_IMAGE_COMPONENTS = { img: AssistantMarkdownImageNode };

function resolution(
  entry: ImageResolutionEntry,
  messageId: string,
): AssistantMarkdownImageResolution {
  return { messageId, entry };
}

function resolvedEntry(
  source: string,
  overrides: Partial<Extract<ImageResolutionEntry, { state: "resolved" }>>,
): Extract<ImageResolutionEntry, { state: "resolved" }> {
  return {
    source,
    canonicalSource: source,
    width: null,
    height: null,
    state: "resolved",
    attachmentHash: "hash-abc",
    mediaType: "image/png",
    ...overrides,
  };
}

type NonResolvedImageResolutionEntry = Exclude<
  ImageResolutionEntry,
  { state: "resolved" }
>;

function nonResolvedEntry(
  source: string,
  state: NonResolvedImageResolutionEntry["state"],
  overrides: Partial<NonResolvedImageResolutionEntry>,
): NonResolvedImageResolutionEntry {
  return {
    source,
    canonicalSource: source,
    width: null,
    height: null,
    state,
    attachmentHash: null,
    mediaType: null,
    ...overrides,
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderImage(args: {
  readonly src: string;
  readonly alt: string | undefined;
  readonly context: AssistantMarkdownImageContext | null | undefined;
}): RenderResult {
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AssistantMarkdownImageProvider context={args.context ?? BASE_CONTEXT}>
        <AssistantMarkdownImageNode
          src={args.src}
          alt={args.alt ?? "diagram"}
        />
      </AssistantMarkdownImageProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  blobSrcState.value = {
    status: "loading",
    src: null,
    mediaType: "image/png",
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AssistantMarkdownImage source classification matrix", () => {
  it("renders https sources as a loadable image with a loading skeleton", () => {
    renderImage({
      src: "https://cdn.example.com/shot.png",
      alt: undefined,
      context: undefined,
    });

    expect(screen.getByRole("status").textContent).toContain("Loading image");
    const img = screen.getByRole("img", { name: "diagram" });
    expect(img.getAttribute("src")).toBe("https://cdn.example.com/shot.png");

    fireEvent.load(img);
    expect(screen.queryByText("Loading image")).toBeNull();
    expect(screen.getByRole("img", { name: "diagram" })).toBeTruthy();
  });

  it.each(["blocked", "consent-required", "oversized", "not-found"] as const)(
    "honors a terminal host resolution for HTTPS sources: %s",
    (state) => {
      renderImage({
        src: "https://cdn.example.com/shot.png",
        alt: "remote image",
        context: {
          ...BASE_CONTEXT,
          resolutions: [
            resolution(
              nonResolvedEntry("https://cdn.example.com/shot.png", state, {}),
              "msg-https",
            ),
          ],
        },
      });

      expect(screen.queryByRole("img")).toBeNull();
      expect(
        document.querySelector("[data-assistant-image-failure]"),
      ).not.toBeNull();
    },
  );

  it("keeps small images intrinsic while applying a fluid image cap", () => {
    renderImage({
      src: "https://cdn.example.com/orange-square.png",
      alt: "small orange square",
      context: undefined,
    });

    const img = screen.getByRole("img", { name: "small orange square" });
    fireEvent.load(img);
    const container = img.closest("button")?.parentElement?.parentElement;
    expect(container?.className).toContain("w-fit");
    expect(container?.className.split(" ")).not.toContain("w-full");
    expect(img.className).toContain("h-auto");
    expect(img.className).toContain("w-auto");
    expect(img.className.split(" ")).not.toContain("w-full");
    expect(img.getAttribute("style")).toContain("max-height: min(90vw, 42rem)");
    expect(img.getAttribute("style")).toContain(
      "max-width: min(100%, min(90vw, 42rem))",
    );
  });

  it("renders raster data URLs under the decoded-byte cap", () => {
    renderImage({
      src: TINY_PNG_DATA_URL,
      alt: undefined,
      context: undefined,
    });

    const img = screen.getByRole("img", { name: "diagram" });
    expect(img.getAttribute("src")).toBe(TINY_PNG_DATA_URL);
    fireEvent.load(img);
    expect(document.querySelector("[data-assistant-image-failure]")).toBeNull();
  });

  it("routes data:image/svg+xml through the loadable image + SVG lightbox path", () => {
    renderImage({ src: SVG_DATA_URL, alt: undefined, context: undefined });

    // Thumbnails stay <img>; the lightbox owns the sanitizer on open.
    // Ticket 07: never fail-chip SVG data URLs on the assistant surface.
    expect(document.querySelector("[data-assistant-image-failure]")).toBeNull();
    const img = screen.getByRole("img", { name: "diagram" });
    expect(img.getAttribute("src")).toBe(SVG_DATA_URL);
    expect(screen.getByRole("button", { name: "Open diagram" })).toBeTruthy();
  });

  it("sanitizes inline SVG before rendering the thumbnail", () => {
    renderImage({
      src: UNSAFE_SVG_DATA_URL,
      alt: undefined,
      context: undefined,
    });

    const img = screen.getByRole("img", { name: "diagram" });
    const renderedSource = img.getAttribute("src");
    expect(renderedSource).not.toBe(UNSAFE_SVG_DATA_URL);
    expect(renderedSource).toContain("data:image/svg+xml;base64,");
    expect(atob(renderedSource?.split(",")[1] ?? "")).not.toContain("<script>");
  });

  it("uses quiet SVG-specific copy when a thumbnail cannot load", () => {
    renderImage({ src: SVG_DATA_URL, alt: undefined, context: undefined });

    fireEvent.error(screen.getByRole("img", { name: "diagram" }));
    const failure = document.querySelector("[data-assistant-image-failure]");
    expect(failure?.textContent).toBe("Couldn't display this SVG.");
    expect(failure?.className).toContain("text-muted-foreground");
    expect(failure?.className).not.toContain("destructive");
    expect(failure?.querySelector("svg")).toBeNull();
  });

  it("renders a resolved local source from the attachment blob cache when bytes are ready", () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/resolved-local",
      mediaType: "image/png",
    };
    renderImage({
      src: "/workspace/shots/diagram.png",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        resolutions: [
          resolution(
            resolvedEntry("/workspace/shots/diagram.png", {}),
            "msg-1",
          ),
        ],
      },
    });

    const img = screen.getByRole("img", { name: "diagram" });
    expect(img.getAttribute("src")).toBe(
      "blob:http://localhost/resolved-local",
    );
  });

  it("sanitizes attachment-backed SVGs before rendering the thumbnail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(atob(UNSAFE_SVG_DATA_URL.split(",")[1]), {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
        ),
      ),
    );
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/resolved-svg",
      mediaType: "image/svg+xml",
    };
    renderImage({
      src: "/workspace/shots/diagram.svg",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        resolutions: [
          resolution(
            resolvedEntry("/workspace/shots/diagram.svg", {
              mediaType: "image/svg+xml",
            }),
            "msg-1",
          ),
        ],
      },
    });

    const img = await screen.findByRole("img", { name: "diagram" });
    await waitFor(() => {
      const renderedSource = img.getAttribute("src") ?? "";
      expect(renderedSource).toContain("data:image/svg+xml;base64,");
      expect(atob(renderedSource.split(",")[1] ?? "")).not.toContain(
        "<script>",
      );
    });
  });

  it("sanitizes bytes the host says are SVG even when the message claims PNG", async () => {
    // The stored `mediaType` is written by whichever composer produced the
    // message and describes bytes nobody re-checked; `epic.readChatAttachment`
    // sniffs the delivered bytes' magic bytes and is host-authoritative. Gating
    // sanitization on the stored claim let SVG-filed-as-PNG reach the renderer
    // with `sanitizeUntrustedSvg` skipped entirely.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(atob(UNSAFE_SVG_DATA_URL.split(",")[1]), {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
        ),
      ),
    );
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/mislabeled-svg",
      mediaType: "image/svg+xml",
    };
    renderImage({
      src: "/workspace/shots/diagram.png",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        resolutions: [
          resolution(
            resolvedEntry("/workspace/shots/diagram.png", {
              mediaType: "image/png",
            }),
            "msg-1",
          ),
        ],
      },
    });

    const img = await screen.findByRole("img", { name: "diagram" });
    await waitFor(() => {
      const renderedSource = img.getAttribute("src") ?? "";
      expect(renderedSource).toContain("data:image/svg+xml;base64,");
      expect(atob(renderedSource.split(",")[1] ?? "")).not.toContain(
        "<script>",
      );
    });
  });

  it("shows the remote-host waiting skeleton when the hash is known but the blob is still pending", () => {
    blobSrcState.value = {
      status: "loading",
      src: null,
      mediaType: "image/png",
    };
    renderImage({
      src: "/workspace/shots/pending.png",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        resolutions: [
          resolution(
            resolvedEntry("/workspace/shots/pending.png", {}),
            "msg-1",
          ),
        ],
      },
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Waiting for image sync",
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("[data-assistant-image-failure]")).toBeNull();
  });

  it("shows a terminal failure when a resolved attachment is unavailable", () => {
    blobSrcState.value = {
      status: "unavailable",
      src: null,
      mediaType: "image/png",
    };
    renderImage({
      src: "/workspace/shots/missing.png",
      alt: "missing image",
      context: {
        ...BASE_CONTEXT,
        resolutions: [
          resolution(
            resolvedEntry("/workspace/shots/missing.png", {}),
            "msg-1",
          ),
        ],
      },
    });

    expect(screen.queryByText("Waiting for image sync")).toBeNull();
    expect(
      screen.getByRole("status", {
        name: "missing image: This image is no longer available.",
      }),
    ).toBeTruthy();
  });

  it("renders terminal failure text for legacy consent-required sources", () => {
    renderImage({
      src: "./local.png",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        resolutions: [
          resolution(
            nonResolvedEntry("./local.png", "consent-required", {}),
            "msg-1",
          ),
        ],
      },
    });

    const failure = document.querySelector("[data-assistant-image-failure]");
    expect(failure?.textContent).toBe("Couldn't display this image.");
    expect(failure?.className).toContain("text-muted-foreground");
    expect(document.querySelector("[data-assistant-image-consent]")).toBeNull();
  });

  it.each([
    {
      state: "blocked" as const,
      reason: "Couldn't display this image.",
    },
    {
      state: "oversized" as const,
      reason: "This image is too large to show here.",
    },
    {
      state: "not-found" as const,
      reason: "This image is no longer available.",
    },
  ])("renders quiet terminal failure text for $state", ({ state, reason }) => {
    renderImage({
      src: `/workspace/${state}.png`,
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        resolutions: [
          resolution(
            nonResolvedEntry(`/workspace/${state}.png`, state, {}),
            "msg-1",
          ),
        ],
      },
    });

    const chip = document.querySelector("[data-assistant-image-failure]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe(reason);
    expect(chip?.className).toContain("text-muted-foreground");
    expect(chip?.className).not.toContain("destructive");
    expect(chip?.querySelector("svg")).toBeNull();
    expect(chip?.textContent).not.toContain("blocked by policy");
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("[data-assistant-image-consent]")).toBeNull();
  });

  it("renders terminal failure text for pre-1.7 history with no resolution records", () => {
    renderImage({
      src: "/workspace/legacy.png",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        resolutions: [],
      },
    });

    const failure = document.querySelector("[data-assistant-image-failure]");
    expect(failure?.textContent).toBe("Couldn't display this image.");
    expect(failure?.className).toContain("text-muted-foreground");
    expect(document.querySelector("[data-assistant-image-consent]")).toBeNull();
  });

  it("collapses sources listed in deduplicatedTargetsBySource to a link chip", () => {
    renderImage({
      src: "/workspace/generated.png",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        deduplicatedTargetsBySource: targetsBySource([
          [
            "/workspace/generated.png",
            dedupTarget("tool-img-1", "assistant-row-1"),
          ],
        ]),
      },
    });

    const chip = document.querySelector("[data-assistant-image-deduplicated]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("diagram");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("focuses the exact same-row generation card when the dedup link is clicked", () => {
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <AssistantMarkdownImageProvider
          context={{
            ...BASE_CONTEXT,
            deduplicatedTargetsBySource: targetsBySource([
              [
                "/workspace/generated.png",
                dedupTarget("tool-img-shared", "assistant-row-shared"),
              ],
            ]),
          }}
        >
          <div data-message-id="assistant-row-shared">
            <section
              data-image-generation-card="tool-img-shared"
              tabIndex={-1}
            />
            <AssistantMarkdownImageNode
              src="/workspace/generated.png"
              alt="generated pier"
            />
          </div>
        </AssistantMarkdownImageProvider>
      </QueryClientProvider>,
    );

    const liveCard = document.querySelector<HTMLElement>(
      '[data-image-generation-card="tool-img-shared"]',
    );
    expect(liveCard).not.toBeNull();
    const focusSpy = vi.spyOn(liveCard as HTMLElement, "focus");
    const scrollSpy = vi.spyOn(liveCard as HTMLElement, "scrollIntoView");

    const chip = document.querySelector("[data-assistant-image-deduplicated]");
    expect(chip).not.toBeNull();
    fireEvent.click(chip as HTMLElement);

    expect(scrollSpy).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "nearest",
    });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("targets the exact card when two generation cards share a virtualized row", () => {
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <AssistantMarkdownImageProvider
          context={{
            ...BASE_CONTEXT,
            deduplicatedTargetsBySource: targetsBySource([
              [
                "/workspace/second.png",
                dedupTarget("tool-img-second", "assistant-row-multi"),
              ],
            ]),
          }}
        >
          <div data-message-id="assistant-row-multi">
            <section
              data-image-generation-card="tool-img-first"
              tabIndex={-1}
            />
            <section
              data-image-generation-card="tool-img-second"
              tabIndex={-1}
            />
            <AssistantMarkdownImageNode
              src="/workspace/second.png"
              alt="second image"
            />
          </div>
        </AssistantMarkdownImageProvider>
      </QueryClientProvider>,
    );

    const first = document.querySelector<HTMLElement>(
      '[data-image-generation-card="tool-img-first"]',
    );
    const second = document.querySelector<HTMLElement>(
      '[data-image-generation-card="tool-img-second"]',
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const firstFocus = vi.spyOn(first as HTMLElement, "focus");
    const secondFocus = vi.spyOn(second as HTMLElement, "focus");
    const secondScroll = vi.spyOn(second as HTMLElement, "scrollIntoView");

    fireEvent.click(
      document.querySelector(
        "[data-assistant-image-deduplicated]",
      ) as HTMLElement,
    );

    expect(secondFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(secondScroll).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "nearest",
    });
    // Exact targeting: the first card must not steal focus.
    expect(firstFocus).not.toHaveBeenCalled();
  });

  it("navigates the unmounted split-row timeline target via scrollToBlock", () => {
    const scrollToBlock = vi.fn<ScrollToChatBlock>();
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <ChatScrollToBlockContext.Provider value={scrollToBlock}>
          <AssistantMarkdownImageProvider
            context={{
              ...BASE_CONTEXT,
              deduplicatedTargetsBySource: targetsBySource([
                [
                  "/workspace/echoed.png",
                  dedupTarget("tool-img-pre-steer", "assistant-row-pre-steer"),
                ],
              ]),
            }}
          >
            {/*
              Echo lives on a later virtualized row; the generation card's
              owning row is unmounted (no data-message-id match in the DOM).
            */}
            <div data-message-id="assistant-row-post-steer">
              <AssistantMarkdownImageNode
                src="/workspace/echoed.png"
                alt="echoed image"
              />
            </div>
          </AssistantMarkdownImageProvider>
        </ChatScrollToBlockContext.Provider>
      </QueryClientProvider>,
    );

    expect(document.querySelector("[data-image-generation-card]")).toBeNull();
    fireEvent.click(
      document.querySelector(
        "[data-assistant-image-deduplicated]",
      ) as HTMLElement,
    );
    expect(scrollToBlock).toHaveBeenCalledTimes(1);
    expect(scrollToBlock).toHaveBeenCalledWith("tool-img-pre-steer", "tool");
  });

  it("rejects oversized raster data URLs via the decoded-byte cap", () => {
    // 30 MiB + 1 decoded byte requires ceil((30*1024*1024+1)/3)*4 base64 chars.
    const overLimitPayload = "A".repeat(
      Math.ceil((30 * 1024 * 1024 + 1) / 3) * 4,
    );
    renderImage({
      src: `data:image/png;base64,${overLimitPayload}`,
      alt: undefined,
      context: undefined,
    });

    const chip = document.querySelector("[data-assistant-image-failure]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("This image is too large to show here.");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("rejects oversized base64 SVGs before decoding the payload", () => {
    const overLimitPayload = "A".repeat(
      Math.ceil((5 * 1024 * 1024 + 1) / 3) * 4,
    );
    const atobSpy = vi.spyOn(globalThis, "atob");
    renderImage({
      src: `data:image/svg+xml;base64,${overLimitPayload}`,
      alt: undefined,
      context: undefined,
    });

    expect(
      document.querySelector("[data-assistant-image-failure]")?.textContent,
    ).toBe("This image is too large to show here.");
    expect(atobSpy).not.toHaveBeenCalled();
  });

  it("reads JPEG dimensions as big-endian before applying the pixel cap", () => {
    renderImage({
      src: JPEG_PIXEL_BOMB_DATA_URL,
      alt: undefined,
      context: undefined,
    });

    expect(
      document.querySelector("[data-assistant-image-failure]")?.textContent,
    ).toBe("This image is too large to show here.");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("rejects JPEGs whose dimensions are outside the inspected prefix", () => {
    renderImage({
      src: JPEG_SOF_AFTER_PREFIX_DATA_URL,
      alt: undefined,
      context: undefined,
    });

    expect(
      document.querySelector("[data-assistant-image-failure]")?.textContent,
    ).toBe("This image is too large to show here.");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("accepts JPEGs with a standalone TEM marker before SOF", () => {
    renderImage({
      src: JPEG_TEM_DATA_URL,
      alt: "tem jpeg",
      context: undefined,
    });

    expect(document.querySelector("[data-assistant-image-failure]")).toBeNull();
    expect(screen.getByRole("img", { name: "tem jpeg" })).toBeTruthy();
  });

  it("uses quiet generic copy for invalid raster data URLs", () => {
    renderImage({
      src: "data:image/png;base64,abc",
      alt: undefined,
      context: undefined,
    });

    const chip = document.querySelector("[data-assistant-image-failure]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Couldn't display this image.");
    expect(chip?.className).not.toContain("destructive");
  });

  it("uses quiet generic copy for unsupported image sources", () => {
    renderImage({
      src: "ftp://example.com/image.png",
      alt: undefined,
      context: undefined,
    });

    const failure = document.querySelector("[data-assistant-image-failure]");
    expect(failure?.textContent).toBe("Couldn't display this image.");
    expect(failure?.className).toContain("text-muted-foreground");
    expect(failure?.className).not.toContain("destructive");
  });

  it("rejects SVG bytes mislabeled as image/png", () => {
    const mislabeled = `data:image/png;base64,${btoa("<svg></svg>")}`;
    renderImage({ src: mislabeled, alt: undefined, context: undefined });

    expect(
      document.querySelector("[data-assistant-image-failure]")?.textContent,
    ).toBe("Couldn't display this image.");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("AssistantMarkdownImage markdown pipeline", () => {
  it("preserves and resolves parser-normalized Windows backslash paths", async () => {
    const encodedSource = "C:%5CUsers%5Canurag%5Cchart.png";
    const canonicalSource = "C:\\Users\\anurag\\chart.png";
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/windows-chart",
      mediaType: "image/png",
    };
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <AssistantMarkdownImageProvider
          context={{
            ...BASE_CONTEXT,
            resolutions: [
              resolution(
                resolvedEntry(encodedSource, { canonicalSource }),
                "assistant-windows",
              ),
            ],
          }}
        >
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={ASSISTANT_IMAGE_COMPONENTS}
            imageRendering="assistant"
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {`![windows chart](${encodedSource})`}
          </TraycerMarkdown>
        </AssistantMarkdownImageProvider>
      </QueryClientProvider>,
    );

    const image = await screen.findByRole("img", { name: "windows chart" });
    expect(image.getAttribute("src")).toBe(
      "blob:http://localhost/windows-chart",
    );
    expect(document.querySelector("[data-assistant-image-failure]")).toBeNull();
  });
});

describe("AssistantMarkdownImage context", () => {
  it("renders nothing when the assistant image context provider is missing", () => {
    const { container } = render(
      <AssistantMarkdownImageNode src="https://example.com/a.png" alt="x" />,
    );
    expect(container.childNodes).toHaveLength(0);
  });
});
