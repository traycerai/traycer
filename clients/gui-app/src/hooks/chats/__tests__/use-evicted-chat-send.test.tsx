import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  type RenderHookResult,
} from "@testing-library/react";
import { toast } from "sonner";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HydrateChatResponse } from "@traycer/protocol/host/epic/chat-hydration";
import type { RpcErrorCode } from "@traycer/protocol/framework/versioned-rpc-types";
import type { UserMessageSender } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { Toaster } from "@/components/ui/sonner";
import {
  __resetComposerContentImageRootsForTests,
  composerContentImageRootHashes,
} from "@/lib/composer/composer-content-image-roots";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => requireTeamHostClient(),
}));

import {
  useEvictedChatSend,
  type EvictedChatSend,
  type ParkedEvictedSend,
} from "@/hooks/chats/use-evicted-chat-send";
import { useChatContinuingOnItsHost } from "@/lib/chats/chat-continuing-on-host";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const CHAT = { hostId: "host-chat", epicId: "epic-1", chatId: "chat-1" };
const SENDER: UserMessageSender = { type: "user", userId: "user-1" };
const HASH = "a".repeat(64);

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** A message with an image held only by the parked send. */
const IMAGE_CONTENT: JsonContent = {
  type: "doc",
  content: [
    ...(MESSAGE_CONTENT.content ?? []),
    {
      type: "imageAttachment",
      attrs: {
        id: "img-1",
        fileName: "screenshot.png",
        mimeType: "image/png",
        size: 128,
        hash: HASH,
      },
    },
  ],
};

const ANNOTATION: BrowserAnnotationRecord = {
  kind: "browser-annotation",
  annotationId: "annotation-1",
  tabId: "tab-1",
  sessionId: "session-1",
  origin: "https://example.test",
  pageUrl: "https://example.test/page",
  pageTitle: "Example",
  source: {
    kind: "browser",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.test",
    pageUrl: "https://example.test/page",
    pageTitle: "Example",
  },
  capturedAt: 1,
  comment: "this button",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "crop.png",
  imageHash: "c".repeat(64),
  droppedElementCount: 0,
};

function submission(
  content: JsonContent,
  annotations: ReadonlyArray<BrowserAnnotationRecord>,
): ChatComposerSubmitInput {
  return {
    content,
    contentText: "fix the login bug",
    attachments: [],
    settings: PICKED_SETTINGS,
    deliveryPolicy: "auto",
    restartConfirmed: false,
    restore: { content, browserAnnotations: annotations },
  };
}

const INPUT = submission(IMAGE_CONTENT, [ANNOTATION]);
const SECOND_CONTENT = textDoc("then update the tests");
const SECOND_INPUT = submission(SECOND_CONTENT, []);

const SEND_FAILED = "Couldn't send this message.";

interface Deferred {
  readonly resolve: (response: HydrateChatResponse) => void;
  readonly reject: (error: unknown) => void;
}

const hydrates: Deferred[] = [];

function refusal(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "refused",
    requestId: "req-1",
    method: "epic.hydrateChat",
    fatalDetails: null,
  });
}

interface Props {
  readonly served: boolean;
  readonly held: boolean;
}

type SendRender = RenderHookResult<EvictedChatSend, Props>;

function mount(initial: Props): {
  readonly send: SendRender;
  readonly hold: RenderHookResult<boolean, undefined>;
} {
  const page = mountTeamPage(poolSource("owner"), {
    "epic.hydrateChat": () =>
      new Promise<HydrateChatResponse>((resolve, reject) => {
        hydrates.push({ resolve, reject });
      }),
  });
  // Outside the hook's tree, so a toast the unmount raises still shows.
  render(<Toaster />);
  const send = renderHook(
    (props: Props) =>
      useEvictedChatSend({
        epicId: CHAT.epicId,
        chatId: CHAT.chatId,
        hostId: CHAT.hostId,
        ...props,
      }),
    { wrapper: page.Wrapper, initialProps: initial },
  );
  // A second observer that outlives the first one's unmount.
  const hold = renderHook(() => useChatContinuingOnItsHost(CHAT));
  return { send, hold };
}

function answer(index: number, settle: (deferred: Deferred) => void): void {
  const deferred = hydrates.at(index);
  if (deferred === undefined) throw new Error("no hydrate request");
  settle(deferred);
}

function park(
  send: SendRender,
  ...inputs: readonly ChatComposerSubmitInput[]
): void {
  act(() => {
    for (const input of inputs) send.result.current.park(input, SENDER);
  });
}

/** Parks `inputs`, then lets the host's one request land. */
async function parkAndHydrate(
  send: SendRender,
  ...inputs: readonly ChatComposerSubmitInput[]
): Promise<void> {
  park(send, ...inputs);
  await vi.waitFor(() => expect(hydrates).toHaveLength(1));
  await act(async () => {
    answer(0, (d) => d.resolve({ outcome: "hydrated" }));
    await Promise.resolve();
  });
}

function draftOf(chatId: string) {
  return useComposerDraftStore.getState().drafts[chatId];
}

