/**
 * The bot message box's images through the REAL `BotMessageComposer` and the
 * agent composer's real paste and drop adapter: a `File` dropped or pasted
 * lands in the strip, rides the send as `attachments`, and goes back with the
 * text where a send fails. Faked: the host's answer to the send, the runner
 * host's file-path resolution, the toast library, and the preparation
 * session's start, which a case holds open to see Send wait for it.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT_CONVERSATION_IMAGES_ONLY_TEXT,
  type BotConversationSendRequest,
  type BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";
import {
  BotMessageComposer,
  type BotComposerEdit,
} from "@/components/bots/bot-message-composer";
import type { ImagePreparationSession } from "@/lib/composer/composer-image-preparation";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import type { BotImageReach } from "@/hooks/bots/use-bot-send-version";
import { useKeptBoxDraft } from "@/hooks/bots/use-kept-box-draft";
import { MAX_IMAGE_SOURCE_BYTES } from "@/hooks/composer/use-composer-paste";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import {
  botBoxAttachments,
  botBoxContentOf,
  botBoxWire,
} from "@/lib/bots/bot-box-content";
import * as botBoxContent from "@/lib/bots/bot-box-content";
import {
  boxInput,
  boxText,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";

interface SendCallbacks {
  readonly resolve: (response: BotConversationSendResponse) => void;
  readonly reject: (error: Error) => void;
  readonly settled: Promise<void>;
}

const mocks = vi.hoisted(() => ({
  sends: [] as Array<{
    readonly request: BotConversationSendRequest;
    readonly callbacks: SendCallbacks;
  }>,
  /** Whether a send is on its way: the mutation's `isPending`. */
  pending: false,
  /** While set, a preparation waits for it before it starts. */
  preparationGate: null as Promise<void> | null,
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({
    mutateAsync: (request: BotConversationSendRequest) => {
      mocks.pending = true;
      const { promise, resolve, reject } =
        Promise.withResolvers<BotConversationSendResponse>();
      mocks.sends.push({
        request,
        callbacks: {
          resolve,
          reject,
          settled: promise.then(
            () => undefined,
            () => undefined,
          ),
        },
      });
      return promise;
    },
    isPending: mocks.pending,
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/composer/composer-image-preparation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/composer-image-preparation")
    >();
  return {
    ...actual,
    createComposerImagePreparationSession: (): ImagePreparationSession => {
      const session = actual.createComposerImagePreparationSession();
      return {
        prepare: async (args) => {
          if (mocks.preparationGate !== null) await mocks.preparationGate;
          return session.prepare(args);
        },
      };
    },
  };
});

/** A 1x1 PNG. */
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG_BYTES));

const RESPONSE: BotConversationSendResponse = {
  messageId: "post-1",
  requestId: "request-1",
  delivery: "written",
  threadId: "thread-1",
};

const TEST_ID = "bot-channel-composer";
const IMAGES_ID = `${TEST_ID}-images`;
const NOT_DELIVERED_ID = `${TEST_ID}-images-not-delivered`;
const SEND_FAILED_ID = `${TEST_ID}-send-failed`;
const CHANNEL = "conversation-channel";

const onSent =
  vi.fn<(response: BotConversationSendResponse, text: string) => boolean>();
const onEditEnd = vi.fn<() => void>();
const onEditResume = vi.fn<(edit: BotComposerEdit) => void>();

/** A runner host that resolves a dropped file to a path, as the desktop shell does. */
const FILE_DROPS: IFileDropHost = {
  resolveDroppedFilePaths: (files) =>
    Promise.resolve(files.map((file) => `/Users/tess/${file.name}`)),
  copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
  readNativeClipboardFilePaths: () => Promise.resolve([]),
};
const RUNNER_HOST = createFakeRunnerHost({ fileDrops: FILE_DROPS });

/**
 * The box with its owner's state: the real failure line, an edit that ends
 * and resumes as the box says, and optionally the real kept draft.
 */
