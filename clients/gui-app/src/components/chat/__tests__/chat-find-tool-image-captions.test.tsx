import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { ChatFindHighlighter } from "@/components/chat/chat-find-highlighter";
import { findTextMatches } from "@/lib/find-engine/find-text";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import type {
  ChatMessage as ChatMessageModel,
  ToolSegment,
} from "@/stores/composer/chat-store";

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
    useChatAttachmentBlobSrc: (hash: string) =>
      blobStates.byHash[hash] ?? {
        status: "ready",
        src: "blob:http://localhost/a",
        mediaType: "image/png",
      },
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

function image(
  alt: string | null,
  attachmentHash: string,
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

const IMAGES = [image("first plot", "hash-a"), image(null, "hash-a")];

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
    artifact: null,
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

beforeEach(() => {
  blobStates.byHash = {};
  useToolOpenStore.getState().reset(TILE_INSTANCE_ID);
});

afterEach(() => {
  cleanup();
  useToolOpenStore.getState().reset(TILE_INSTANCE_ID);
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

// The highlighter walks the mounted text of the root, so a number it counts and
// the number the projection counted only agree if the gallery's loading,
// unavailable and decode-loading statuses stay out of its reach.
describe("Chat Find highlighter over the generic tool gallery", () => {
  const painted = new Map<string, { readonly ranges: readonly Range[] }>();
  const GALLERY = [
    image(null, "hash-ready"),
    image(null, "hash-waiting"),
    image(null, "hash-gone"),
    image(null, "hash-ready"),
    image("Image 4", "hash-ready"),
  ];

  beforeEach(() => {
    painted.clear();
    blobStates.byHash = {
      "hash-ready": {
        status: "ready",
        src: "blob:http://localhost/a",
        mediaType: "image/png",
      },
      "hash-waiting": { status: "loading", src: null, mediaType: "image/png" },
      "hash-gone": { status: "unavailable", src: null, mediaType: "image/png" },
    };
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, highlight: { readonly ranges: readonly Range[] }) =>
          painted.set(name, highlight),
        delete: (name: string) => painted.delete(name),
      },
    });
    vi.stubGlobal(
      "Highlight",
      class {
        readonly ranges: readonly Range[];
        constructor(...ranges: readonly Range[]) {
          this.ranges = ranges;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function rangesNamed(prefix: string): readonly Range[] {
    const entry = [...painted.entries()].find(([name]) =>
      name.startsWith(prefix),
    );
    return entry?.[1].ranges ?? [];
  }

  function expectedCaptionMatches(segment: ToolSegment): number {
    const unit = unitsFor(segment).find((candidate) =>
      candidate.text.includes("Image 4"),
    );
    if (unit === undefined) throw new Error("Expected a caption find unit");
    return findTextMatches(unit.text, "image", false).length;
  }

  function paintAt(root: HTMLElement, activeMatchIndex: number): void {
    const highlighter = new ChatFindHighlighter();
    expect(
      highlighter.paint({
        root,
        query: "image",
        matchCase: false,
        activeMatchIndex,
        scrollActiveIntoView: false,
      }),
    ).toBe(true);
  }

  /** Every range lands in a caption, in caption order, with the active one marked. */
  function expectOnlyCaptions(root: HTMLElement, total: number): void {
    const captions = Array.from(root.querySelectorAll("figcaption"));
    const all = [
      ...rangesNamed("traycer-find-match-"),
      ...rangesNamed("traycer-find-active-"),
    ];
    expect(all).toHaveLength(total);
    for (const range of all) {
      expect(
        range.startContainer.parentElement?.closest("figcaption"),
      ).not.toBeNull();
    }
    expect(captions).toHaveLength(total);
  }

  function renderCard() {
    const segment = toolSegment("eval-1", "eval", GALLERY);
    return {
      segment,
      view: render(
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
      ),
    };
  }

  it("counts only caption text in a collapsed card, including repeated captions and hashes", () => {
    const { segment, view } = renderCard();
    const total = expectedCaptionMatches(segment);
    expect(total).toBe(GALLERY.length);

    paintAt(view.container, 4);

    expectOnlyCaptions(view.container, total);
    const active = rangesNamed("traycer-find-active-");
    expect(active).toHaveLength(1);
    expect(active[0].startContainer.parentElement?.closest("figcaption")).toBe(
      view.container.querySelectorAll("figcaption")[4],
    );
  });

  it("keeps the ordinals on the captions once the card is open", () => {
    const { segment, view } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: /eval/ }));
    expect(screen.getByText("cell-7")).toBeTruthy();

    paintAt(view.container, 2);

    expectOnlyCaptions(view.container, expectedCaptionMatches(segment));
    expect(
      rangesNamed(
        "traycer-find-active-",
      )[0].startContainer.parentElement?.closest("figcaption"),
    ).toBe(view.container.querySelectorAll("figcaption")[2]);
  });

  it("keeps the ordinals on the captions in an expanded row", () => {
    const segment = toolSegment("eval-1", "eval", GALLERY);
    const group: ActivityGroupModel = {
      id: deriveActivityGroupRenderId(segment.id),
      segments: [segment],
      isActive: false,
      isStreaming: false,
      label: "Used 1 tool",
      summary: "Used 1 tool",
      activeStartedAt: null,
    };
    const view = render(
      <Providers>
        <ActivityGroupSegment group={group} />
      </Providers>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Used 1 tool/ }));

    paintAt(view.container, 0);

    expectOnlyCaptions(view.container, expectedCaptionMatches(segment));
  });
});
