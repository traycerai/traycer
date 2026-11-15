/**
 * The bot message box's Attach control through the REAL `BotMessageComposer`:
 * a pick lands where a paste does, a file the box cannot carry is refused
 * before anything reads it, and the control follows what the box can take and
 * send. Faked: the host's answer to the send, the runner host (the shared
 * bot-box one) and the toast library.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import type { ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  BotMessageComposer,
  BotMessageComposerUnavailable,
} from "@/components/bots/bot-message-composer";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import type { BotImageReach } from "@/hooks/bots/use-bot-send-version";
import { MAX_IMAGE_SOURCE_BYTES } from "@/hooks/composer/use-composer-paste";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import {
  BOT_ID,
  CHANNEL,
  IMAGE_B64,
  OWNER_LABEL,
  THREAD,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import {
  boxInput,
  NO_BOT_REPLY,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";

interface HeldSend {
  readonly request: BotConversationSendRequest;
  readonly answer: (response: BotConversationSendResponse) => void;
  readonly settled: Promise<void>;
}

const mocks = vi.hoisted(() => ({
  sends: [] as Array<HeldSend>,
  /** Whether a send is on its way: the mutation's `isPending`. */
  pending: false,
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
      const { promise, resolve } =
        Promise.withResolvers<BotConversationSendResponse>();
      mocks.sends.push({
        request,
        answer: resolve,
        settled: promise.then(() => undefined),
      });
      return promise;
    },
    isPending: mocks.pending,
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

const PNG_BYTES = Uint8Array.from(atob(IMAGE_B64), (char) =>
  char.charCodeAt(0),
);

const RESPONSE: BotConversationSendResponse = {
  messageId: "post-1",
  requestId: "request-1",
  delivery: "written",
  threadId: "thread-1",
};

const TEST_ID = "bot-channel-composer";
const IMAGES_ID = `${TEST_ID}-images`;
const NOT_AN_IMAGE = "Only PNG, JPEG, GIF and WebP images can be sent here.";

function Box(props: {
  readonly imageReach: BotImageReach;
  readonly sendable: boolean;
  readonly threadId: string | null;
}): ReactNode {
  const failure = useBotSendFailure();
  return (
    <BotTestRunnerHost>
      <BotMessageComposer
        botId={BOT_ID}
        botTitle="Tracy"
        conversationId={CHANNEL}
        threadId={props.threadId}
        announcementId={null}
        sendable={props.sendable}
        imageReach={props.imageReach}
        placeholder={OWNER_LABEL}
        label={OWNER_LABEL}
        testId={TEST_ID}
        failure={failure}
        edit={null}
        onEditEnd={() => undefined}
        onEditResume={() => undefined}
        seed={null}
        keptDraft={null}
        quote={null}
        reply={NO_BOT_REPLY}
        moved={null}
        notice={null}
        onSent={() => false}
      />
    </BotTestRunnerHost>
  );
}

function mount(imageReach: BotImageReach) {
  return render(<Box imageReach={imageReach} sendable threadId={null} />);
}

/** A picker's `accept` is a hint the person can lift with "All files". */
function newUser(): UserEvent {
  return userEvent.setup({ applyAccept: false });
}

function box(): HTMLElement {
  return boxInput(OWNER_LABEL);
}

function attachButton(): HTMLButtonElement {
  const element = screen.getByRole("button", { name: "Attach" });
  if (!(element instanceof HTMLButtonElement)) throw new Error("no Attach");
  return element;
}

function sendButton(): HTMLButtonElement {
  const element = screen.getByRole("button", { name: "Send" });
  if (!(element instanceof HTMLButtonElement)) throw new Error("no Send");
  return element;
}

function pickerInput(): HTMLInputElement {
  const input = screen
    .getByTestId(TEST_ID)
    .querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("the box has no file input");
  return input;
}

function pngFile(name: string): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

function pdfFile(name: string): File {
  return new File(["%PDF-1.7"], name, { type: "application/pdf" });
}

/** A file whose byte read is watched: the box refuses what it cannot carry before anything reads it. */
function unreadable(name: string, type: string) {
  const file = new File(["bytes"], name, { type });
  return { file, read: vi.spyOn(file, "arrayBuffer") };
}

/** The titles of the error toasts raised so far. */
function errorToasts(): ReadonlyArray<unknown> {
  return vi.mocked(toast.error).mock.calls.map(([message]) => message);
}

async function pick(
  user: UserEvent,
  ...files: ReadonlyArray<File>
): Promise<void> {
  await user.upload(pickerInput(), [...files]);
}

async function holdsImage(label: string): Promise<void> {
  expect(
    await screen.findByRole("button", { name: `Open ${label}` }),
  ).toBeTruthy();
}

function openButtons(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: /^Open Image#\d+:/ });
}

function lastSend(): HeldSend {
  const sent = mocks.sends.at(-1);
  if (sent === undefined) throw new Error("the box sent nothing");
  return sent;
}

async function answerLastSend(): Promise<void> {
  const sent = lastSend();
  await act(async () => {
    mocks.pending = false;
    sent.answer(RESPONSE);
    await sent.settled;
  });
}

beforeEach(() => {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
  mocks.sends.length = 0;
  mocks.pending = false;
  vi.mocked(toast.error).mockClear();
});

