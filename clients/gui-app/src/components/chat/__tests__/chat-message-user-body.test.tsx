import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { useState, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { deriveA2AReceivedCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { UserMessageBody } from "@/components/chat/chat-message-user-body";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  buildComposerClipboardHtml,
  composerClipboardPlainText,
  parseComposerClipboardHtml,
} from "@/lib/composer/composer-clipboard";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatMessageUserActions } from "@/components/chat/chat-message";
import { useSetA2AReceivedOpen } from "@/stores/chats/a2a-open-store-context";
import {
  useChatCollapsibleTileInstanceId,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

const attachmentMocks = vi.hoisted(() => ({
  fetcher: vi.fn((_hash: string, _signal: AbortSignal) =>
    Promise.resolve(new Uint8Array([1, 2, 3])),
  ),
  hasBytes: vi.fn(() => true),
}));
const composerPickerMocks = vi.hoisted(() => ({
  useComposerPickerItems: vi.fn(),
}));

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
  useComposerPickerItems: composerPickerMocks.useComposerPickerItems,
}));

vi.mock(
  import("@/lib/attachments/use-attachment-blob-src"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      useEpicImageFetcher: () => attachmentMocks.fetcher,
      useEpicAttachmentBytesPresence: () => attachmentMocks.hasBytes,
    };
  },
);

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
    vi.restoreAllMocks();
    attachmentMocks.fetcher.mockReset();
    attachmentMocks.fetcher.mockImplementation((_hash, _signal) =>
      Promise.resolve(new Uint8Array([1, 2, 3])),
    );
    attachmentMocks.hasBytes.mockReset();
    attachmentMocks.hasBytes.mockReturnValue(true);
    composerPickerMocks.useComposerPickerItems.mockClear();
    useWorkspaceFoldersStore.setState({ folders: [] });
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

  it("uses inherited workspace roots for the inline edit skill picker", async () => {
    useWorkspaceFoldersStore.setState({ folders: ["/workspace/project"] });
    render(
      <TooltipProvider>
        <UserMessageBody
          actions={editingUserActions(INLINE_EDIT_INITIAL_CONTENT)}
          message={{
            ...plainUserMessage("Edit this message"),
            structuredContent: INLINE_EDIT_INITIAL_CONTENT,
          }}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(composerPickerMocks.useComposerPickerItems).toHaveBeenCalledWith(
        expect.objectContaining({
          harnessId: "claude",
          mentionRoots: ["/workspace/project"],
          isActive: true,
        }),
      );
    });
  });

  it("ignores populated workspace roots for the inline edit skill picker when global fallback is disabled", async () => {
    useWorkspaceFoldersStore.setState({ folders: ["/workspace/project"] });
    const actions = editingUserActions(INLINE_EDIT_INITIAL_CONTENT);
    const baseEditing = actions.editing;
    if (baseEditing === null) throw new Error("expected editing actions");
    render(
      <TooltipProvider>
        <UserMessageBody
          actions={{
            ...actions,
            editing: { ...baseEditing, fallbackToGlobalMentionRoots: false },
          }}
          message={{
            ...plainUserMessage("Edit this message"),
            structuredContent: INLINE_EDIT_INITIAL_CONTENT,
          }}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(composerPickerMocks.useComposerPickerItems).toHaveBeenCalledWith(
        expect.objectContaining({
          harnessId: "claude",
          mentionRoots: [],
          isActive: true,
        }),
      );
    });
  });

  it("adds multiple pasted images to the edit strip and submits base64 nodes", async () => {
    const onSubmit = vi.fn<(content: JsonContent) => void>();
    render(<InlineEditAttachmentHarness onSubmit={onSubmit} />);
    const editor = await screen.findByRole("textbox", { name: "Edit message" });
    const first = imageFile("first-paste.png", [1, 2, 3]);
    const second = imageFile("second-paste.png", [4, 5, 6]);

    fireEvent.paste(editor, {
      clipboardData: clipboardWithFiles([first, second]),
    });

    expect(
      await screen.findByRole("button", {
        name: "Open Image#1: first-paste.png",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Open Image#2: second-paste.png",
      }),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Image#2: second-paste.png",
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", {
          name: "Open Image#2: second-paste.png",
        }),
      ).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Send edit" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0];
    const images = collectImageAtoms(submitted);
    expect(images.map((image) => image.fileName)).toEqual(["first-paste.png"]);
    expect(images.every((image) => image.b64content !== null)).toBe(true);
    expect(images.every((image) => image.hash === null)).toBe(true);
  });

  it("blocks edit submission until a pasted image finishes reading", async () => {
    const delayedReader = installDelayedFileReader();
    const onSubmit = vi.fn<(content: JsonContent) => void>();
    render(<InlineEditAttachmentHarness onSubmit={onSubmit} />);
    const editor = await screen.findByRole("textbox", { name: "Edit message" });

    fireEvent.paste(editor, {
      clipboardData: clipboardWithFiles([
        imageFile("delayed.png", [16, 17, 18]),
      ]),
    });

    const send = screen.getByRole("button", { name: "Send edit" });
    expect(send.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();

    delayedReader.resolveNext("data:image/png;base64,EBES");
    await screen.findByRole("button", {
      name: "Open Image#1: delayed.png",
    });
    const readySend = screen.getByRole("button", { name: "Send edit" });
    expect(readySend.getAttribute("disabled")).toBeNull();
    fireEvent.click(readySend);

    const submitted = onSubmit.mock.calls[0][0];
    expect(collectImageAtoms(submitted)).toEqual([
      expect.objectContaining({
        fileName: "delayed.png",
        b64content: "EBES",
        hash: null,
      }),
    ]);
  });

  it("submits a synchronously validated rich paste immediately", async () => {
    const onSubmit = vi.fn<(content: JsonContent) => void>();
    render(<InlineEditAttachmentHarness onSubmit={onSubmit} />);
    const editor = await screen.findByRole("textbox", { name: "Edit message" });
    const content = hashOnlyInlineEditContent();
    const html = buildComposerClipboardHtml(
      content,
      composerClipboardPlainText(content),
    );

    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/html"],
        getData: (type: string) => (type === "text/html" ? html : ""),
      },
    });

    expect(attachmentMocks.hasBytes).toHaveBeenCalledWith("same-epic-hash");
    const readySend = screen.getByRole("button", { name: "Send edit" });
    expect(readySend.getAttribute("disabled")).toBeNull();
    fireEvent.click(readySend);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(collectImageAtoms(onSubmit.mock.calls[0][0])).toEqual([
      expect.objectContaining({
        id: "rich-paste",
        hash: "same-epic-hash",
        b64content: null,
      }),
    ]);
  });

  it("adds a dropped image to the inline edit attachment strip", async () => {
    render(<InlineEditAttachmentHarness onSubmit={() => undefined} />);
    const editor = await screen.findByRole("textbox", { name: "Edit message" });
    const dropped = imageFile("dropped.png", [7, 8, 9]);

    fireEvent.drop(editor, {
      dataTransfer: dataTransferWithFiles([dropped]),
    });

    expect(
      await screen.findByRole("button", {
        name: "Open Image#1: dropped.png",
      }),
    ).not.toBeNull();
  });

  it("opens the image picker and attaches its selected file", async () => {
    const inputClick = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    const view = render(
      <InlineEditAttachmentHarness onSubmit={() => undefined} />,
    );
    await screen.findByRole("textbox", { name: "Edit message" });

    fireEvent.click(screen.getByRole("button", { name: "Attach image" }));
    expect(inputClick).toHaveBeenCalledTimes(1);

    const input =
      view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("expected inline edit image input");
    fireEvent.change(input, {
      target: { files: [imageFile("picked.png", [10, 11, 12])] },
    });

    expect(
      await screen.findByRole("button", {
        name: "Open Image#1: picked.png",
      }),
    ).not.toBeNull();
  });

  it("discards an image read that resolves after edit cancellation", async () => {
    const delayedReader = installDelayedFileReader();
    render(<InlineEditAttachmentHarness onSubmit={() => undefined} />);
    const editor = await screen.findByRole("textbox", { name: "Edit message" });

    fireEvent.paste(editor, {
      clipboardData: clipboardWithFiles([
        imageFile("discarded.png", [13, 14, 15]),
      ]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen edit" }));
    await screen.findByRole("textbox", { name: "Edit message" });

    delayedReader.resolveNext("data:image/png;base64,DQ4P");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(screen.queryByRole("button", { name: /Open Image#/ })).toBeNull();
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
    stopped: null,
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
      fallbackToGlobalMentionRoots: true,
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

const INLINE_EDIT_INITIAL_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Edit this message" }],
    },
  ],
};

function hashOnlyInlineEditContent(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "rich-paste",
              fileName: "rich-paste.png",
              b64content: null,
              hash: "same-epic-hash",
              mimeType: "image/png",
              size: 3,
            },
          },
          { type: "text", text: " pasted" },
        ],
      },
    ],
  };
}