function Box(props: {
  readonly imageReach: BotImageReach;
  readonly initialEdit: BotComposerEdit | null;
  readonly keepDraft: boolean;
}): ReactNode {
  const failure = useBotSendFailure();
  const [edit, setEdit] = useState<BotComposerEdit | null>(props.initialEdit);
  const kept = useKeptBoxDraft("bot-1", CHANNEL);
  return (
    <RunnerHostContext value={RUNNER_HOST}>
      <BotMessageComposer
        botId="bot-1"
        botTitle="Tracy"
        conversationId={CHANNEL}
        threadId={null}
        announcementId={null}
        sendable
        imageReach={props.imageReach}
        placeholder="Message Tracy"
        label="Message Tracy"
        testId={TEST_ID}
        failure={failure}
        edit={edit}
        onEditEnd={() => {
          onEditEnd();
          setEdit(null);
        }}
        onEditResume={(resumed) => {
          onEditResume(resumed);
          setEdit(resumed);
        }}
        seed={props.keepDraft ? kept.seed : null}
        keptDraft={props.keepDraft ? kept.keptDraft : null}
        quote={null}
        onSent={onSent}
      />
    </RunnerHostContext>
  );
}

interface MountOptions {
  readonly edit: BotComposerEdit | null;
  readonly keepDraft: boolean;
}

const PLAIN_BOX: MountOptions = { edit: null, keepDraft: false };

function mount(imageReach: BotImageReach, options: MountOptions): RenderResult {
  return render(
    <Box
      imageReach={imageReach}
      initialEdit={options.edit}
      keepDraft={options.keepDraft}
    />,
  );
}

function box(): HTMLElement {
  return boxInput("Message Tracy");
}

function sendButton(): HTMLButtonElement {
  const element = screen.getByRole("button", { name: "Send" });
  if (!(element instanceof HTMLButtonElement)) throw new Error("no Send");
  return element;
}

function imageFile(name: string, type: string): File {
  return new File([PNG_BYTES], name, { type });
}

/** What a browser hands a paste or a drop that carries `files`. */
interface FileTransfer {
  readonly files: ReadonlyArray<File>;
  readonly types: ReadonlyArray<string>;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly type: string;
    getAsFile: () => File | null;
  }>;
  getData: (type: string) => string;
}

function transferOf(...files: ReadonlyArray<File>): FileTransfer {
  return {
    files,
    types: ["Files"],
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    getData: () => "",
  };
}

/** Fires a paste of `files` into the box; `true` where the browser still has it to do. */
function pasteFiles(...files: ReadonlyArray<File>): boolean {
  return fireEvent.paste(box(), { clipboardData: transferOf(...files) });
}

