import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import {
  AssistantMarkdownImageNode,
  AssistantMarkdownImageProvider,
} from "@/components/chat/segments/assistant-markdown-image";
import { ToolSegment } from "@/components/chat/segments/tool-segment";
import { RunnerHostContext } from "@/providers/runner-host-context";

const openLink = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLink,
  useOpenLinkWithPending: () => ({ isPending: false, openLink }),
}));

const downloadBlobToDeviceMock = vi.hoisted(() =>
  vi.fn<
    (
      blob: Blob,
      suggestedName: string,
    ) => Promise<{ name: string; path: string | null } | null>
  >(() => Promise.resolve({ name: "saved", path: null })),
);

vi.mock("@/lib/files/save-blob-to-disk", () => ({
  saveBlobToDisk: vi.fn(),
  downloadBlobToDevice: (blob: Blob, suggestedName: string) =>
    downloadBlobToDeviceMock(blob, suggestedName),
  hasSeparateDownloadRoute: () => false,
  canDownloadToDevice: () => true,
  canOpenSavedFile: () => false,
  openSavedFile: vi.fn(),
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

vi.mock(
  "@/lib/attachments/use-attachment-blob-src",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attachments/use-attachment-blob-src")
    >()),
    useChatAttachmentBlobSrc: () => ({
      status: "ready",
      src: "blob:http://localhost/a",
      mediaType: "image/png",
    }),
  }),
);

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => null,
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

const TINY_PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

function result(
  alt: string | null,
  filePath: string | null,
): ImageGenerationResult {
  return {
    attachmentHash: "hash-a",
    mediaType: "image/png",
    byteLength: 256,
    width: null,
    height: null,
    alt,
    revisedPrompt: null,
    filePath,
  };
}

function Providers(props: { readonly children: ReactNode }) {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <RunnerHostContext.Provider value={runnerHost}>
        <ChatExpansionTestProviders tileInstanceId="tool-image-download-tile">
          {props.children}
        </ChatExpansionTestProviders>
      </RunnerHostContext.Provider>
    </QueryClientProvider>
  );
}

function renderTool(
  toolName: string,
  imageResult: ImageGenerationResult,
  variant: "card" | "row",
) {
  return render(
    <Providers>
      <ToolSegment
        headerFindUnitId={null}
        id="tool-1"
        toolName={toolName}
        inputSummary={null}
        inputDetail={null}
        imageResults={[imageResult]}
        artifact={null}
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
        variant={variant}
      />
    </Providers>,
  );
}

async function downloadedName(): Promise<string> {
  fireEvent.click(screen.getByRole("button", { name: "Download image" }));
  await waitFor(() => {
    expect(downloadBlobToDeviceMock).toHaveBeenCalledTimes(1);
  });
  return downloadBlobToDeviceMock.mock.calls[0][1];
}

beforeEach(() => {
  downloadBlobToDeviceMock.mockClear();
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

describe("generic tool gallery download name", () => {
  it.each([
    ["a posix path", "/work/out/plot.png", "plot.png"],
    ["a windows path", "C:\\work\\out\\fig.png", "fig.png"],
  ])("keeps the basename of %s", async (_label, filePath, expected) => {
    renderTool("eval", result("first plot", filePath), "card");

    expect(await downloadedName()).toBe(expected);
  });

  it.each([
    ["a null path", null],
    ["an empty path", ""],
    ["a path that ends in a separator", "/work/out/"],
  ])("falls back to the caption-derived name for %s", async (_label, path) => {
    renderTool("eval", result("first plot", path), "row");

    expect(await downloadedName()).toBe("first-plot.png");
  });
});

describe("download names that must not change", () => {
  it("keeps the image-generation card on its own file name", async () => {
    renderTool(
      "image_generation",
      result("a misty pier", "/tmp/generated/pier.png"),
      "card",
    );

    expect(await downloadedName()).toBe("pier.png");
  });

  it("keeps a Markdown reply image on the caption-derived name, not a tool file path", async () => {
    render(
      <Providers>
        <AssistantMarkdownImageProvider
          context={{
            epicId: "epic-1",
            chatId: "chat-1",
            resolutions: [
              {
                messageId: "msg-1",
                entry: {
                  source: "/workspace/echo.png",
                  canonicalSource: "/workspace/echo.png",
                  width: null,
                  height: null,
                  state: "resolved",
                  attachmentHash: "hash-a",
                  mediaType: "image/png",
                },
              },
            ],
            deduplicatedTargetsBySource: new Map(),
          }}
        >
          <AssistantMarkdownImageNode
            src="/workspace/echo.png"
            alt="Echo Plot"
          />
        </AssistantMarkdownImageProvider>
      </Providers>,
    );

    expect(await downloadedName()).toBe("echo-plot.png");
  });
});