function InlineEditAttachmentHarness(props: {
  readonly onSubmit: (content: JsonContent) => void;
}): ReactNode {
  const [editing, setEditing] = useState(true);
  const [content, setContent] = useState(INLINE_EDIT_INITIAL_CONTENT);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setContent(INLINE_EDIT_INITIAL_CONTENT);
          setEditing(true);
        }}
      >
        Reopen edit
      </button>
    );
  }
  const actions = editingUserActions(INLINE_EDIT_INITIAL_CONTENT);
  const baseEditing = actions.editing;
  if (baseEditing === null) throw new Error("expected editing actions");
  return (
    <TooltipProvider>
      <UserMessageBody
        message={{
          ...plainUserMessage("Edit this message"),
          structuredContent: INLINE_EDIT_INITIAL_CONTENT,
        }}
        actions={{
          ...actions,
          editing: {
            ...baseEditing,
            initialContent: INLINE_EDIT_INITIAL_CONTENT,
            currentContent: content,
            canSubmit: true,
            onSnapshot: (nextContent) => setContent(nextContent),
            onSubmit: () => props.onSubmit(content),
            onCancel: () => {
              setContent(INLINE_EDIT_INITIAL_CONTENT);
              setEditing(false);
            },
          },
        }}
      />
    </TooltipProvider>
  );
}

function imageFile(name: string, bytes: ReadonlyArray<number>): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function clipboardWithFiles(files: ReadonlyArray<File>) {
  return {
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    types: ["Files"],
    getData: () => "",
  };
}

function dataTransferWithFiles(files: ReadonlyArray<File>) {
  return {
    files,
    items: [],
    types: ["Files"],
    dropEffect: "none",
    getData: () => "",
  };
}

interface DelayedFileReaderControl {
  readonly resolveNext: (dataUrl: string) => void;
}

function installDelayedFileReader(): DelayedFileReaderControl {
  const pending: FileReader[] = [];
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (
    this: FileReader,
    _blob: Blob,
  ) {
    pending.push(this);
  });
  return {
    resolveNext: (dataUrl) => {
      const reader = pending.shift();
      if (reader === undefined) throw new Error("expected pending file read");
      Object.defineProperty(reader, "result", {
        configurable: true,
        value: dataUrl,
      });
      reader.dispatchEvent(new ProgressEvent("load"));
    },
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