function pastePlain(text: string): void {
  fireEvent.paste(box(), {
    clipboardData: {
      types: ["text/plain"],
      files: [],
      items: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

function pasteComposerContent(content: object): void {
  const value = JSON.stringify({
    schema: "traycer.composer-content",
    version: 1,
    content,
  });
  fireEvent.paste(box(), {
    clipboardData: {
      types: ["application/x-traycer-composer+json"],
      files: [],
      items: [],
      getData: (type: string) =>
        type === "application/x-traycer-composer+json" ? value : "",
    },
  });
}

function pasteHtml(html: string): void {
  fireEvent.paste(box(), {
    clipboardData: {
      types: ["text/html"],
      files: [],
      items: [],
      getData: (type: string) => (type === "text/html" ? html : ""),
    },
  });
}

function dropFiles(...files: ReadonlyArray<File>): boolean {
  const dataTransfer = transferOf(...files);
  fireEvent.dragEnter(box(), { dataTransfer });
  return fireEvent.drop(box(), { dataTransfer });
}

/** The images the strip holds, by the name each chip shows. */
function openButtons(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: /^Open Image#\d+:/ });
}

async function holdsImage(label: string): Promise<void> {
  expect(
    await screen.findByRole("button", { name: `Open ${label}` }),
  ).toBeTruthy();
}

function lastSend(): (typeof mocks.sends)[number] {
  const sent = mocks.sends.at(-1);
  if (sent === undefined) throw new Error("the box sent nothing");
  return sent;
}

async function settle(
  send: (typeof mocks.sends)[number],
  outcome: (callbacks: SendCallbacks) => void,
): Promise<void> {
  await act(async () => {
    mocks.pending = false;
    outcome(send.callbacks);
    await send.callbacks.settled;
  });
}

const refuse = (callbacks: SendCallbacks): void =>
  callbacks.reject(new Error("host refused the post"));

beforeEach(() => {
  onSent.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  mocks.sends.length = 0;
  mocks.pending = false;
  mocks.preparationGate = null;
  onSent.mockReset();
  onEditEnd.mockReset();
  onEditResume.mockReset();
  vi.mocked(toast.error).mockClear();
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {}, unsentBoxes: {} });
});

describe("<BotMessageComposer /> taking images", () => {
  it.each(["structured", "html"])(
    "skips a nameless %s slash chip and keeps adjacent text",
    (flavor) => {
      mount("delivered", PLAIN_BOX);
      if (flavor === "structured") {
        pasteComposerContent({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "kept " },
                { type: "slashCommand", attrs: {} },
                { type: "text", text: "after" },
              ],
            },
          ],
        });
      } else {
        pasteHtml(
          '<p>kept <span data-composer-slash-command="">/ignored</span>after</p>',
        );
      }
      expect(boxText("Message Tracy")).toBe("kept after");
      typeInto(box(), "{Enter}");
      expect(lastSend().request.text).toBe("kept after");
    },
  );

  it.each(["structured", "html"])(
    "keeps a %s slash chip as text after existing prose",
    (flavor) => {
      mount("delivered", PLAIN_BOX);
      typeInto(box(), "Use ");
      if (flavor === "structured") {
        pasteComposerContent({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "slashCommand", attrs: { name: "plan" } }],
            },
          ],
        });
      } else {
        pasteHtml(
          '<p><span data-composer-slash-command="" data-name="plan">/plan</span></p>',
        );
      }
      const expected = flavor === "structured" ? "Use\n\n/plan" : "Use /plan";
      expect(boxText("Message Tracy")).toBe(expected);
      typeInto(box(), "{Enter}");
      expect(lastSend().request.text).toBe(expected);
    },
  );

  it("accepts a drop over the footer where the overlay offers it", async () => {
    mount("delivered", PLAIN_BOX);
    typeInto(box(), "draft");
    const transfer = transferOf(imageFile("shot.png", "image/png"));
    fireEvent.dragEnter(sendButton(), { dataTransfer: transfer });
    expect(screen.getByText("Drop image to attach")).toBeTruthy();
    expect(fireEvent.drop(sendButton(), { dataTransfer: transfer })).toBe(
      false,
    );
    await holdsImage("Image#1: shot.png");
  });

  it.each(["> quoted text", "\\<@u-ann>", "**bold**\n> quote"])(
    "sends pasted Markdown literally: %s",
    (text) => {
      mount("delivered", PLAIN_BOX);
      pastePlain(text);
      expect(boxText("Message Tracy")).toBe(text);
      typeInto(box(), "{Enter}");
      expect(lastSend().request.text).toBe(text);
    },
  );

  it("shows the drop overlay while images are dragged over the box, and holds a dropped image in the strip", async () => {
    mount("delivered", PLAIN_BOX);
    const dataTransfer = transferOf(imageFile("shot.png", "image/png"));

    fireEvent.dragEnter(box(), { dataTransfer });
    expect(screen.getByText("Drop image to attach")).toBeTruthy();

    fireEvent.drop(box(), { dataTransfer });
    expect(screen.queryByText("Drop image to attach")).toBeNull();
    await holdsImage("Image#1: shot.png");
    expect(
      within(screen.getByTestId(IMAGES_ID)).getAllByRole("img"),
    ).toHaveLength(1);
  });

  it("holds a pasted image in the strip, and the paste is the box's to handle", async () => {
    mount("delivered", PLAIN_BOX);

    const left = pasteFiles(imageFile("clip.png", "image/png"));

    expect(left).toBe(false);
    await holdsImage("Image#1: clip.png");
    // Where the bot's host takes the images the strip says nothing of them.
    expect(screen.queryByTestId(NOT_DELIVERED_ID)).toBeNull();
  });

  it("drops an image from the strip, so the send does not carry it", async () => {
    const user = userEvent.setup();
    mount("delivered", PLAIN_BOX);
    pasteFiles(imageFile("first.png", "image/png"));
    await holdsImage("Image#1: first.png");
    pasteFiles(imageFile("second.png", "image/png"));
    await holdsImage("Image#2: second.png");
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    await user.click(
      screen.getByRole("button", { name: "Remove Image#1: first.png" }),
    );
    typeInto(box(), "look{Enter}");

    expect(lastSend().request.attachments?.map((a) => a.fileName)).toEqual([
      "second.png",
    ]);
  });
});

