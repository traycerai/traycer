import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";
import type { ToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { ImageGenerationCard } from "@/components/chat/segments/image-generation-card";
import { ToolSegment } from "@/components/chat/segments/tool-segment";

interface AttachmentBlobState {
  readonly status: "loading" | "ready" | "unavailable";
  readonly src: string | null;
}

const blobSrcState = vi.hoisted((): { value: AttachmentBlobState } => ({
  value: {
    status: "ready",
    src: "blob:http://localhost/generated-1",
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

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => null,
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

function imageResult(
  overrides: Partial<ImageGenerationResult> & {
    readonly attachmentHash: string;
  },
): ImageGenerationResult {
  return {
    mediaType: "image/png",
    byteLength: 256,
    width: null,
    height: null,
    alt: null,
    revisedPrompt: null,
    filePath: null,
    ...overrides,
  };
}

function fieldsDetail(input: Record<string, unknown>): ToolInputDetail {
  const detail = deriveToolInputDetail("image_generation", input);
  if (detail === null) {
    throw new Error("Expected fields detail for image_generation input");
  }
  return detail;
}

function renderCard(
  props: Partial<ComponentProps<typeof ImageGenerationCard>> & {
    readonly id?: string;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImageGenerationCard
        id={props.id ?? "tool-img-1"}
        inputSummary={
          props.inputSummary === undefined ? "a misty pier" : props.inputSummary
        }
        inputDetail={
          props.inputDetail === undefined
            ? fieldsDetail({ prompt: "a misty pier", aspect_ratio: "16:9" })
            : props.inputDetail
        }
        error={props.error === undefined ? null : props.error}
        isStreaming={props.isStreaming ?? false}
        endState={props.endState ?? null}
        stopped={props.stopped ?? false}
        imageResults={props.imageResults ?? []}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  blobSrcState.value = {
    status: "ready",
    src: "blob:http://localhost/generated-1",
  };
});

afterEach(() => {
  cleanup();
});

describe("<ImageGenerationCard /> lifecycle states", () => {
  it("maps a streaming zero-result call to the capped generating state", () => {
    renderCard({ isStreaming: true, imageResults: [] });

    const card = screen.getByRole("region", { name: "Image generation" });
    const generation = card.querySelector('[data-slot="image-generation"]');
    const frame = screen.getByRole("img", {
      name: "Generating image: a misty pier",
    });
    expect(generation?.getAttribute("data-state")).toBe("generating");
    expect(generation?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Generating image")).toBeTruthy();
    expect(screen.getByText(/a misty pier/)).toBeTruthy();
    expect(card.className).toContain("w-full");
    expect(frame.getAttribute("style")).toContain("min(90vw, 42rem)");
    expect(frame.getAttribute("style")).toContain("aspect-ratio: 1.777");
    expect(frame.getAttribute("style")).not.toContain("100vh");
  });

  it("maps results to complete and caps a large image at the shared edge", () => {
    renderCard({
      isStreaming: false,
      inputDetail: fieldsDetail({
        prompt: "a misty pier",
        aspect_ratio: "16:9",
      }),
      imageResults: [
        imageResult({
          attachmentHash: "hash-1",
          width: 800,
          height: 600,
          alt: null,
          revisedPrompt: null,
          filePath: "/tmp/pier.png",
        }),
      ],
    });

    const card = screen.getByRole("region", { name: "Image generation" });
    const generation = card.querySelector('[data-slot="image-generation"]');
    const frame = card.querySelector("[data-image-generation-media]");
    const img = screen.getByRole("img", { name: "a misty pier" });
    expect(generation?.getAttribute("data-state")).toBe("complete");
    expect(generation?.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByText("Image ready").className).toContain("sr-only");
    expect(screen.getByText("800 × 600")).toBeTruthy();
    expect(screen.getByText(/a misty pier/)).toBeTruthy();
    expect(frame?.getAttribute("style")).toContain("min(90vw, 42rem)");
    expect(frame?.getAttribute("style")).toMatch(/aspect-ratio:\s*1\.333/);
    expect(frame?.getAttribute("style")).not.toMatch(/aspect-ratio:\s*1\.777/);
    expect(img.className).toContain("h-auto");
    expect(img.className).toContain("w-auto");
    expect(img.className.split(" ")).not.toContain("w-full");
    expect(img.getAttribute("style")).toContain("min(90vw, 42rem)");
    expect(
      screen.queryByRole("button", { name: "Add image to artifact" }),
    ).toBeNull();
  });

  it("keeps a small generated image intrinsic instead of stretching it", () => {
    renderCard({
      imageResults: [
        imageResult({
          attachmentHash: "small-hash",
          width: 64,
          height: 64,
          alt: "small orange square",
        }),
      ],
    });

    const card = screen.getByRole("region", { name: "Image generation" });
    const frame = card.querySelector("[data-image-generation-media]");
    const img = screen.getByRole("img", { name: "small orange square" });
    expect(frame?.getAttribute("style")).toContain(
      "max-height: min(90vw, 42rem)",
    );
    expect(img.className).toContain("h-auto");
    expect(img.className).toContain("w-auto");
    expect(img.className).not.toContain("size-full");
    expect(screen.getByText("64 × 64")).toBeTruthy();
    expect(card.className).toContain("w-full");
  });

  it("maps a provider failure to the modest error state without retry", () => {
    renderCard({
      error: "Provider rejected the prompt: safety filter",
      isStreaming: false,
      imageResults: [],
    });

    const card = screen.getByRole("region", { name: "Image generation" });
    const generation = card.querySelector('[data-slot="image-generation"]');
    const status = screen.getByText("Generation failed").parentElement;
    expect(generation?.getAttribute("data-state")).toBe("error");
    expect(generation?.getAttribute("aria-busy")).toBe("false");
    expect(status?.className).toContain("text-destructive");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      screen.queryByText("Provider rejected the prompt: safety filter"),
    ).toBeNull();
  });

  it("preserves stopped and superseded terminal outcomes", () => {
    renderCard({ isStreaming: false, endState: "interrupted" });
    expect(screen.getByText("Generation stopped")).toBeTruthy();
    expect(screen.queryByText("Generation failed")).toBeNull();

    cleanup();
    renderCard({ isStreaming: false, endState: "superseded" });
    expect(screen.getByText("Generation superseded")).toBeTruthy();
    expect(screen.queryByText("Generation failed")).toBeNull();
  });

  it("falls back alt text through revisedPrompt then prompt, and prefers revisedPrompt as caption", () => {
    renderCard({
      inputSummary: "original prompt",
      inputDetail: fieldsDetail({ prompt: "original prompt" }),
      imageResults: [
        imageResult({
          attachmentHash: "hash-alt",
          alt: null,
          revisedPrompt: "revised pier at dawn",
          width: 512,
          height: 512,
        }),
      ],
    });

    expect(
      screen.getByRole("img", { name: "revised pier at dawn" }),
    ).toBeTruthy();
    expect(screen.getByText(/revised pier at dawn/)).toBeTruthy();
  });

  it("uses the provider alt when present instead of revisedPrompt", () => {
    renderCard({
      imageResults: [
        imageResult({
          attachmentHash: "hash-provider-alt",
          alt: "provider alt text",
          revisedPrompt: "revised should not win",
          width: 256,
          height: 256,
        }),
      ],
    });

    expect(screen.getByRole("img", { name: "provider alt text" })).toBeTruthy();
  });

  it("renders every generated result", () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/multi",
    };
    renderCard({
      imageResults: [
        imageResult({
          attachmentHash: "same-hash",
          width: 640,
          height: 480,
          alt: "variant a",
        }),
        imageResult({
          attachmentHash: "same-hash",
          width: 640,
          height: 480,
          alt: "variant b",
        }),
      ],
    });

    expect(screen.getByRole("img", { name: "variant a" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "variant b" })).toBeTruthy();
    const card = screen.getByRole("region", { name: "Image generation" });
    expect(
      card.querySelectorAll(
        '[data-slot="image-generation"][data-state="complete"]',
      ),
    ).toHaveLength(2);
  });

  it("shows waiting-for-sync while the attachment blob is not ready, still ratio-reserved", () => {
    blobSrcState.value = { status: "loading", src: null };
    // Waiting frame must also consume host result dimensions (4:3), not the
    // default 16:9 input hint from renderCard.
    renderCard({
      inputDetail: fieldsDetail({
        prompt: "pending",
        aspect_ratio: "16:9",
      }),
      imageResults: [
        imageResult({
          attachmentHash: "hash-pending",
          width: 400,
          height: 300,
        }),
      ],
    });

    const card = screen.getByRole("region", { name: "Image generation" });
    const frame = card.querySelector("[data-image-generation-media]");
    expect(screen.getByText("Waiting for image sync")).toBeTruthy();
    expect(screen.getByText("400 × 300")).toBeTruthy();
    expect(frame?.getAttribute("style")).toMatch(/aspect-ratio:\s*1\.333/);
    expect(frame?.getAttribute("style")).not.toMatch(/aspect-ratio:\s*1\.777/);
  });

  it("omits the dimension badge while syncing unknown dimensions", () => {
    blobSrcState.value = { status: "loading", src: null };
    renderCard({
      imageResults: [
        imageResult({
          attachmentHash: "hash-pending-unknown",
        }),
      ],
    });

    expect(screen.getByText("Waiting for image sync")).toBeTruthy();
    expect(screen.queryByText(/^\d+ × \d+$/)).toBeNull();
  });

  it("shows a terminal failure when the generated image is unavailable", () => {
    blobSrcState.value = { status: "unavailable", src: null };
    renderCard({
      imageResults: [
        imageResult({
          attachmentHash: "hash-unavailable",
          alt: "missing generated image",
        }),
      ],
    });

    expect(screen.queryByText("Waiting for image sync")).toBeNull();
    expect(
      screen.getByRole("status", {
        name: "missing generated image: This image is no longer available.",
      }),
    ).toBeTruthy();
  });
});

describe("<ToolSegment /> image_generation promotion routing", () => {
  afterEach(() => cleanup());

  it("routes exact toolName image_generation + card variant to ImageGenerationCard", () => {
    render(
      <ChatExpansionTestProviders tileInstanceId="img-tool-tile">
        <ToolSegment
          headerFindUnitId={null}
          managedCommand={null}
          id="tool-img-route"
          toolName="image_generation"
          inputSummary={deriveToolInputSummary("image_generation", {
            prompt: "route me",
          })}
          inputDetail={fieldsDetail({ prompt: "route me" })}
          error={null}
          agentMessageSend={null}
          isStreaming
          endState={null}
          stopped={false}
          progress={null}
          backgroundOutput={null}
          backgroundTask={false}
          startedAt={0}
          durationMs={null}
          imageResults={[]}
          variant="card"
        />
      </ChatExpansionTestProviders>,
    );

    expect(
      document.querySelector('[data-image-generation-card="tool-img-route"]'),
    ).not.toBeNull();
    expect(screen.getByText("Generating image")).toBeTruthy();
  });

  it("does not route a non-image_generation tool into the generation card", () => {
    render(
      <ChatExpansionTestProviders tileInstanceId="img-tool-tile">
        <ToolSegment
          headerFindUnitId={null}
          managedCommand={null}
          id="tool-other"
          toolName="read_file"
          inputSummary={deriveToolInputSummary("read_file", {
            path: "/repo/a.ts",
          })}
          inputDetail={deriveToolInputDetail("read_file", {
            path: "/repo/a.ts",
          })}
          error={null}
          agentMessageSend={null}
          isStreaming={false}
          endState={null}
          stopped={false}
          progress={null}
          backgroundOutput={null}
          backgroundTask={false}
          startedAt={0}
          durationMs={100}
          imageResults={[]}
          variant="card"
        />
      </ChatExpansionTestProviders>,
    );

    expect(document.querySelector("[data-image-generation-card]")).toBeNull();
    expect(screen.queryByText("Generating image")).toBeNull();
  });
});
