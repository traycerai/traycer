import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { deriveSubagentCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import {
  buildChatFindRows,
  buildSubagentChatFindRows,
} from "@/components/chat/chat-find";
import { SubagentChatView } from "@/components/chat/subagent-chat-view";
import { subagentCardPath } from "@/components/chat/segments/subagent-display";
import { OpenSubagentAsChatContext } from "@/components/chat/segments/subagent-open-as-chat";
import { AssistantSegment } from "@/components/chat/chat-message-assistant-body";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import type {
  ChatMessage as ChatMessageModel,
  SubagentSegment,
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

const TILE_INSTANCE_ID = "tool-card-parent-image-tile";
const SKILL_ID = "toolu_skill";

const SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const DISPLAY_CONTEXT: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  resolveAgentServiceTierLabel: () => null,
  contentBlocksPreview: () => "",
};

const BASE_INPUT: RenderedMessagesInput = {
  messages: [],
  events: [],
  rowContext: {},
  pendingUserMessages: [],
  withdrawnMessageId: null,
  liveAssistantMessage: null,
  activeTurn: null,
  runStatus: "idle",
  setupCardWindows: [],
  epicId: "epic-1",
  ownerId: "owner-1",
  ownerKind: "chat",
  viewTabId: "tab-1",
};

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

function toolBlock(
  blockId: string,
  toolName: string,
  parentBlockId: string | null,
  imageResults: ReadonlyArray<ImageGenerationResult>,
): ContentBlock {
  const input = { description: "run it" };
  return {
    type: "tool_call",
    blockId,
    toolName,
    inputSummary: deriveToolInputSummary(toolName, input),
    inputDetail: deriveToolInputDetail(toolName, input),
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
    artifact: null,
    mcpApp: null,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    stopped: false,
    status: "completed",
    timestamp: 2005,
    startedAt: 2005,
    endedAt: 2006,
    imageResults: [...imageResults],
    ...(parentBlockId === null ? {} : { parentBlockId }),
  };
}

const BLOCKS: ReadonlyArray<ContentBlock> = [
  toolBlock(SKILL_ID, "Skill", null, [image("first plot"), image(null)]),
  {
    type: "text",
    blockId: "t1",
    status: "completed",
    timestamp: 2002,
    text: "skill prose",
    providerNotice: null,
    parentBlockId: SKILL_ID,
  },
  toolBlock("tool-1", "Read", SKILL_ID, []),
];

function persisted(
  blocks: ReadonlyArray<ContentBlock>,
): Partial<RenderedMessagesInput> {
  const assistant: Extract<Message, { role: "assistant" }> = {
    role: "assistant",
    messageId: "turn-1",
    sender: SENDER,
    blocks: [...blocks],
    startedAt: 2000,
    timestamp: 2000,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
  return { messages: [assistant] };
}

function live(
  blocks: ReadonlyArray<ContentBlock>,
): Partial<RenderedMessagesInput> {
  return {
    liveAssistantMessage: {
      turnId: "turn-1",
      blocks: [...blocks],
      startedAt: 2000,
      blocksVersion: 1,
      imageResolutions: [],
      imageResolutionsVersion: 0,
      timestamp: 2000,
      sender: SENDER,
      reasoningEffort: null,
      serviceTier: null,
    },
  };
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

function renderedRow(patch: Partial<RenderedMessagesInput>): ChatMessageModel {
  const { result } = renderHook(() =>
    useRenderedMessages({ ...BASE_INPUT, ...patch }, DISPLAY_CONTEXT),
  );
  const row = result.current.at(0);
  if (row === undefined) throw new Error("Expected an assistant row");
  return row;
}

function onlyCard(row: ChatMessageModel): SubagentSegment {
  const card = row.segments.find((segment) => segment.kind === "subagent");
  if (card === undefined) throw new Error("Expected a subagent card");
  return card;
}

beforeEach(() => {
  useToolOpenStore.getState().reset(TILE_INSTANCE_ID);
});

afterEach(() => {
  cleanup();
  useToolOpenStore.getState().reset(TILE_INSTANCE_ID);
});

describe.each([
  ["a replayed turn", persisted],
  ["a live turn", live],
])(
  "a Skill tool that owns children and returns images, in %s",
  (_label, input) => {
    it("keeps its children and shows the gallery on the mounted parent card", () => {
      const row = renderedRow(input(BLOCKS));
      const card = onlyCard(row);
      expect(row.segments.map((segment) => segment.kind)).toEqual(["subagent"]);
      expect(card.id).toBe(SKILL_ID);
      expect(card.children.map((child) => child.id)).toEqual(["t1", "tool-1"]);

      render(
        <Providers>
          <AssistantSegment
            id={card.id}
            segment={card}
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

      const captions = screen
        .getAllByText(/^(first plot|Image 2)$/)
        .filter((node) => node.tagName === "FIGCAPTION");
      expect(captions.map((node) => node.textContent)).toEqual([
        "first plot",
        "Image 2",
      ]);
    });

    it("indexes the captions as a find unit whose anchor is mounted with the card collapsed", () => {
      const row = renderedRow(input(BLOCKS));
      const card = onlyCard(row);
      const units = buildChatFindRows([row], TILE_INSTANCE_ID, new Set(), {
        hideReasoning: false,
        queuePauseReasonProtocolSupported: null,
      })[0].units;
      const captionUnit = units.find(
        (unit) =>
          unit.text.includes("first plot") && unit.text.includes("Image 2"),
      );
      if (captionUnit === undefined) throw new Error("Expected a caption unit");
      expect(captionUnit.text.indexOf("first plot")).toBeLessThan(
        captionUnit.text.indexOf("Image 2"),
      );
      // The gallery sits outside the card's collapsible body, so finding a
      // caption must not require opening the card.
      expect(captionUnit.owningChain).not.toContain(
        deriveSubagentCollapsibleKey(TILE_INSTANCE_ID, card.id),
      );

      render(
        <Providers>
          <AssistantSegment
            id={card.id}
            segment={card}
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

      const anchors = document.querySelectorAll(
        `[data-chat-find-unit="${captionUnit.unitId}"]`,
      );
      expect(anchors).toHaveLength(1);
      expect(anchors[0].textContent).toContain("first plot");
      expect(anchors[0].textContent).toContain("Image 2");
    });
  },
);

// A Skill whose own conversation holds a nested agent: the Skill's gallery and
// its Find ownership must survive alongside the nested agent's descendants.
const NESTED_BLOCKS: ReadonlyArray<ContentBlock> = [
  ...BLOCKS,
  {
    type: "subagent",
    agentType: null,
    blockId: "worker-1",
    name: "worker",
    task: "Do the thing.",
    progressUpdates: [],
    result: null,
    status: "completed",
    timestamp: 2007,
    startedAt: 2007,
    spawnToolCallId: null,
    stopped: false,
    workflowMeta: null,
    parentBlockId: SKILL_ID,
  },
  {
    type: "text",
    blockId: "w-text",
    status: "completed",
    timestamp: 2008,
    text: "worker prose",
    providerNotice: null,
    parentBlockId: "worker-1",
  },
  toolBlock("w-tool", "Read", "worker-1", []),
];

describe.each([
  ["a replayed turn", persisted],
  ["a live turn", live],
])("a Skill tool with images and a nested agent, in %s", (_label, input) => {
  it("keeps the gallery, the Find ownership and every nested descendant", () => {
    const row = renderedRow(input(NESTED_BLOCKS));
    expect(row.segments.map((segment) => segment.kind)).toEqual(["subagent"]);
    const card = onlyCard(row);
    expect(card.id).toBe(SKILL_ID);
    expect(card.children.map((child) => child.id)).toEqual([
      "t1",
      "tool-1",
      "worker-1",
    ]);
    const worker = card.children.find((child) => child.id === "worker-1");
    if (worker?.kind !== "subagent") throw new Error("Expected nested agent");
    expect(worker.children.map((child) => child.id)).toEqual([
      "w-text",
      "w-tool",
    ]);

    const units = buildChatFindRows([row], TILE_INSTANCE_ID, new Set(), {
      hideReasoning: false,
      queuePauseReasonProtocolSupported: null,
    })[0].units;
    const captionUnits = units.filter(
      (unit) =>
        unit.text.includes("first plot") && unit.text.includes("Image 2"),
    );
    expect(captionUnits).toHaveLength(1);
    expect(captionUnits[0].owningChain).not.toContain(
      deriveSubagentCollapsibleKey(TILE_INSTANCE_ID, card.id),
    );

    render(
      <Providers>
        <AssistantSegment
          id={card.id}
          segment={card}
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

    const anchors = document.querySelectorAll(
      `[data-chat-find-unit="${captionUnits[0].unitId}"]`,
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0].textContent).toContain("first plot");
    expect(anchors[0].textContent).toContain("Image 2");
  });
});

// Open as chat over cards the real import produced: a Skill that owns a nested
// Skill and a sibling Skill, each returning its own images. The view is driven
// through the same stateful handlers the tile uses, so selecting a card and
// stepping back are real navigation.
function skillBlocks(): ReadonlyArray<ContentBlock> {
  const prose = (id: string, parent: string): ContentBlock => ({
    type: "text",
    blockId: id,
    status: "completed",
    timestamp: 2002,
    text: `${id} prose`,
    providerNotice: null,
    parentBlockId: parent,
  });
  return [
    toolBlock(SKILL_ID, "Skill", null, [image("root plot")]),
    prose("root-prose", SKILL_ID),
    toolBlock("inner-skill", "Skill", SKILL_ID, [image("inner plot")]),
    prose("inner-prose", "inner-skill"),
    toolBlock("sib-skill", "Skill", SKILL_ID, [image("sibling plot")]),
    prose("sib-prose", "sib-skill"),
  ];
}

function StatefulChatView(props: {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly initialOpenId: string;
}) {
  const [openId, setOpenId] = useState<string | null>(props.initialOpenId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);
  return (
    <Providers>
      <OpenSubagentAsChatContext.Provider value={setOpenId}>
        <SubagentChatView
          drillIn={{
            openId,
            open: setOpenId,
            close: () => setOpenId(null),
          }}
          messages={props.messages}
          bottomInset={0}
          scrollRef={scrollRef}
          transcriptRef={transcriptRef}
        />
      </OpenSubagentAsChatContext.Provider>
    </Providers>
  );
}

function openCard(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
): SubagentSegment {
  const card = subagentCardPath(messages, id)?.at(-1);
  if (card === undefined) throw new Error(`Expected card ${id}`);
  return card;
}

function viewCaptions(): ReadonlyArray<string> {
  return Array.from(
    screen.getByTestId("subagent-chat-view").querySelectorAll("figcaption"),
  ).map((node) => node.textContent);
}

function galleryUnits(card: SubagentSegment, caption: string) {
  return buildSubagentChatFindRows(card, TILE_INSTANCE_ID)[0].units.filter(
    (unit) => unit.text.includes(caption),
  );
}

describe.each([
  ["a replayed turn", persisted],
  ["a live turn", live],
])("Open as chat over a real Skill import, in %s", (_label, input) => {
  it("selects, nests and steps back with each card's own gallery and Find rows", () => {
    const row = renderedRow(input(skillBlocks()));
    const messages = [row];
    expect(openCard(messages, SKILL_ID).children.map((c) => c.id)).toEqual([
      "root-prose",
      "inner-skill",
      "sib-skill",
    ]);

    render(
      <StatefulChatView messages={messages} initialOpenId="inner-skill" />,
    );

    // The nested card, selected: its own gallery only, and one Find unit.
    expect(viewCaptions()).toEqual(["inner plot"]);
    expect(galleryUnits(openCard(messages, "inner-skill"), "plot")).toEqual([
      expect.objectContaining({ text: "inner plot", owningChain: [] }),
    ]);

    // Back one level, through the breadcrumb: the Skill's own gallery leads.
    // Both crumbs are named "Skill"; the first is the ancestor.
    fireEvent.click(screen.getAllByRole("button", { name: "Skill" })[0]);
    expect(viewCaptions()).toContain("root plot");
    const rootUnits = galleryUnits(openCard(messages, SKILL_ID), "plot");
    const unitFor = (caption: string) => {
      const matches = rootUnits.filter((unit) => unit.text === caption);
      expect(matches).toHaveLength(1);
      return matches[0];
    };
    // Each card's gallery is its own unit, and each is mounted exactly once in
    // the root view (a nested gallery is an always-visible footer there).
    const galleryUnitIds = ["root plot", "inner plot", "sibling plot"].map(
      (caption) => {
        const unit = unitFor(caption);
        const anchors = screen
          .getByTestId("subagent-chat-view")
          .querySelectorAll(`[data-chat-find-unit="${unit.unitId}"]`);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].textContent).toContain(caption);
        return unit.unitId;
      },
    );
    expect(new Set(galleryUnitIds).size).toBe(3);
    expect(unitFor("root plot").owningChain).toEqual([]);

    // Down into the sibling from the parent's view: only its gallery shows.
    const sibling = document.querySelector<HTMLElement>(
      '[data-subagent-open-as-chat="sib-skill"]',
    );
    if (sibling === null) throw new Error("Expected the sibling's control");
    fireEvent.click(sibling);
    expect(viewCaptions()).toEqual(["sibling plot"]);
    expect(galleryUnits(openCard(messages, "sib-skill"), "plot")).toEqual([
      expect.objectContaining({ text: "sibling plot", owningChain: [] }),
    ]);

    // Back to the transcript: the view is gone.
    fireEvent.click(screen.getByTestId("subagent-chat-back"));
    expect(screen.queryByTestId("subagent-chat-view")).toBeNull();
  });
});