describe("<BotMessageComposer /> sending images", () => {
  it("reuses decoded attachments while only message text changes", async () => {
    const decode = vi.spyOn(botBoxContent, "botBoxAttachments");
    try {
      mount("delivered", PLAIN_BOX);
      pasteFiles(imageFile("shot.png", "image/png"));
      await holdsImage("Image#1: shot.png");
      await waitFor(() => expect(sendButton().disabled).toBe(false));
      decode.mockClear();

      typeInto(box(), "caption");
      expect(decode).not.toHaveBeenCalled();
      typeInto(box(), "{Enter}");
      expect(lastSend().request.attachments).toHaveLength(1);
    } finally {
      decode.mockRestore();
    }
  });

  it("carries each image's bytes, type, name and byte length on the request, and empties the box", async () => {
    const user = userEvent.setup();
    mount("delivered", PLAIN_BOX);
    pasteFiles(imageFile("shot.png", "image/png"));
    await holdsImage("Image#1: shot.png");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    typeInto(box(), "What is this?");

    await user.click(sendButton());

    const { request } = lastSend();
    expect(request.text).toBe("What is this?");
    expect(request.attachments).toEqual([
      {
        b64content: PNG_BASE64,
        mediaType: "image/png",
        fileName: "shot.png",
        size: PNG_BYTES.byteLength,
      },
    ]);
    expect(boxText("Message Tracy")).toBe("");
    expect(openButtons()).toHaveLength(0);
    expect(screen.queryByTestId(IMAGES_ID)).toBeNull();
    await settle(lastSend(), (callbacks) => callbacks.resolve(RESPONSE));
  });

  it("leaves the key off a send of text alone", async () => {
    mount("delivered", PLAIN_BOX);

    typeInto(box(), "Is CI green?{Enter}");

    expect("attachments" in lastSend().request).toBe(false);
    await settle(lastSend(), (callbacks) => callbacks.resolve(RESPONSE));
  });

  it("sends a box of images alone, under the text the wire keeps for it", async () => {
    const user = userEvent.setup();
    mount("delivered", PLAIN_BOX);
    expect(sendButton().disabled).toBe(true);

    pasteFiles(imageFile("shot.png", "image/png"));
    await holdsImage("Image#1: shot.png");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await user.click(sendButton());

    expect(lastSend().request.text).toBe(BOT_CONVERSATION_IMAGES_ONLY_TEXT);
    expect(lastSend().request.attachments).toHaveLength(1);
    await settle(lastSend(), (callbacks) => callbacks.resolve(RESPONSE));
  });

  it("keeps Send off for a box of images alone where the bot's host has not said it takes them, and says so", async () => {
    mount("held-back", PLAIN_BOX);

    pasteFiles(imageFile("shot.png", "image/png"));
    await holdsImage("Image#1: shot.png");

    expect(screen.getByTestId(NOT_DELIVERED_ID).textContent).toContain(
      "only your text will be sent",
    );
    expect(sendButton().disabled).toBe(true);
  });

  it("sends only the text where the bot's host has not said it takes images", async () => {
    mount("held-back", PLAIN_BOX);
    pasteFiles(imageFile("shot.png", "image/png"));
    await holdsImage("Image#1: shot.png");

    typeInto(box(), "Is CI green?");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    typeInto(box(), "{Enter}");

    expect(lastSend().request.text).toBe("Is CI green?");
    expect("attachments" in lastSend().request).toBe(false);
    await settle(lastSend(), (callbacks) => callbacks.resolve(RESPONSE));
  });

  it("holds Send while an image is still being prepared", async () => {
    const gate = Promise.withResolvers<void>();
    mocks.preparationGate = gate.promise;
    mount("delivered", PLAIN_BOX);
    typeInto(box(), "Look at this");
    expect(sendButton().disabled).toBe(false);

    pasteFiles(imageFile("slow.png", "image/png"));

    await waitFor(() => expect(sendButton().disabled).toBe(true));
    gate.resolve();
    await holdsImage("Image#1: slow.png");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });
});

