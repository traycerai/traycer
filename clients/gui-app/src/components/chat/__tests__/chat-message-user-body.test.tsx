import "../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { deriveA2AReceivedCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { UserMessageBody } from "@/components/chat/chat-message-user-body";
import { TooltipProvider } from "@/components/ui/tooltip";
import { parseComposerClipboardHtml } from "@/lib/composer/composer-clipboard";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatMessageUserActions } from "@/components/chat/chat-message";
import { useSetA2AReceivedOpen } from "@/stores/chats/a2a-open-store-context";
import {
  useChatCollapsibleTileInstanceId,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";

function render(ui: ReactNode) {
  return rtlRender(
    <ChatExpansionTestProviders tileInstanceId="user-body-test-tile">
      {ui}
    </ChatExpansionTestProviders>,
  );
}

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: (artifactId: string | null) =>
    artifactId === "agent-sender-1"
      ? {
          id: "agent-sender-1",
          parentId: null,
          title: "Review Agent",
          hostId: "host-1",
        }
      : null,
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));

interface OpenReceivedA2AButtonProps {
  readonly label: string;
  readonly messageId: string;
}

function OpenReceivedA2AButton(props: OpenReceivedA2AButtonProps) {
  const setOpen = useSetA2AReceivedOpen();
  return (
    <button type="button" onClick={() => setOpen(props.messageId, true)}>
      {props.label}
    </button>
  );
}

interface ForceReceivedA2AButtonProps {
  readonly label: string;
  readonly messageId: string;
}

function ForceReceivedA2AButton(props: ForceReceivedA2AButtonProps) {
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const key = deriveA2AReceivedCollapsibleKey(tileInstanceId, props.messageId);
  return (
    <button type="button" onClick={() => setFindForcedOpen(key, true)}>
      {props.label}
    </button>
  );
}

const AGENT_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Investigate this failure." }],
    },
  ],
};

const STRUCTURED_USER_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "slashCommand", attrs: { commandName: "implement" } },
        { type: "text", text: " preserve " },
        {
          type: "mention",
          attrs: {
            contextType: "file",
            path: "src/app.tsx",
            relPath: "src/app.tsx",
            pathKind: "file",
          },
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "bullet one" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "bullet two" }],
            },
          ],
        },
      ],
    },
  ],
};

const STRUCTURED_IMAGE_USER_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "slashCommand", attrs: { commandName: "plan" } },
        { type: "text", text: " can you see this " },
        imageNode("img-1", "first.png"),
        { type: "text", text: " and this " },
        imageNode("img-2", "second.png"),
      ],
    },
  ],
};

