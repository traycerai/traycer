import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ReadChatFileRequest,
  ReadChatFileResponse,
} from "@traycer/protocol/host/epic/chat-file";

import {
  ChatAttachmentScopeContext,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerContentRenderer } from "../composer-content-renderer";

const HOST_ID = "host-1";
const HASH = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  read: vi.fn<
    (
      method: string,
      request: ReadChatFileRequest,
      timeoutMs: number,
    ) => Promise<ReadChatFileResponse>
  >(),
  saveBlobToDisk:
    vi.fn<(blob: Blob, fileName: string, host: unknown) => Promise<null>>(),
  toastSavedFile: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    requestWithResponseTimeout: mocks.read,
    getActiveHostId: () => "host-1",
    onChange: () => () => undefined,
  }),
}));

vi.mock("@/lib/files/save-blob-to-disk", () => ({
  saveBlobToDisk: mocks.saveBlobToDisk,
  openSavedFile: vi.fn(),
}));

vi.mock("@/lib/files/saved-file-toast", () => ({
  toastSavedFile: mocks.toastSavedFile,
}));

const SCOPE: ChatAttachmentScopeValue = {
  epicId: "epic-1",
  chatId: "chat-1",
  hostId: HOST_ID,
  hostVersion: null,
  client: null,
};

function fileDoc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "fileAttachment",
            attrs: {
              id: "node-1",
              hash: HASH,
              fileName: "report.pdf",
              mediaType: "application/pdf",
              size: 2048,
            },
          },
        ],
      },
    ],
  };
}

function renderChip(scope: ChatAttachmentScopeValue | null) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <ChatAttachmentScopeContext value={scope}>
          <ComposerContentRenderer
            content={fileDoc()}
            variant={undefined}
            className={undefined}
            testId={undefined}
          />
        </ChatAttachmentScopeContext>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.read.mockReset();
  mocks.saveBlobToDisk.mockReset();
  mocks.saveBlobToDisk.mockResolvedValue(null);
  mocks.toastSavedFile.mockReset();
  resetNegotiatedManifests();
  recordNegotiatedHostManifest(HOST_ID, {
    "epic.readChatFile": { major: 1, minor: 0 },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("transcript file chip", () => {
  it("downloads: reads by hash alone, then saves the bytes under the node's name and type", async () => {
    // "hi" in base64
    mocks.read.mockResolvedValue({ ok: true, bytesBase64: "aGk=" });
    renderChip(SCOPE);

    fireEvent.click(
      screen.getByRole("button", { name: "Download report.pdf" }),
    );

    await waitFor(() => expect(mocks.saveBlobToDisk).toHaveBeenCalledTimes(1));
    const [method, request, timeoutMs] = mocks.read.mock.calls[0];
    expect(method).toBe("epic.readChatFile");
    const expected: ReadChatFileRequest = {
      epicId: "epic-1",
      chatId: "chat-1",
      hash: HASH,
      plane: "local-only",
    };
    expect(request).toEqual(expected);
    expect(timeoutMs).toBe(120_000);

    const [blob, name] = mocks.saveBlobToDisk.mock.calls[0];
    expect(name).toBe("report.pdf");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBe(2);
    // Bytes were handed over; the chip is a download button again.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Download report.pdf" }),
      ).not.toBeNull(),
    );
  });

  it("shows File unavailable inline on missing, with nothing saved", async () => {
    mocks.read.mockResolvedValue({ ok: false, reason: "missing" });
    const { container } = renderChip(SCOPE);

    fireEvent.click(
      screen.getByRole("button", { name: "Download report.pdf" }),
    );

    await screen.findByText("File unavailable");
    const chip = container.querySelector(
      '[data-file-attachment-state="missing"]',
    );
    expect(chip).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
    expect(mocks.saveBlobToDisk).not.toHaveBeenCalled();
  });

  it("renders the chip with no action on a host that does not serve the read", () => {
    resetNegotiatedManifests();
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.listChats": { major: 1, minor: 0 },
    });
    const { container } = renderChip(SCOPE);

    expect(screen.queryByRole("button")).toBeNull();
    expect(
      container.querySelector('[data-composer-chip="file-attachment"]')
        ?.textContent,
    ).toContain("report.pdf");
  });

  it("renders the chip with no action outside a chat scope", () => {
    renderChip(null);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("Attached file report.pdf")).not.toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