describe("<BotMessageComposer /> against a host that takes no image", () => {
  it("takes no drop, no paste, shows no overlay and no strip, and leaves the box as it was", async () => {
    mount("none", PLAIN_BOX);
    typeInto(box(), "hello");
    const image = imageFile("shot.png", "image/png");
    const dataTransfer = transferOf(image);

    fireEvent.dragEnter(box(), { dataTransfer });
    fireEvent.dragOver(box(), { dataTransfer });
    expect(screen.queryByText("Drop image to attach")).toBeNull();
    fireEvent.drop(box(), { dataTransfer });
    pasteFiles(image);
    // Nothing is attached after the adapter would have had its turn.
    await act(async () => {});

    expect(openButtons()).toHaveLength(0);
    expect(screen.queryByTestId(IMAGES_ID)).toBeNull();
    expect(screen.queryByTestId(NOT_DELIVERED_ID)).toBeNull();
    expect(boxText("Message Tracy")).toBe("hello");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("<BotMessageComposer /> refusing what it cannot take", () => {
  it.each([
    ["oversize", btoa("a".repeat(5 * 1024 * 1024 + 1))],
    ["malformed", "not base64!"],
  ])(
    "refuses a %s copied image before it reaches the draft",
    (_kind, b64content) => {
      mount("delivered", PLAIN_BOX);
      pasteComposerContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "copy",
                  fileName: "shot.png",
                  mimeType: "image/png",
                  b64content,
                },
              },
            ],
          },
        ],
      });
      expect(openButtons()).toHaveLength(0);
      expect(toast.error).toHaveBeenCalled();
    },
  );

  const NOT_AN_IMAGE = "Only PNG, JPEG, GIF and WebP images can be sent here.";

  it("updates one refusal toast for several unreadable copied images", () => {
    mount("delivered", PLAIN_BOX);
    pasteComposerContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: ["a", "b"].map((id) => ({
            type: "imageAttachment",
            attrs: {
              id,
              fileName: `${id}.png`,
              mimeType: "image/png",
              b64content: "invalid base64!",
            },
          })),
        },
      ],
    });
    const refusals = vi
      .mocked(toast.error)
      .mock.calls.filter(
        ([message]) => message === "This copied image could not be read.",
      );
    expect(refusals).toHaveLength(2);
    expect(refusals[0]?.[1]?.id).toBe(refusals[1]?.[1]?.id);
  });

  it("refuses a file that is not an image with the agent composer's path toast, and attaches nothing", async () => {
    mount("delivered", PLAIN_BOX);

    dropFiles(new File(["notes"], "notes.txt", { type: "text/plain" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(NOT_AN_IMAGE, expect.anything()),
    );
    expect(openButtons()).toHaveLength(0);
    expect(boxText("Message Tracy")).toBe("");
  });

  it("refuses an image of a type the bot's store does not take", async () => {
    mount("delivered", PLAIN_BOX);

    pasteFiles(imageFile("scan.bmp", "image/bmp"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(NOT_AN_IMAGE, expect.anything()),
    );
    expect(openButtons()).toHaveLength(0);
  });

  it("refuses an image over the size the agent composer refuses, naming it", async () => {
    mount("delivered", PLAIN_BOX);
    const huge = imageFile("huge.png", "image/png");
    Object.defineProperty(huge, "size", { value: MAX_IMAGE_SOURCE_BYTES + 1 });

    pasteFiles(huge);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Image too large even after resizing.",
        expect.objectContaining({ description: "huge.png" }),
      ),
    );
    expect(openButtons()).toHaveLength(0);
  });

  it("refuses an image past the 20th, keeping the 20 it holds", async () => {
    mount("delivered", PLAIN_BOX);
    pasteFiles(
      ...Array.from({ length: 20 }, (_, index) =>
        imageFile(`shot-${String(index + 1)}.png`, "image/png"),
      ),
    );
    await holdsImage("Image#20: shot-20.png");
    expect(toast.error).not.toHaveBeenCalled();

    pasteFiles(imageFile("one-too-many.png", "image/png"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "A message carries at most 20 images.",
        expect.anything(),
      ),
    );
    expect(openButtons()).toHaveLength(20);
  });
});

