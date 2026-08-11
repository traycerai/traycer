import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useAttachmentBlobSrc: () => blobSrcState.value,
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
  return render(
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
      imageResults={props.imageResults ?? []}
    />,
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
  it("renders the queued/generating frame while streaming with no results", () => {
    renderCard({ isStreaming: true, imageResults: [] });

    expect(
      screen.getByRole("region", { name: "Image generation" }),
    ).toBeTruthy();
    expect(screen.getByText("Generating image")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Generating image" }),
    ).toBeTruthy();
    const pending = screen.getByRole("status", { name: "Generating image" });
    expect(pending.getAttribute("style")).toContain("aspect-ratio: 1.777");
    expect(screen.getByText("a misty pier")).toBeTruthy();
  });

  it("renders a complete result with prompt caption, resolution badge, and cross-fade classes", () => {
    renderCard({
      isStreaming: false,
      imageResults: [
        imageResult({
          attachmentHash: "hash-1",
          width: 1024,
          height: 576,
          alt: null,
          revisedPrompt: null,
          filePath: "/tmp/pier.png",
        }),
      ],
    });

    expect(screen.getByText("Generated image")).toBeTruthy();
    expect(screen.queryByText("In progress")).toBeNull();
    expect(screen.getByText("1024 × 576")).toBeTruthy();
    expect(screen.getByText("a misty pier")).toBeTruthy();

    const img = screen.getByRole("img", { name: "a misty pier" });
    expect(img.className).toContain("opacity-0");
    expect(img.className).toContain("transition-opacity");
    expect(img.className).toContain("motion-reduce:transition-none");
    fireEvent.load(img);
    expect(img.className).toContain("opacity-100");

    const figure = img.closest("figure");
    expect(figure?.getAttribute("style")).toContain("aspect-ratio:");
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
    expect(screen.getByText("revised pier at dawn")).toBeTruthy();
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

  it("shows the provider error message in a reserved-ratio frame with no fake refining state", () => {
    renderCard({
      error: "Provider rejected the prompt: safety filter",
      isStreaming: false,
      imageResults: [],
    });

    expect(screen.getByText("Image generation failed")).toBeTruthy();
    expect(
      screen.getByText("Provider rejected the prompt: safety filter"),
    ).toBeTruthy();
    expect(screen.getByText("Ask the agent to try again.")).toBeTruthy();
    expect(screen.queryByText("In progress")).toBeNull();
    expect(screen.queryByText("Refining")).toBeNull();

    const status = screen.getByRole("status");
    expect(status.getAttribute("style")).toContain("aspect-ratio:");
    const card = document.querySelector(
      '[data-image-generation-card="tool-img-1"]',
    );
    expect(card?.className).toContain("border-destructive/35");
  });

  it("reserves the tool-arg aspect ratio on pending and avoids layout-class drift to fixed pixels", () => {
    const { container } = renderCard({
      isStreaming: true,
      inputDetail: fieldsDetail({
        prompt: "square logo",
        aspect_ratio: "1:1",
      }),
      imageResults: [],
    });

    const pending = screen.getByRole("status", { name: "Generating image" });
    expect(pending.getAttribute("style")).toMatch(/aspect-ratio:\s*1\b/);
    // Layout surfaces stay fluid: no hard-coded px width/height on the frame.
    expect(pending.className).not.toMatch(/\bw-\[\d+px\]/);
    expect(pending.className).not.toMatch(/\bh-\[\d+px\]/);
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.querySelector("canvas")?.className).toContain(
      "motion-reduce:animate-none",
    );
  });

  it("renders a multi-image grid with a result count", () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/multi",
    };
    renderCard({
      imageResults: [
        imageResult({
          attachmentHash: "hash-a",
          width: 640,
          height: 480,
          alt: "variant a",
        }),
        imageResult({
          attachmentHash: "hash-b",
          width: 640,
          height: 480,
          alt: "variant b",
        }),
      ],
    });

    expect(screen.getByText("2 results")).toBeTruthy();
    expect(screen.getByRole("img", { name: "variant a" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "variant b" })).toBeTruthy();
    const card = screen.getByRole("region", { name: "Image generation" });
    const bodyGrid = card.querySelector(".grid");
    expect(bodyGrid?.className).toContain("sm:grid-cols-2");
  });

  it("shows waiting-for-sync while the attachment blob is not ready, still ratio-reserved", () => {
    blobSrcState.value = { status: "loading", src: null };
    renderCard({
      imageResults: [
        imageResult({
          attachmentHash: "hash-pending",
          width: 800,
          height: 600,
        }),
      ],
    });

    const waiting = screen.getByText("Waiting for image sync");
    expect(
      waiting.getAttribute("style") ??
        waiting.parentElement?.getAttribute("style"),
    ).toMatch(/aspect-ratio/);
  });
});

describe("<ToolSegment /> image_generation promotion routing", () => {
  afterEach(() => cleanup());

  it("routes exact toolName image_generation + card variant to ImageGenerationCard", () => {
    render(
      <ChatExpansionTestProviders tileInstanceId="img-tool-tile">
        <ToolSegment
          headerFindUnitId={null}
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
