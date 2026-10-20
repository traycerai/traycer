import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { ToolSegment } from "@/components/chat/segments/tool-segment";

interface BlobState {
  readonly status: "loading" | "ready" | "unavailable";
  readonly src: string | null;
  readonly mediaType: string;
}

const blobState = vi.hoisted(() => ({
  value: {
    status: "loading",
    src: null,
    mediaType: "image/png",
  } as {
    status: "loading" | "ready" | "unavailable";
    src: string | null;
    mediaType: string;
  },
}));

vi.mock(
  "@/lib/attachments/use-attachment-blob-src",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attachments/use-attachment-blob-src")
    >()),
    useChatAttachmentBlobSrc: (): BlobState => blobState.value,
  }),
);

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => null,
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

function result(
  width: number | null,
  height: number | null,
): ImageGenerationResult {
  return {
    attachmentHash: "hash-a",
    mediaType: "image/png",
    byteLength: 256,
    width,
    height,
    alt: "plot",
    revisedPrompt: null,
    filePath: null,
  };
}

function renderEval(imageResult: ImageGenerationResult) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatExpansionTestProviders tileInstanceId="tool-image-placeholder-tile">
        <ToolSegment
          headerFindUnitId={null}
          id="tool-eval-1"
          toolName="eval"
          inputSummary={null}
          inputDetail={null}
          imageResults={[imageResult]}
          page={null}
          mcpApp={null}
          error={null}
          agentMessageSend={null}
          managedCommand={null}
          agentMessageReceipt={null}
          agentMessageDelivery={null}
          isStreaming={false}
          endState={null}
          stopped={false}
          progress={null}
          backgroundOutput={null}
          backgroundTask={false}
          startedAt={0}
          durationMs={null}
          variant="card"
        />
      </ChatExpansionTestProviders>
    </QueryClientProvider>,
  );
}

const ASPECT_CLASS = "aspect-[var(--image-aspect)]";

/**
 * The aspect the gallery reserves: every element inside the figure that paints
 * the aspect class must carry the custom property it reads, and the property
 * is returned as a number (`a / b` or plain). An element with one half of the
 * pair and not the other is reported as NaN so the assertions below fail on it.
 */
function paintedAspectRatios(container: HTMLElement): ReadonlyArray<number> {
  return Array.from(
    container.querySelectorAll<HTMLElement>("figure *"),
  ).flatMap((node) => {
    const hasClass = (node.getAttribute("class") ?? "")
      .split(/\s+/)
      .includes(ASPECT_CLASS);
    const value = node.style.getPropertyValue("--image-aspect").trim();
    if (!hasClass && value.length === 0) return [];
    if (!hasClass || value.length === 0) return [Number.NaN];
    const parts = value.split("/").map(Number);
    return [parts.length === 1 ? parts[0] : parts[0] / parts[1]];
  });
}

beforeEach(() => {
  blobState.value = { status: "loading", src: null, mediaType: "image/png" };
});

afterEach(() => {
  cleanup();
});

describe("generic tool image placeholders", () => {
  it("fills the blob-wait placeholder from the foreground and reserves the recorded aspect", () => {
    const view = renderEval(result(800, 400));

    const placeholder = screen.getByText("Waiting for image sync");
    expect(placeholder.className).toContain("bg-foreground/");
    expect(placeholder.className).not.toContain("bg-muted");
    expect(paintedAspectRatios(view.container)).toContain(2);
  });

  it("fills the decode-loading overlay from the foreground and reserves the recorded aspect", () => {
    blobState.value = {
      status: "ready",
      src: "blob:http://localhost/a",
      mediaType: "image/png",
    };
    const view = renderEval(result(300, 600));

    const overlay = screen.getByText("Loading image");
    expect(overlay.className).toContain("bg-foreground/");
    expect(overlay.className).not.toContain("bg-muted");
    expect(paintedAspectRatios(view.container)).toContain(0.5);
  });

  it.each([
    ["missing", null, null],
    ["zero", 0, 0],
    ["negative", -4, 10],
    ["not finite", Number.POSITIVE_INFINITY, 10],
  ])(
    "falls back to a safe placeholder when the recorded dimensions are %s",
    (_label, width, height) => {
      const view = renderEval(result(width, height));

      expect(screen.getByText("Waiting for image sync")).toBeTruthy();
      const ratios = paintedAspectRatios(view.container);
      expect(ratios.every((ratio) => Number.isFinite(ratio) && ratio > 0)).toBe(
        true,
      );
    },
  );
});