describe("<UserMessageBody /> agent messages", () => {
  afterEach(() => {
    cleanup();
  });

  it("reveals the action chip for keyboard focus", () => {
    render(
      <UserMessageBody
        actions={null}
        message={plainUserMessage("Investigate this failure.")}
      />,
    );

    const actionChip = screen.getByLabelText("Copy message").parentElement;
    expect(actionChip?.className).toContain(
      "group-focus-within/user-message:opacity-100",
    );
    expect(actionChip?.className).toContain("focus-within:opacity-100");
  });

  it("toggles a Show more affordance only when the prompt overflows", () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 600,
    });

    try {
      render(
        <UserMessageBody
          actions={null}
          message={plainUserMessage("A very tall prompt.")}
        />,
      );

      const toggle = screen.getByRole("button", { name: "Show more" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(toggle);

      const collapse = screen.getByRole("button", { name: "Show less" });
      expect(collapse.getAttribute("aria-expanded")).toBe("true");
    } finally {
      if (scrollHeight === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      } else {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          scrollHeight,
        );
      }
    }
  });

  it("omits the Show more affordance for short prompts", () => {
    const { container } = render(
      <UserMessageBody
        actions={null}
        message={plainUserMessage("A short prompt.")}
      />,
    );

    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(container.querySelector("[data-quotable]")).toBeNull();
  });

  it("renders compact image attachment thumbnails that still open", () => {
    render(
      <UserMessageBody
        actions={null}
        message={{
          ...plainUserMessage("Inspect this screenshot."),
          attachments: [
            {
              kind: "image",
              hash: null,
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
              name: "screenshot.png",
              size: 128,
            },
          ],
        }}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open Image#1: screenshot.png",
    });
    expect(trigger.className).toContain("size-12");
    expect(trigger.className).not.toContain("size-24");
    expect(
      trigger.querySelector('[data-user-message-image-badge="1"]'),
    ).not.toBeNull();
  });

  it("renders submitted image references inline with matching thumbnail order", () => {
    render(
      <UserMessageBody
        actions={null}
        message={{
          ...plainUserMessage("fallback text"),
          structuredContent: STRUCTURED_IMAGE_USER_CONTENT,
          attachments: [
            imageAttachment("first.png"),
            imageAttachment("second.png"),
          ],
        }}
      />,
    );

    expect(screen.getByText("/plan")).not.toBeNull();
    expect(screen.getByText("Image#1")).not.toBeNull();
    expect(screen.getByText("Image#2")).not.toBeNull();
    expect(screen.getByLabelText("Attached Image#1: first.png")).not.toBeNull();
    expect(
      screen.getByLabelText("Attached Image#2: second.png"),
    ).not.toBeNull();
    expect(screen.getByLabelText("Open Image#1: first.png")).not.toBeNull();
    expect(screen.getByLabelText("Open Image#2: second.png")).not.toBeNull();
    const display = screen
      .getByLabelText("Attached Image#2: second.png")
      .closest("[data-user-message-display]");
    expect(display?.className).toContain("max-w-[min(100%,48rem)]");
    expect(display?.className).not.toContain("max-w-[85%]");
  });

  it("keeps image reference labels coherent when a user message enters edit mode", async () => {
    const message = {
      ...plainUserMessage("fallback text"),
      structuredContent: STRUCTURED_IMAGE_USER_CONTENT,
      attachments: [
        imageAttachment("first.png"),
        imageAttachment("second.png"),
      ],
    };
    const actions = editingUserActions(STRUCTURED_IMAGE_USER_CONTENT);
    const view = render(<UserMessageBody actions={null} message={message} />);

    expect(screen.getByLabelText("Attached Image#1: first.png")).not.toBeNull();

    view.rerender(
      <ChatExpansionTestProviders tileInstanceId="user-body-test-tile">
        <TooltipProvider>
          <UserMessageBody actions={actions} message={message} />
        </TooltipProvider>
      </ChatExpansionTestProviders>,
    );

    await screen.findByLabelText("Attached Image#1: first.png");
    expect(
      screen.getByLabelText("Attached Image#2: second.png"),
    ).not.toBeNull();
    expect(screen.getByLabelText("Open Image#1: first.png")).not.toBeNull();
    expect(screen.getByLabelText("Open Image#2: second.png")).not.toBeNull();
  });

  it("renders received agent messages as an expandable A2A card", () => {
    render(
      <UserMessageBody
        actions={null}
        message={agentMessage("Investigate this failure.")}
      />,
    );

    expect(screen.getByText("Received message")).toBeTruthy();
    expect(screen.getByText("Review Agent")).toBeTruthy();
    expect(screen.getByText(/Investigate this failure/)).toBeTruthy();
    expect(screen.queryByText("Message")).toBeNull();
    expect(screen.queryByText("reply expected")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Received message/ }));

    expect(screen.getByText("Open sending agent")).toBeTruthy();
    expect(screen.getByText("reply expected")).toBeTruthy();
    expect(screen.getByText("Message")).toBeTruthy();
    expect(
      screen
        .getByText("Investigate this failure.")
        .closest(".md-prose")
        ?.hasAttribute("data-quotable"),
    ).toBe(false);
  });

  it("opens received A2A cards through the provider store", () => {
    const message = agentMessage("Investigate this externally opened card.");
    render(
      <>
        <OpenReceivedA2AButton
          label="Open received A2A"
          messageId={message.id}
        />
        <UserMessageBody actions={null} message={message} />
      </>,
    );

    expect(screen.queryByText("Open sending agent")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open received A2A" }));

    expect(screen.getByText("Open sending agent")).toBeTruthy();
    expect(screen.getByText("Message")).toBeTruthy();
  });

  it("opens received A2A cards through find-force and releases on manual collapse", () => {
    const message = agentMessage("Investigate this find-forced card.");
    render(
      <>
        <ForceReceivedA2AButton
          label="Force received A2A"
          messageId={message.id}
        />
        <UserMessageBody actions={null} message={message} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Force received A2A" }));

    expect(
      screen.getByRole("button", { name: "Open sending agent" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Received message/ }));

    expect(
      screen.queryByRole("button", { name: "Open sending agent" }),
    ).toBeNull();
  });

  it("copies structured user messages as rich composer clipboard content", async () => {
    const clipboard = installRichClipboardMock();
    try {
      render(
        <TooltipProvider>
          <UserMessageBody
            actions={null}
            message={{
              ...plainUserMessage("merged fallback"),
              structuredContent: STRUCTURED_USER_CONTENT,
            }}
          />
        </TooltipProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

      await waitFor(() => {
        expect(clipboard.write).toHaveBeenCalledTimes(1);
      });
      const payload = clipboard.payloads[0];
      expect(payload).toBeDefined();
      const html = await payload["text/html"].text();
      const plainText = await payload["text/plain"].text();
      expect(parseComposerClipboardHtml(html)).toEqual(STRUCTURED_USER_CONTENT);
      expect(plainText).toBe(
        [
          "/implement preserve @src/app.tsx",
          "",
          "- bullet one",
          "- bullet two",
        ].join("\n"),
      );
      expect(clipboard.writeText).not.toHaveBeenCalled();
    } finally {
      clipboard.restore();
    }
  });
});

function agentMessage(content: string): ChatMessageModel {
  return {
    id: "message-1",
    role: "user",
    content,
    segments: [],
    structuredContent: AGENT_CONTENT,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    persistentMessageId: "message-1",
    senderLabel: "Review Agent",
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: {
      agentId: "agent-sender-1",
      senderTitle: "Review Agent",
      expectReply: true,
      responseId: "response-1",
    },
    agentMessage: {
      kind: "agent",
      content: AGENT_CONTENT,
      fromAgentId: "agent-sender-1",
      senderTitle: "Review Agent",
      senderHarnessId: "codex",
      reply: { expectsReply: true, responseId: "response-1" },
    },
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function plainUserMessage(content: string): ChatMessageModel {
  return {
    ...agentMessage(content),
    senderLabel: "You",
    agentSenderInfo: null,
    agentMessage: null,
  };
}

function imageNode(id: string, fileName: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id,
      fileName,
      b64content: id,
      mimeType: "image/png",
      size: id.length,
    },
  };
}

function imageAttachment(name: string) {
  return {
    kind: "image" as const,
    hash: null,
    mediaType: "image/png",
    dataUrl: "data:image/png;base64,aW1hZ2U=",
    name,
    size: 128,
  };
}

function editingUserActions(content: JsonContent): ChatMessageUserActions {
  return {
    type: "user",
    enabled: true,
    confirmingDelete: false,
    editing: {
      initialContent: content,
      currentContent: content,
      pending: false,
      canSubmit: false,
      slashProviderId: "claude",
      mentionRoots: [],
      currentEpicId: "epic-1",
      onSnapshot: () => undefined,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    },
    onEdit: () => undefined,
    onDeleteRequest: () => undefined,
    onDeleteConfirm: () => undefined,
    onDeleteCancel: () => undefined,
  };
}

interface RichClipboardMock {
  readonly payloads: Record<string, Blob>[];
  readonly write: Mock<(items: ClipboardItem[]) => Promise<void>>;
  readonly writeText: Mock<(value: string) => Promise<void>>;
  readonly restore: () => void;
}

function installRichClipboardMock(): RichClipboardMock {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
  const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ClipboardItem",
  );
  const payloads: Record<string, Blob>[] = [];
  class MockClipboardItem {
    constructor(items: Record<string, Blob>) {
      payloads.push(items);
    }
  }
  const write = vi.fn((_items: ClipboardItem[]) => Promise.resolve());
  const writeText = vi.fn((_value: string) => Promise.resolve());
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    writable: true,
    value: MockClipboardItem,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { write, writeText },
  });

  return {
    payloads,
    write,
    writeText,
    restore: () => {
      restoreProperty(globalThis, "ClipboardItem", clipboardItemDescriptor);
      restoreProperty(navigator, "clipboard", clipboardDescriptor);
    },
  };
}

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
}