describe("<BotMessageComposer /> Attach", () => {
  it.each([
    ["channel", null],
    ["thread", THREAD],
  ])("is offered on the %s box", (_where, threadId) => {
    render(<Box imageReach="delivered" sendable threadId={threadId} />);

    expect(attachButton().disabled).toBe(false);
  });

  it("takes only the image types the bot's store carries", () => {
    mount("delivered");

    expect(pickerInput().getAttribute("accept")).toBe(
      "image/png,image/jpeg,image/gif,image/webp",
    );
  });

  it("holds a picked image in the strip as a paste does, and the send carries it", async () => {
    const user = newUser();
    mount("delivered");

    await pick(user, pngFile("shot.png"));
    await holdsImage("Image#1: shot.png");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    typeInto(box(), "What is this?{Enter}");

    expect(lastSend().request.attachments).toEqual([
      {
        b64content: IMAGE_B64,
        mediaType: "image/png",
        fileName: "shot.png",
        size: PNG_BYTES.byteLength,
      },
    ]);
    await answerLastSend();
  });

  it("refuses a picked file that is no image, attaches nothing and sends none", async () => {
    const user = newUser();
    mount("delivered");

    await pick(user, pdfFile("report.pdf"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(NOT_AN_IMAGE, expect.anything()),
    );
    expect(openButtons()).toHaveLength(0);
    expect(screen.queryByTestId(IMAGES_ID)).toBeNull();
    typeInto(box(), "Is CI green?{Enter}");
    expect("attachments" in lastSend().request).toBe(false);
    await answerLastSend();
  });

  it("attaches the image of a mixed pick and refuses the file once", async () => {
    const user = newUser();
    mount("delivered");

    await pick(user, pngFile("shot.png"), pdfFile("report.pdf"));

    await holdsImage("Image#1: shot.png");
    const refusals = vi
      .mocked(toast.error)
      .mock.calls.filter(([message]) => message === NOT_AN_IMAGE);
    expect(refusals).toHaveLength(1);
    expect(openButtons()).toHaveLength(1);
  });

  it("refuses a picked SVG with the box's sentence and never reads it", async () => {
    const user = newUser();
    mount("delivered");
    const { file: logo, read } = unreadable("logo.svg", "image/svg+xml");

    await pick(user, logo);

    await waitFor(() => expect(errorToasts()).toEqual([NOT_AN_IMAGE]));
    expect(read).not.toHaveBeenCalled();
    expect(openButtons()).toHaveLength(0);
  });

  it("refuses an oversized HEIC with the box's sentence, not the size refusal, and never reads it", async () => {
    const user = newUser();
    mount("delivered");
    const { file: scan, read } = unreadable("scan.heic", "image/heic");
    Object.defineProperty(scan, "size", { value: MAX_IMAGE_SOURCE_BYTES + 1 });

    await pick(user, scan);

    await waitFor(() => expect(errorToasts()).toEqual([NOT_AN_IMAGE]));
    expect(read).not.toHaveBeenCalled();
    expect(openButtons()).toHaveLength(0);
  });

  it("attaches the PNG of a pick that also holds an SVG, and never reads the SVG", async () => {
    const user = newUser();
    mount("delivered");
    const { file: logo, read } = unreadable("logo.svg", "image/svg+xml");

    await pick(user, pngFile("shot.png"), logo);

    await holdsImage("Image#1: shot.png");
    expect(errorToasts()).toEqual([NOT_AN_IMAGE]);
    expect(read).not.toHaveBeenCalled();
    expect(openButtons()).toHaveLength(1);
  });

  it("refuses a picked file with no type with the box's sentence and never reads it", async () => {
    const user = newUser();
    mount("delivered");
    const { file: untyped, read } = unreadable("mystery", "");

    await pick(user, untyped);

    await waitFor(() => expect(errorToasts()).toEqual([NOT_AN_IMAGE]));
    expect(read).not.toHaveBeenCalled();
    expect(openButtons()).toHaveLength(0);
  });

  it("is off while the box cannot send", () => {
    render(<Box imageReach="delivered" sendable={false} threadId={null} />);

    expect(attachButton().disabled).toBe(true);
  });

  it("is off while a send is on its way, and on again once it settles", async () => {
    mount("delivered");

    typeInto(box(), "Is CI green?{Enter}");
    expect(attachButton().disabled).toBe(true);

    await answerLastSend();
    expect(attachButton().disabled).toBe(false);
  });

  it("is offered wherever the box takes images, and not where the bot's host takes none", () => {
    const view = mount("held-back");
    expect(attachButton().disabled).toBe(false);

    view.rerender(<Box imageReach="none" sendable threadId={null} />);

    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
    expect(screen.getByTestId(TEST_ID).querySelector("input[type=file]")).toBe(
      null,
    );
  });

  it("is the next stop after the editor on Tab, and Enter on it opens the picker", async () => {
    const user = newUser();
    mount("delivered");
    const opened = vi
      .spyOn(pickerInput(), "click")
      .mockImplementation(() => undefined);

    await user.click(box());
    await user.tab();
    expect(document.activeElement).toBe(attachButton());
    await user.keyboard("{Enter}");

    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("is no Layout region, so it carries no region name", () => {
    mount("delivered");

    expect(attachButton().closest("[data-layout-region]")).toBeNull();
  });

  it("stays shown where the task composer's Attach is hidden in Layout", () => {
    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("attachImage", { shown: "hidden" });
    });

    mount("delivered");

    expect(attachButton().disabled).toBe(false);
  });
});

describe("<BotMessageComposerUnavailable /> Attach", () => {
  it("is drawn off, beside the Send that cannot send", () => {
    render(
      <BotMessageComposerUnavailable
        placeholder={OWNER_LABEL}
        label={OWNER_LABEL}
        reason="Tracy has no host yet."
        testId={TEST_ID}
      />,
    );

    expect(attachButton().disabled).toBe(true);
  });
});
