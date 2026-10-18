import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  buildChatFindRows,
  chatFindActivityGroupChildHeaderUnitId,
  chatFindSegmentUnitId,
  type ChatFindUnit,
} from "@/components/chat/chat-find";
import { deriveActivityGroupRenderId } from "@/components/chat/chat-collapsible-key";
import type { ActivityGroupModel } from "@/components/chat/chat-activity-groups";
import { AssistantSegment } from "@/components/chat/chat-message-assistant-body";
import { ActivityGroupSegment } from "@/components/chat/segments/activity-group-segment";
import type {
  ChatMessage as ChatMessageModel,
  ToolSegment,
} from "@/stores/composer/chat-store";

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

const TILE_INSTANCE_ID = "chat-find-image-caption-tile";

function image(alt: string | null): ImageGenerationResult {
  return {
    attachmentHash: "hash-a",
    mediaType: "image/png",
    byteLength: 256,
    width: null,
    height: null,
    alt,
    revisedPrompt: null,
    filePath: null,
  };
}

const IMAGES = [image("first plot"), image(null)];

function toolSegment(
  id: string,
  toolName: string,
  imageResults: ReadonlyArray<ImageGenerationResult>,
): ToolSegment {
  return {
    id,
    kind: "tool",
    toolName,
    inputSummary: "python",
    inputDetail: {
      kind: "fields",
      entries: [
        { key: "language", label: "Language", value: "python" },
        { key: "cell", label: "Cell", value: "cell-7" },
      ],
    },
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    imageResults,
    page: null,
    mcpApp: null,
    startedAt: 0,
    durationMs: null,
    parentId: null,
  };
}

function unitsFor(segment: ToolSegment): ReadonlyArray<ChatFindUnit> {
  const message: ChatMessageModel = {
    ...makeMessage(1, "assistant"),
    segments: [segment],
  };
  return buildChatFindRows([message], TILE_INSTANCE_ID, new Set(), {
    hideReasoning: false,
    queuePauseReasonProtocolSupported: null,
  })[0].units;
}

function captionUnit(units: ReadonlyArray<ChatFindUnit>): ChatFindUnit {
  const unit = units.find((candidate) => candidate.text.includes("first plot"));
  if (unit === undefined) throw new Error("Expected a caption find unit");
  return unit;
}

function Providers(props: { readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ChatExpansionTestProviders tileInstanceId={TILE_INSTANCE_ID}>
        {props.children}
      </ChatExpansionTestProviders>
    </QueryClientProvider>
  );
}

function anchorsFor(unitId: string): ReadonlyArray<Element> {
  return Array.from(
    document.querySelectorAll(`[data-chat-find-unit="${unitId}"]`),
  );
}

function expectCaptionsPainted(unitId: string): void {
  const anchors = anchorsFor(unitId);
  expect(anchors).toHaveLength(1);
  const text = anchors[0].textContent;
  expect(text).toContain("first plot");
  expect(text).toContain("Image 2");
  expect(text.indexOf("first plot")).toBeLessThan(text.indexOf("Image 2"));
}

afterEach(() => {
  cleanup();
});

describe("Chat Find over generic tool image captions", () => {
  it("indexes the visible captions as their own unit, apart from the header unit", () => {
    const segment = toolSegment("eval-1", "eval", IMAGES);
    const units = unitsFor(segment);

    const captions = captionUnit(units);
    const header = units.find(
      (unit) => unit.unitId === chatFindSegmentUnitId(segment.id),
    );
    expect(captions.unitId).not.toBe(chatFindSegmentUnitId(segment.id));
    expect(captions.text).toContain("Image 2");
    expect(captions.text.indexOf("first plot")).toBeLessThan(
      captions.text.indexOf("Image 2"),
    );
    expect(header?.text ?? "").not.toContain("first plot");
    expect(header?.text ?? "").not.toContain("Image 2");
  });

  it("paints the caption anchor in the card both collapsed and open", () => {
    const segment = toolSegment("eval-1", "eval", IMAGES);
    const { unitId } = captionUnit(unitsFor(segment));

    render(
      <Providers>
        <AssistantSegment
          id={segment.id}
          segment={segment}
          backgroundToolBlockIds={new Set()}
          nextStepActions={null}
          forkAction={null}
          interviewDeliveryRetry={null}
          harnessId={null}
          turnId={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
          autonomousResumeVariant="card"
        />
      </Providers>,
    );

    expectCaptionsPainted(unitId);
    expect(screen.queryByText("cell-7")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /eval/ }));

    expect(screen.getByText("cell-7")).toBeTruthy();
    expectCaptionsPainted(unitId);
  });

  it("paints a caption anchor, distinct from the row header anchor, in an expanded row", () => {
    const segment = toolSegment("eval-1", "eval", IMAGES);
    const group: ActivityGroupModel = {
      id: deriveActivityGroupRenderId(segment.id),
      segments: [segment],
      isActive: false,
      isStreaming: false,
      label: "Used 1 tool",
      summary: "Used 1 tool",
      activeStartedAt: null,
    };

    render(
      <Providers>
        <ActivityGroupSegment group={group} />
      </Providers>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Used 1 tool/ }));

    const headerUnitId = chatFindActivityGroupChildHeaderUnitId(
      group.id,
      segment.id,
    );
    const captionAnchors = Array.from(
      document.querySelectorAll("[data-chat-find-unit]"),
    ).filter(
      (anchor) =>
        anchor.getAttribute("data-chat-find-unit") !== headerUnitId &&
        anchor.textContent.includes("first plot") &&
        anchor.textContent.includes("Image 2"),
    );
    expect(captionAnchors).toHaveLength(1);
    expect(
      document.querySelector(`[data-chat-find-unit="${headerUnitId}"]`)
        ?.textContent,
    ).not.toContain("first plot");
  });

  it.each([
    [
      "an A2A send",
      {
        ...toolSegment("a2a-1", "traycer_a2a/traycer_send_message", []),
        agentMessageSend: {
          receiverAgentId: "agent-1",
          message: "hello there",
          responseId: "response-1",
          expectReply: false,
        },
      },
    ],
    ["image_generation", toolSegment("gen-1", "image_generation", [])],
    [
      "a managed command",
      {
        ...toolSegment("shell-1", "mcp__traycer_a2a__traycer_run_shell", []),
        managedCommand: {
          event: "started" as const,
          commandId: "cmd-1",
          description: "watcher",
          monitoring: false,
          cwd: null,
        },
      },
    ],
  ])("adds no gallery find unit for %s that carries images", (_label, bare) => {
    const withImages: ToolSegment = { ...bare, imageResults: IMAGES };

    const ids = (units: ReadonlyArray<ChatFindUnit>) =>
      units.map((unit) => unit.unitId);
    expect(ids(unitsFor(withImages))).toEqual(ids(unitsFor(bare)));
    expect(
      unitsFor(withImages).some((unit) => unit.text.includes("Image 2")),
    ).toBe(false);
  });
});