function take(send: SendRender): readonly ParkedEvictedSend[] {
  let taken: readonly ParkedEvictedSend[] = [];
  act(() => {
    taken = send.result.current.take();
  });
  return taken;
}

function settle(
  send: SendRender,
  parked: ParkedEvictedSend | undefined,
  accepted: boolean,
): void {
  if (parked === undefined) throw new Error("nothing was parked");
  act(() => send.result.current.settle(parked, accepted));
}

/** Whether a parked send still holds the image: a restored draft roots it too. */
function imageRootHeld(): boolean {
  return composerContentImageRootHashes().includes(HASH);
}

beforeEach(() => {
  hydrates.length = 0;
  useComposerDraftStore.setState({ drafts: {} });
});
afterEach(() => {
  cleanup();
  toast.dismiss();
  __resetComposerContentImageRootsForTests();
});

describe("useEvictedChatSend", () => {
  it("lists parked messages oldest first as full pending rows and asks the host once", async () => {
    const { send } = mount({ served: false, held: false });
    expect(send.result.current.parks).toBe(false);

    park(send, INPUT, SECOND_INPUT);

    const { parked } = send.result.current;
    expect(parked.map((entry) => entry.input)).toEqual([INPUT, SECOND_INPUT]);
    expect(parked[0]?.row).toMatchObject({
      content: INPUT.content,
      attachments: INPUT.attachments,
      sender: SENDER,
      settings: PICKED_SETTINGS,
      restore: INPUT.restore,
      deliveryPolicy: "auto",
    });
    expect(parked[0]?.row.clientActionId).not.toBe(
      parked[1]?.row.clientActionId,
    );
    expect(send.result.current.parks).toBe(true);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));

    await act(async () => {
      answer(0, (d) => d.resolve({ outcome: "hydrated" }));
      await Promise.resolve();
    });
    expect(hydrates).toHaveLength(1);
  });

  it("hands parked sends over one at a time and keeps the next ready while one is unsettled", async () => {
    const { send, hold } = mount({ served: true, held: true });
    park(send, INPUT, SECOND_INPUT);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));
    expect(send.result.current.ready).toBe(false);

    await act(async () => {
      answer(0, (d) => d.resolve({ outcome: "hydrated" }));
      await Promise.resolve();
    });

    expect(send.result.current.ready).toBe(true);
    expect(hold.result.current).toBe(true);
    const [first] = take(send);
    expect(first.input).toEqual(INPUT);
    expect(send.result.current.take()).toEqual([]);
    expect(send.result.current.parked.map((entry) => entry.input)).toEqual([
      INPUT,
      SECOND_INPUT,
    ]);
    expect(send.result.current.ready).toBe(true);

    settle(send, first, true);
    const [second] = take(send);
    expect(second.input).toEqual(SECOND_INPUT);
    expect(send.result.current.take()).toEqual([]);
    settle(send, second, true);
    expect(send.result.current.parked).toEqual([]);
  });

  it("roots a parked message's images until it is accepted", async () => {
    const { send } = mount({ served: true, held: true });
    await parkAndHydrate(send, INPUT);
    expect(landingLiveImageRootHashes().has(HASH)).toBe(true);
    expect(imageRootHeld()).toBe(true);

    const [sent] = take(send);
    expect(imageRootHeld()).toBe(true);
    settle(send, sent, true);

    expect(send.result.current.parked).toEqual([]);
    expect(imageRootHeld()).toBe(false);
    expect(landingLiveImageRootHashes().has(HASH)).toBe(false);
    expect(draftOf(CHAT.chatId)).toBeUndefined();
  });

  it("puts a message the session did not accept back in the composer with its annotations and toasts", async () => {
    const { send } = mount({ served: true, held: true });
    await parkAndHydrate(send, INPUT);
    const [sent] = take(send);

    settle(send, sent, false);

    expect(send.result.current.parked).toEqual([]);
    expect(draftOf(CHAT.chatId)?.content).toEqual(INPUT.content);
    expect(draftOf(CHAT.chatId)?.browserAnnotations).toEqual([ANNOTATION]);
    expect(await screen.findByText(SEND_FAILED)).toBeTruthy();
    expect(imageRootHeld()).toBe(false);
  });

  it("leaves a newer draft alone and quotes the message in a retained toast", async () => {
    const { send } = mount({ served: true, held: true });
    await parkAndHydrate(send, INPUT);
    const newer = textDoc("a newer message");
    act(() => {
      useComposerDraftStore.getState().setSnapshot(CHAT.chatId, newer, null);
    });
    const [sent] = take(send);

    settle(send, sent, false);

    expect(send.result.current.parked).toEqual([]);
    expect(draftOf(CHAT.chatId)?.content).toEqual(newer);
    expect(draftOf(CHAT.chatId)?.browserAnnotations).toEqual([]);
    expect(
      await screen.findByText(/It was not put back in the composer/),
    ).toBeTruthy();
    expect(screen.getByText(/fix the login bug/)).toBeTruthy();
    expect(screen.queryByText(SEND_FAILED)).toBeNull();
    expect(
      toast
        .getToasts()
        .flatMap((shown) => ("duration" in shown ? [shown.duration] : [])),
    ).toContain(Number.POSITIVE_INFINITY);
    expect(imageRootHeld()).toBe(false);
  });

  it("puts the first of two failed messages back and quotes the second", async () => {
    const { send } = mount({ served: true, held: true });
    await parkAndHydrate(send, INPUT, SECOND_INPUT);
    const [first] = take(send);
    expect(send.result.current.take()).toEqual([]);

    settle(send, first, false);
    const [second] = take(send);
    expect(second.input).toEqual(SECOND_INPUT);
    settle(send, second, false);

    expect(send.result.current.parked).toEqual([]);
    expect(draftOf(CHAT.chatId)?.content).toEqual(INPUT.content);
    expect(
      await screen.findByText(/It was not put back in the composer/),
    ).toBeTruthy();
    expect(screen.getByText(/then update the tests/)).toBeTruthy();
  });

  it.each(["CHAT_EVICTED_UNREACHABLE", "CHAT_EVICTED_HEAD_MOVED"] as const)(
    "puts the text back and toasts once on %s, and keeps parking after the pool stops serving",
    async (code) => {
      const { send } = mount({ served: true, held: true });
      park(send, INPUT);
      await vi.waitFor(() => expect(hydrates).toHaveLength(1));

      await act(async () => {
        answer(0, (d) => d.reject(refusal(code)));
        await Promise.resolve();
      });

      expect(await screen.findAllByText(SEND_FAILED)).toHaveLength(1);
      expect(draftOf(CHAT.chatId)?.content).toEqual(INPUT.content);
      expect(send.result.current.parked).toEqual([]);
      expect(imageRootHeld()).toBe(false);

      send.rerender({ served: false, held: false });
      expect(send.result.current.parks).toBe(true);

      park(send, SECOND_INPUT);
      await vi.waitFor(() => expect(hydrates).toHaveLength(2));
      await act(async () => {
        answer(1, (d) => d.resolve({ outcome: "hydrated" }));
        await Promise.resolve();
      });
      const [sent] = take(send);
      expect(send.result.current.parks).toBe(true);
      settle(send, sent, true);
      expect(send.result.current.parks).toBe(false);
    },
  );

  it("puts the text back with the mutation's toast on any other failure, and does not ask first", async () => {
    const { send } = mount({ served: false, held: false });
    park(send, INPUT);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));

    await act(async () => {
      answer(0, (d) => d.reject(refusal("RPC_ERROR")));
      await Promise.resolve();
    });

    expect(await screen.findByText(SEND_FAILED)).toBeTruthy();
    expect(draftOf(CHAT.chatId)?.content).toEqual(INPUT.content);
    expect(send.result.current.parks).toBe(false);
  });

  it("puts every parked message back, the first in the composer, when the page goes away", async () => {
    const { send } = mount({ served: true, held: true });
    park(send, INPUT, SECOND_INPUT);
    await vi.waitFor(() => expect(hydrates).toHaveLength(1));

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(send.result.current.parked).toEqual([]);
    expect(draftOf(CHAT.chatId)?.content).toEqual(INPUT.content);
    expect(
      await screen.findByText(/It was not put back in the composer/),
    ).toBeTruthy();
    expect(screen.getByText(/then update the tests/)).toBeTruthy();
    expect(imageRootHeld()).toBe(false);
  });

  it("hands the draft back, toasts and releases the hold when the tile closes with a message parked", async () => {
    const { send, hold } = mount({ served: true, held: true });
    await parkAndHydrate(send, INPUT);
    expect(hold.result.current).toBe(true);

    send.unmount();

    expect(draftOf(CHAT.chatId)?.content).toEqual(INPUT.content);
    expect(await screen.findByText(SEND_FAILED)).toBeTruthy();
    expect(imageRootHeld()).toBe(false);
    expect(hold.result.current).toBe(false);
  });

  it("restores a taken send when the tile closes before rebind consent settles", async () => {
    const { send, hold } = mount({ served: true, held: true });
    await parkAndHydrate(send, INPUT);
    const taken = take(send);
    const settleLate = send.result.current.settle;

    send.unmount();

    expect(draftOf(CHAT.chatId)?.content).toEqual(INPUT.content);
    expect(await screen.findByText(SEND_FAILED)).toBeTruthy();
    expect(imageRootHeld()).toBe(false);
    expect(hold.result.current).toBe(false);

    act(() => settleLate(taken[0], true));

    expect(draftOf(CHAT.chatId)?.content).toEqual(INPUT.content);
    expect(imageRootHeld()).toBe(false);
  });

  it("releases the hold once the witness no longer reads the chat at rest", async () => {
    const { send, hold } = mount({ served: true, held: true });
    await parkAndHydrate(send, INPUT);
    expect(hold.result.current).toBe(true);

    send.rerender({ served: false, held: false });

    expect(hold.result.current).toBe(false);
  });

  it("asks first after the host refuses a message on its ack", () => {
    const { send } = mount({ served: false, held: false });
    expect(send.result.current.parks).toBe(false);

    act(() => send.result.current.refuse());

    expect(send.result.current.parks).toBe(true);
  });
});