describe("<BotMessageComposer /> a send that fails", () => {
  it("puts the text and the images back in the emptied box", async () => {
    mount("delivered", PLAIN_BOX);
    pasteFiles(imageFile("shot.png", "image/png"));
    await holdsImage("Image#1: shot.png");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    typeInto(box(), "What is this?{Enter}");
    expect(boxText("Message Tracy")).toBe("");
    expect(openButtons()).toHaveLength(0);

    await settle(lastSend(), refuse);

    expect(boxText("Message Tracy")).toBe("What is this?");
    await holdsImage("Image#1: shot.png");
    expect(screen.getByTestId(SEND_FAILED_ID)).toBeTruthy();
    // The returned draft is editable, and sending it again carries the same bytes.
    typeInto(box(), " please");
    await userEvent.setup().click(sendButton());
    expect(lastSend().request.text).toBe("What is this? please");
    expect(lastSend().request.attachments?.[0]?.b64content).toBe(PNG_BASE64);
  });

  it("hands an edit's chip and image bytes back with its text when the edit's send fails", async () => {
    const user = userEvent.setup();
    const editText = "Ask <@u-ann>";
    mount("delivered", {
      keepDraft: false,
      edit: {
        requestId: "request-failed",
        text: editText,
        content: botBoxContentOf(editText, () => "Ann"),
      },
    });
    pasteFiles(imageFile("shot.png", "image/png"));
    await holdsImage("Image#1: shot.png");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await user.click(sendButton());
    expect(lastSend().request.supersedes).toBe("request-failed");

    await settle(lastSend(), refuse);

    expect(onEditResume).toHaveBeenCalledTimes(1);
    const resumed = onEditResume.mock.calls[0]?.[0];
    if (resumed.content === null) throw new Error("edit lost its document");
    expect(resumed.requestId).toBe("request-failed");
    expect(resumed.text).toBe(editText);
    expect(botBoxWire(resumed.content)).toBe(editText);
    expect(botBoxAttachments(resumed.content)).toEqual([
      expect.objectContaining({
        fileName: "shot.png",
        mediaType: "image/png",
        b64content: PNG_BASE64,
      }),
    ]);
    expect(
      screen.getByTestId("bot-box-mention").getAttribute("data-token"),
    ).toBe("<@u-ann>");
    await holdsImage("Image#1: shot.png");
  });

  it("keeps the images with the text outside a box that is gone when nothing newer was kept", async () => {
    const view = mount("delivered", { edit: null, keepDraft: true });
    pasteFiles(imageFile("shot.png", "image/png"));
    await holdsImage("Image#1: shot.png");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    typeInto(box(), "What is this?{Enter}");
    expect(useBotDraftsStore.getState().threadBoxes["bot-1"]).toBeUndefined();
    view.unmount();

    await settle(lastSend(), refuse);

    const keptBox =
      useBotDraftsStore.getState().threadBoxes["bot-1"]?.[CHANNEL];
    expect(keptBox?.text).toBe("What is this?");
    expect(keptBox?.content).toBeTruthy();
    // The box opened again loads it back, bytes and all.
    mount("delivered", { edit: null, keepDraft: true });
    expect(boxText("Message Tracy")).toBe("What is this?");
    await holdsImage("Image#1: shot.png");
  });
});
