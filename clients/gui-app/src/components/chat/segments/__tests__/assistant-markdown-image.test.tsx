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
import type {
  AssistantMarkdownImageContext,
  AssistantMarkdownImageResolution,
} from "@/stores/composer/chat-store";

const blobSrcState = vi.hoisted(() => ({
  value: {
    status: "loading",
    src: null as string | null,
  },
}));

const hostRequest = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ accepted: true })),
);

vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useAttachmentBlobSrc: () => blobSrcState.value,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    request: hostRequest,
  }),
}));

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;
const SVG_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

const BASE_CONTEXT: AssistantMarkdownImageContext = {
  epicId: "epic-1",
  chatId: "chat-1",
  resolutions: [],
  deduplicatedSources: new Set(),
};

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

function nonResolvedEntry(
  source: string,
  state: "blocked" | "consent-required" | "oversized" | "not-found",
  overrides: Partial<Extract<ImageResolutionEntry, { state: typeof state }>>,
): Extract<ImageResolutionEntry, { state: typeof state }> {
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
  blobSrcState.value = { status: "loading", src: null };
  hostRequest.mockReset();
  hostRequest.mockResolvedValue({ accepted: true });
});

afterEach(() => {
  cleanup();
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

  it("defers data:image/svg+xml to the secure SVG path (failure chip for now)", () => {
    renderImage({ src: SVG_DATA_URL, alt: undefined, context: undefined });

    const chip = document.querySelector("[data-assistant-image-failure]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain(
      "SVG preview will be available with the secure SVG viewer",
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders a resolved local source from the attachment blob cache when bytes are ready", () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/resolved-local",
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

  it("shows the remote-host waiting skeleton when the hash is known but the blob is still pending", () => {
    blobSrcState.value = { status: "loading", src: null };
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

  it("renders a consent chip for consent-required local sources", () => {
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

    const chip = document.querySelector("[data-assistant-image-consent]");
    expect(chip).not.toBeNull();
    expect(chip).toBeInstanceOf(HTMLButtonElement);
    expect((chip as HTMLButtonElement).disabled).toBe(false);
    expect(chip?.textContent).toContain("diagram");
  });

  it.each([
    {
      state: "blocked" as const,
      reason: "Image blocked by policy",
    },
    {
      state: "oversized" as const,
      reason: "Image exceeds the 30 MB limit",
    },
    {
      state: "not-found" as const,
      reason: "Image not found",
    },
  ])("renders a terminal failure chip for $state", ({ state, reason }) => {
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
    expect(chip?.textContent).toContain(reason);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("[data-assistant-image-consent]")).toBeNull();
  });

  it("falls back to a disabled consent chip for pre-1.7 history with no resolution records", () => {
    renderImage({
      src: "/workspace/legacy.png",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        resolutions: [],
      },
    });

    const chip = document.querySelector("[data-assistant-image-consent]");
    expect(chip).not.toBeNull();
    expect(chip).toBeInstanceOf(HTMLButtonElement);
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(hostRequest).not.toHaveBeenCalled();
  });

  it("collapses sources listed in deduplicatedSources to a link chip", () => {
    renderImage({
      src: "/workspace/generated.png",
      alt: undefined,
      context: {
        ...BASE_CONTEXT,
        deduplicatedSources: new Set(["/workspace/generated.png"]),
      },
    });

    const chip = document.querySelector("[data-assistant-image-deduplicated]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("diagram");
    expect(screen.queryByRole("img")).toBeNull();
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
    expect(chip?.textContent).toContain(
      "Inline image is invalid or exceeds the 30 MB limit",
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("rejects invalid raster data URLs with the same cap/invalid failure chip", () => {
    renderImage({
      src: "data:image/png;base64,abc",
      alt: undefined,
      context: undefined,
    });

    const chip = document.querySelector("[data-assistant-image-failure]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain(
      "Inline image is invalid or exceeds the 30 MB limit",
    );
  });
});

describe("AssistantMarkdownImage consent RPC and record updates", () => {
  it("calls chat.requestImageIngest with the authoritative record fields on consent click", async () => {
    renderImage({
      src: "shots/need-consent.png",
      alt: "Load me",
      context: {
        ...BASE_CONTEXT,
        resolutions: [
          resolution(
            nonResolvedEntry("shots/need-consent.png", "consent-required", {
              canonicalSource: "/abs/shots/need-consent.png",
            }),
            "assistant-msg-9",
          ),
        ],
      },
    });

    const chip = document.querySelector(
      "[data-assistant-image-consent]",
    ) as HTMLButtonElement;
    fireEvent.click(chip);

    await waitFor(() => {
      expect(hostRequest).toHaveBeenCalledTimes(1);
    });
    expect(hostRequest).toHaveBeenCalledWith("chat.requestImageIngest", {
      epicId: "epic-1",
      chatId: "chat-1",
      messageId: "assistant-msg-9",
      source: "/abs/shots/need-consent.png",
    });
  });

  it("rerenders from the authoritative resolution record after consent → resolved", () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/after-consent",
    };
    const client = createQueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <AssistantMarkdownImageProvider
          context={{
            ...BASE_CONTEXT,
            resolutions: [
              resolution(
                nonResolvedEntry("./shot.png", "consent-required", {}),
                "msg-1",
              ),
            ],
          }}
        >
          <AssistantMarkdownImageNode src="./shot.png" alt="shot" />
        </AssistantMarkdownImageProvider>
      </QueryClientProvider>,
    );

    expect(
      document.querySelector("[data-assistant-image-consent]"),
    ).not.toBeNull();

    view.rerender(
      <QueryClientProvider client={client}>
        <AssistantMarkdownImageProvider
          context={{
            ...BASE_CONTEXT,
            resolutions: [resolution(resolvedEntry("./shot.png", {}), "msg-1")],
          }}
        >
          <AssistantMarkdownImageNode src="./shot.png" alt="shot" />
        </AssistantMarkdownImageProvider>
      </QueryClientProvider>,
    );

    expect(document.querySelector("[data-assistant-image-consent]")).toBeNull();
    const img = screen.getByRole("img", { name: "shot" });
    expect(img.getAttribute("src")).toBe("blob:http://localhost/after-consent");
  });

  it("renders nothing when the assistant image context provider is missing", () => {
    const { container } = render(
      <AssistantMarkdownImageNode src="https://example.com/a.png" alt="x" />,
    );
    expect(container.childNodes).toHaveLength(0);
  });
});
