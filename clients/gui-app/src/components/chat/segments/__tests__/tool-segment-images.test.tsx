import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type {
  ImageGenerationResult,
  ToolCallMcpAppStamp,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { ToolSegment } from "@/components/chat/segments/tool-segment";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";

interface BlobState {
  readonly status: "loading" | "ready" | "unavailable";
  readonly src: string | null;
  readonly mediaType: string;
}

const blobStates = vi.hoisted(() => ({
  byHash: {} as Record<
    string,
    {
      status: "loading" | "ready" | "unavailable";
      src: string | null;
      mediaType: string;
    }
  >,
}));

vi.mock(
  "@/lib/attachments/use-attachment-blob-src",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attachments/use-attachment-blob-src")
    >()),
    useChatAttachmentBlobSrc: (hash: string): BlobState =>
      blobStates.byHash[hash] ?? {
        status: "unavailable",
        src: null,
        mediaType: "image/png",
      },
  }),
);

// The app row needs a sandbox frame jsdom cannot run; a stand-in shows that
// ToolSegment routed the call to it and not to the generic gallery.
vi.mock("@/components/chat/segments/mcp-app-row", () => ({
  McpAppRow: () => <div data-testid="mcp-app-row" />,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => null,
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

function ready(name: string): BlobState {
  return {
    status: "ready",
    src: `blob:http://localhost/${name}`,
    mediaType: "image/png",
  };
}

const MCP_APP_STAMP: ToolCallMcpAppStamp = {
  server: "Sheets",
  tool: "open_budget",
  resourceUri: "ui://sheets/budget",
  snapshot: { path: "files/mcp-apps/budget.html", sha256: "a".repeat(64) },
  csp: {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  },
  permissions: [],
  prefersBorder: false,
  toolInput: {},
  toolResult: { content: [{ type: "text", text: "ok" }] },
  source: {
    originChatId: "chat-1",
    harnessId: "claude",
    nativeSessionId: "session-1",
    serverKey: "b".repeat(64),
  },
  modelContext: null,
};

function result(
  attachmentHash: string,
  alt: string | null,
): ImageGenerationResult {
  return {
    attachmentHash,
    mediaType: "image/png",
    byteLength: 256,
    width: null,
    height: null,
    alt,
    revisedPrompt: null,
    filePath: null,
  };
}

const EVAL_INPUT = { language: "python", code: "plot_it()" };

function renderTool(
  props: Partial<ComponentProps<typeof ToolSegment>> & {
    readonly imageResults: ReadonlyArray<ImageGenerationResult>;
  },
) {
  const toolName = props.toolName ?? "eval";
  const client = new QueryClient();
  return rtlRender(
    <QueryClientProvider client={client}>
      <ChatExpansionTestProviders tileInstanceId="tool-segment-images-tile">
        <ToolSegment
          headerFindUnitId={null}
          id="tool-eval-1"
          toolName={toolName}
          inputSummary={deriveToolInputSummary(toolName, EVAL_INPUT)}
          inputDetail={deriveToolInputDetail(toolName, EVAL_INPUT)}
          page={null}
          mcpApp={null}
          error={null}
          agentMessageSend={null}
          managedCommand={null}
          agentMessageReceipt={null}
          isStreaming={false}
          endState={null}
          stopped={false}
          progress={null}
          backgroundOutput={null}
          backgroundTask={false}
          startedAt={0}
          durationMs={null}
          variant="card"
          {...props}
        />
      </ChatExpansionTestProviders>
    </QueryClientProvider>,
  );
}

function captionTexts(container: HTMLElement): ReadonlyArray<string> {
  return Array.from(container.querySelectorAll("figcaption")).map(
    (node) => node.textContent,
  );
}

beforeEach(() => {
  blobStates.byHash = {
    "hash-a": ready("a"),
    "hash-b": ready("b"),
  };
});

afterEach(() => {
  useToolOpenStore.getState().reset("default");
  cleanup();
});

describe("<ToolSegment /> generic tool image results", () => {
  it("shows ordered captioned images for a realistic eval call without inventing a code panel", () => {
    // `code` is a bulk field the detail derivation drops, so the call stays
    // header-only and non-expandable exactly as it does without images.
    const view = renderTool({
      imageResults: [result("hash-a", "first plot"), result("hash-b", null)],
    });

    expect(screen.getByText("eval")).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Image generation" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /eval/ })).toBeNull();
    expect(screen.queryByText("plot_it()")).toBeNull();
    expect(screen.queryByText("Code")).toBeNull();
    expect(captionTexts(view.container)).toEqual(["first plot", "Image 2"]);
    expect(
      screen.getAllByRole("img").map((img) => img.getAttribute("src")),
    ).toEqual(["blob:http://localhost/a", "blob:http://localhost/b"]);
  });

  it("keeps the gallery visible while an expandable input detail opens and collapses", () => {
    const view = renderTool({
      inputSummary: "python",
      inputDetail: {
        kind: "fields",
        entries: [
          { key: "language", label: "Language", value: "python" },
          { key: "cell", label: "Cell", value: "cell-7" },
        ],
      },
      imageResults: [result("hash-a", "first plot"), result("hash-b", null)],
    });
    const expectGallery = () => {
      expect(captionTexts(view.container)).toEqual(["first plot", "Image 2"]);
      expect(screen.getAllByRole("img")).toHaveLength(2);
    };

    expectGallery();
    expect(screen.queryByText("cell-7")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /eval/ }));
    expect(screen.getByText("cell-7")).toBeTruthy();
    expectGallery();

    fireEvent.click(screen.getByRole("button", { name: /eval/ }));
    expect(screen.queryByText("cell-7")).toBeNull();
    expectGallery();
  });

  it("shows the images in the row variant without an image-generation card", () => {
    const view = renderTool({
      variant: "row",
      imageResults: [result("hash-a", "row plot")],
    });

    expect(screen.getByText("eval")).toBeTruthy();
    expect(captionTexts(view.container)).toEqual(["row plot"]);
    expect(screen.getByRole("img", { name: "row plot" })).toBeTruthy();
    expect(
      view.container.querySelector('[data-slot="image-generation"]'),
    ).toBeNull();
  });

  it("renders the same hash twice as two captioned images", () => {
    const view = renderTool({
      imageResults: [result("hash-a", "same bytes"), result("hash-a", null)],
    });

    expect(captionTexts(view.container)).toEqual(["same bytes", "Image 2"]);
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("keeps the existing loading, unavailable and undecodable strings per image", () => {
    blobStates.byHash = {
      "hash-a": { status: "loading", src: null, mediaType: "image/png" },
      "hash-b": { status: "unavailable", src: null, mediaType: "image/png" },
      "hash-c": ready("c"),
    };
    const view = renderTool({
      imageResults: [
        result("hash-a", "pending"),
        result("hash-b", "gone"),
        result("hash-c", "broken"),
      ],
    });

    expect(screen.getByText("Waiting for image sync")).toBeTruthy();
    expect(
      screen.getByRole("status", {
        name: "gone: This image is no longer available.",
      }),
    ).toBeTruthy();

    fireEvent.error(screen.getByRole("img", { name: "broken" }));

    expect(
      screen.getByRole("status", {
        name: "broken: Couldn't display this image.",
      }),
    ).toBeTruthy();
    expect(captionTexts(view.container)).toEqual(["pending", "gone", "broken"]);
  });

  it("leaves image_generation to its own card and adds no gallery", () => {
    const card = renderTool({
      toolName: "image_generation",
      imageResults: [result("hash-a", "a misty pier")],
    });
    expect(
      screen.getByRole("region", { name: "Image generation" }),
    ).toBeTruthy();
    expect(card.container.querySelector("figure")).toBeNull();
    cleanup();

    const row = renderTool({
      toolName: "image_generation",
      variant: "row",
      imageResults: [result("hash-a", "a misty pier")],
    });
    expect(row.container.querySelector("figure")).toBeNull();
    expect(within(row.container).queryByRole("img")).toBeNull();
  });

  it("routes an MCP App call to its app row even when it carries image results", () => {
    const view = renderTool({
      mcpApp: MCP_APP_STAMP,
      imageResults: [result("hash-a", "stray image")],
    });

    expect(screen.getByTestId("mcp-app-row")).toBeTruthy();
    expect(view.container.querySelector("figure")).toBeNull();
    expect(screen.queryByText("stray image")).toBeNull();
  });

  it("renders no gallery for a generic tool without images", () => {
    const view = renderTool({ imageResults: [] });

    expect(screen.getByText("eval")).toBeTruthy();
    expect(view.container.querySelector("figure")).toBeNull();
  });
});
