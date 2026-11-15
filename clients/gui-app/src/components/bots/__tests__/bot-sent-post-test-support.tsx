/**
 * What the two suites that watch a member's send across an account change
 * share (Tracy Bots T249): a host that holds `bot.conversation.send` and logs
 * every request, `switchAccount` as the auth service makes it, the channel's
 * transcript fixtures, the real tab surface mounted over the tab suite's
 * mocked boundaries, and the probes that record what a render or a commit
 * drew. The suites own their `vi.mock` calls; the factories they name are
 * here.
 */
import { Profiler, type ReactElement, type ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  type RenderResult,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { expect, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { BotReplyMode } from "@traycer/protocol/host/bot/schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { BotSurfaceOnItsHost } from "@/components/bots/__tests__/bot-sent-post-surface-host";
import {
  heldHost,
  scene,
  type DomReading,
  type HeldHost,
  type HeldSend,
} from "@/components/bots/__tests__/bot-sent-post-scene";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import {
  admitBotDrafts,
  BOT,
  BOT_ID,
  snapshot,
  TAB_HOST,
} from "@/components/bots/__tests__/bot-tab-surface-harness";
import { mocks } from "@/components/bots/__tests__/bot-tab-surface-mocks";
import {
  boxInput,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import {
  negotiateBotSend,
  resetBotFailedRequestSupport,
} from "@/components/bots/__tests__/bot-failed-request-test-support";
import { sendReceipt } from "@/components/bots/__tests__/bot-send-identity-test-support";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BotDraftsPersistLifecycleBridge } from "@/providers/bot-drafts-persist-lifecycle-bridge";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotPendingSendsStore } from "@/stores/bots/bot-pending-sends-store";
import {
  useBotOpenThreadStore,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";
import { normalizeTracyPlaceSearch } from "@/lib/bots/tracy-place";
import { tracyNavigationPending } from "@/lib/tab-navigation";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  historyEntryIdentity,
  observeTracyPlaceTraversals,
} from "@/lib/bots/tracy-place-traversal";
import { isTracyPath, readBotIdFromPath } from "@/lib/routes";
import { TracyChannelPlaceRoute } from "@/routes/tracy-route-components";

/** The two accounts of every case; synthetic ids. */
export const USER_A = "user-a";
export const USER_B = "user-b";

/** What account A types: the text that must never reach B's screen or B's request. */
export const TEXT_A = "Is the nightly green?";
/** The file name of the image A attaches. */
export const IMAGE_A = "release-train.png";

const MEMBER_POST_ID = "post-earlier";

/** An earlier post of a teammate, so the channel draws its list rather than its intro. */
export const EARLIER_POST: Message = {
  role: "user",
  messageId: MEMBER_POST_ID,
  sender: { type: "user", userId: "user-teammate" },
  message: {
    kind: "user",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Morning." }] },
      ],
    },
    browserAnnotations: [],
  },
  timestamp: 500,
  sessionAnchor: null,
  conversationRequest: {
    requestId: "req-earlier",
    resolvedAt: 600,
    resolvedByMessageId: null,
  },
};

export type ChannelTranscriptState = Pick<
  ChatSessionState,
  | "snapshotLoaded"
  | "messages"
  | "events"
  | "transcriptRowContext"
  | "transcriptDerived"
  | "pendingUserMessages"
  | "queue"
  | "turnInProgress"
  | "messageDelivery"
  | "liveAssistantMessage"
  | "activeTurn"
  | "pendingApprovals"
  | "pendingFileEditApprovals"
  | "pendingInterviews"
  | "runStatus"
  | "transcriptWindow"
  | "transcriptBaselineEpoch"
  | "transcriptHydrationSequence"
  | "coldRewrittenMessageIds"
  | "backgroundItems"
  | "reportVisibleTranscriptRange"
  | "requestFindReadOrdinal"
  | "requestTranscriptOrdinal"
  | "holdTranscriptOrdinal"
>;

export function createChannelStore(
  messages: ReadonlyArray<Message>,
): UseBoundStore<StoreApi<ChannelTranscriptState>> {
  return create<ChannelTranscriptState>()(() => ({
    snapshotLoaded: true,
    messages,
    events: [],
    transcriptRowContext: {},
    transcriptDerived: null,
    pendingUserMessages: [],
    queue: { status: "idle", items: [] },
    turnInProgress: undefined,
    messageDelivery: null,
    liveAssistantMessage: null,
    activeTurn: null,
    pendingApprovals: [],
    pendingFileEditApprovals: [],
    pendingInterviews: [],
    runStatus: "idle",
    transcriptWindow: emptyTranscriptWindow(),
    transcriptBaselineEpoch: 0,
    transcriptHydrationSequence: 0,
    coldRewrittenMessageIds: new Set<string>(),
    backgroundItems: undefined,
    reportVisibleTranscriptRange: vi.fn(),
    requestFindReadOrdinal: vi.fn(),
    requestTranscriptOrdinal: vi.fn(),
    holdTranscriptOrdinal: () => () => undefined,
  }));
}

function createHeldHost(): HeldHost {
  const sends: HeldSend[] = [];
  // `spine` is read when a send is asked, so the answer is made for the
  // account whose context the request left under.
  const holder: { spine: HostClient<HostRpcRegistry> | null } = {
    spine: null,
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-1",
    handlers: {
      "bot.readCursor.advance": (params) =>
        Promise.resolve({
          cursor: { messageId: params.messageId, seq: params.seq },
        }),
      "bot.conversation.send": (params) =>
        new Promise((resolve, reject) => {
          const sentBy = holder.spine?.getRequestContextUserId() ?? null;
          sends.push({
            request: params,
            sentBy,
            // A host that takes no nonce answers ids of its own.
            resolve: (threadId) =>
              resolve(
                params.sendNonce === undefined
                  ? {
                      messageId: "message-from-old-host",
                      requestId: "request-from-old-host",
                      delivery: "written",
                      threadId,
                    }
                  : sendReceipt(params, sentBy ?? USER_A, threadId),
              ),
            reject,
          });
        }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  holder.spine = spine;
  return {
    requester: spine.createRequester(mockRemoteHostEntry),
    spine,
    messenger,
    sends,
  };
}

/**
 * The account the app reads as, as `AuthService` moves it: the request
 * context first, then ONE synchronous write of status, profile and context
 * metadata together. `null` is signed out. No act: a caller that needs the
 * stores before anything renders reads them inside its own `act`.
 */
export function switchAccount(userId: string | null): void {
  heldHost().spine.setRequestContext(
    userId === null
      ? null
      : createRequestContextFixture({
          origin: "renderer",
          bearerToken: `token-${userId}`,
          identity: { userId, username: userId, providerHandle: null },
        }),
  );
  useAuthStore.setState(
    userId === null
      ? { status: "signed-out", profile: null, contextMetadata: null }
      : {
          status: "signed-in",
          profile: {
            userId,
            userName: "Olive Owner",
            email: "olive@example.com",
            avatarUrl: null,
          },
          contextMetadata: { userId, username: userId },
        },
  );
}

/** Where a bot runs, as the bot's subscription says it. */
export interface BotBinding {
  readonly kind: "personal" | "team";
  readonly hostId: string;
  readonly epoch: number;
}

/**
 * Puts the bot's binding in the subscription's snapshot, as the app's read of
 * the bot would answer it: its record, its environment's kind, and the bound
 * host with its epoch. {@link redrawSurface} shows it to a mounted surface.
 */
export function bindBot(binding: BotBinding, replyMode: BotReplyMode): void {
  const environmentId =
    binding.kind === "personal" ? "env-personal" : BOT.environmentId;
  mocks.state.environments = [
    binding.kind === "personal"
      ? {
          environmentId,
          label: "Personal",
          ownerKind: "user",
          providerHandle: null,
        }
      : {
          environmentId,
          label: "Acme",
          ownerKind: "organization",
          providerHandle: "acme",
        },
  ];
  mocks.state.snapshot = {
    ...snapshot(),
    bot: {
      ...BOT,
      environmentId,
      boundHostId: binding.hostId,
      hostEpoch: binding.epoch,
      replyMode,
    },
    boundHost: {
      hostId: binding.hostId,
      epoch: binding.epoch,
      isThisHost: binding.hostId === TAB_HOST,
    },
  };
}

/** Draws the mounted surface again, so it reads the snapshot and the tab's host as they are now. */
export function redrawSurface(
  view: RenderResult,
  queryClient: QueryClient,
): void {
  view.rerender(surfaceTree(queryClient, null));
}

/**
 * The account change as the app lives it: the window switches, then the new
 * account's drafts are read and the tab draws again. Until it has, the tab
 * shows its connecting state, which draws nothing a leak could show in.
 */
export async function changeAccount(userId: string | null): Promise<void> {
  act(() => switchAccount(userId));
  await admitBotDrafts();
}

/** A fresh host, channel and probes, with the host's negotiated send at `nonceLine`. */
export function startCase(
  nonceLine: { readonly major: number; readonly minor: number },
  channel: ReadonlyArray<Message>,
  replyMode: BotReplyMode,
): void {
  scene.host = createHeldHost();
  scene.channelHandle = {
    store: createChannelStore(channel),
  } as ChatSessionStoreHandle;
  scene.threadHandle = {
    store: createChannelStore([]),
  } as ChatSessionStoreHandle;
  scene.threads = [];
  scene.commits = [];
  scene.panelKinds = [];
  scene.originSents = [];
  setSendLine(nonceLine);
  // The tab's host is the bot's bound host: a send through it is the bot's own.
  bindBot({ kind: "team", hostId: TAB_HOST, epoch: BOT.hostEpoch }, replyMode);
}

/** The line the host negotiated for `bot.conversation.send`, as the transport and the box read it. */
export function setSendLine(line: {
  readonly major: number;
  readonly minor: number;
}): void {
  scene.sendLine = line;
  negotiateBotSend(TAB_HOST, line);
}

export function endCase(): void {
  scene.host = null;
  scene.channelHandle = null;
  scene.threadHandle = null;
  resetBotFailedRequestSupport();
  useBotOpenThreadStore.setState({ byBotId: {} });
  useBotPendingSendsStore.setState(
    useBotPendingSendsStore.getInitialState(),
    true,
  );
}

function readDom(): DomReading {
  return {
    text: document.body.textContent,
    images: Array.from(document.querySelectorAll("img")).map(
      (image) => `${image.alt}|${image.getAttribute("src") ?? ""}`,
    ),
  };
}

function surfaceTree(queryClient: QueryClient, route: ReactNode): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BotDraftsPersistLifecycleBridge>
        <BotTestRunnerHost>
          <TooltipProvider>
            <ChatExpansionTestProviders tileInstanceId="tile-1">
              {route}
              <Profiler
                id="surface"
                onRender={() => scene.commits.push(readDom())}
              >
                <BotSurfaceOnItsHost />
              </Profiler>
            </ChatExpansionTestProviders>
          </TooltipProvider>
        </BotTestRunnerHost>
      </BotDraftsPersistLifecycleBridge>
    </QueryClientProvider>
  );
}

/**
 * Signs `userId` in, reads that account's drafts, and mounts the real tab
 * surface over `queryClient`: the bridge that retires one account's stores as
 * another signs in sits above it, as in the app.
 */
export async function mountSurfaceAs(
  userId: string,
  queryClient: QueryClient,
): Promise<RenderResult> {
  switchAccount(userId);
  await admitBotDrafts();
  const view = render(surfaceTree(queryClient, null));
  await screen.findByRole("group", { name: "Message Release Bot" });
  return view;
}

/**
 * {@link mountSurfaceAs} with the real Tracy place route beside the surface,
 * over a memory history on the bot's channel, so a step back or forward
 * arrives on an entry as the app's does (`useTracyPlaceRoute`).
 */
export interface PlaceRoute {
  readonly history: RouterHistory;
  /** Where the router stands, for a failure message. */
  readonly describe: () => string;
}

export async function mountSurfaceOnRouteAs(
  userId: string,
  queryClient: QueryClient,
): Promise<PlaceRoute> {
  switchAccount(userId);
  await admitBotDrafts();
  const history = createMemoryHistory({
    initialEntries: [`/bot/${BOT_ID}`],
  });
  const rootRoute = createRootRoute({
    component: () => surfaceTree(queryClient, <Outlet />),
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    validateSearch: (search: Record<string, unknown>) =>
      normalizeTracyPlaceSearch(search),
    component: TracyChannelPlaceRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([channelRoute]),
    history,
  });
  observeTracyPlaceTraversals(history);
  // Every navigation the surface asks of the router, and how it ended.
  const navigations: string[] = [];
  const navigate = router.navigate.bind(router);
  router.navigate = async (options) => {
    const search =
      typeof options.search === "function" ? "<updater>" : options.search;
    navigations.push(
      `${JSON.stringify(options.to)} replace=${String(options.replace)} params=${JSON.stringify(options.params)} search=${JSON.stringify(search)}`,
    );
    try {
      await navigate(options);
      navigations.push(
        `ended at search=${JSON.stringify(router.state.location.search)}`,
      );
    } catch (error) {
      navigations.push(`refused: ${String(error)}`);
      throw error;
    }
  };
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await screen.findByRole("group", { name: "Message Release Bot" });
  // The fixture reaches the mechanism the cases name: an entry that names no
  // place is completed over itself, a write that carries the place's `view`.
  await waitFor(() =>
    expect(
      navigations.join(" | "),
      "the route's mount asked the router for no place: the place route is not in the tree",
    ).toContain('"view"'),
  );
  return {
    history,
    describe: () =>
      `navigations [${navigations.join(" | ")}]; router ${router.state.status}; matches ${router.state.matches.map((match) => match.routeId).join(",")}; router location ${router.state.location.href}; history location ${history.location.href}; isTracyPath=${String(isTracyPath(router.state.location.pathname))}; pathBotId=${String(readBotIdFromPath(router.state.location.pathname))}; routerEntry=${historyEntryIdentity(router.state.location)}; historyEntry=${historyEntryIdentity(history.location)}; routerState=${JSON.stringify(router.state.location.state)}; historyState=${JSON.stringify(history.location.state)}`,
  };
}

export function channelBox(): HTMLElement {
  return boxInput("Message Release Bot");
}

/** Types `text` into the channel's box, and lets the box see it. */
export function typeText(text: string): void {
  typeInto(channelBox(), text);
}

/**
 * Presses Enter in the channel's box. The box sends what it has rendered, so
 * the text must have been typed in an earlier act: inside one act, typing and
 * Enter would run before the box saw the text.
 */
export function pressEnter(): void {
  typeInto(channelBox(), "{Enter}");
}

/** Types `text` into the channel's box and presses Enter; the host holds the send. */
export function pressSend(text: string): void {
  typeText(text);
  pressEnter();
}

/** A 1x1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Pastes an image copied from another box (its composer document) into the channel's box. */
export function pasteImage(fileName: string): void {
  const value = JSON.stringify({
    schema: "traycer.composer-content",
    version: 1,
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "copy",
                fileName,
                mimeType: "image/png",
                b64content: PNG_BASE64,
              },
            },
          ],
        },
      ],
    },
  });
  fireEvent.paste(channelBox(), {
    clipboardData: {
      types: ["application/x-traycer-composer+json"],
      files: [],
      items: [],
      getData: (type: string) =>
        type === "application/x-traycer-composer+json" ? value : "",
    },
  });
}

/** Where the probes stand, so a case reads only what was drawn after it. */
export interface ProbeMark {
  readonly commits: number;
  readonly panelKinds: number;
  readonly originSents: number;
}

export function markProbes(): ProbeMark {
  return {
    commits: scene.commits.length,
    panelKinds: scene.panelKinds.length,
    originSents: scene.originSents.length,
  };
}

/** What of account A's was drawn in a commit after `mark`: its text, or its image. */
export function commitsDrawingA(mark: ProbeMark): string[] {
  return scene.commits.slice(mark.commits).flatMap((reading, index) => {
    const drew: string[] = [];
    if (reading.text.includes(TEXT_A)) drew.push("text");
    if (reading.images.some((image) => image.startsWith(`${IMAGE_A}|`))) {
      drew.push("image");
    }
    return drew.length === 0
      ? []
      : [
          `commit ${String(mark.commits + index)} drew A's ${drew.join(" and ")}`,
        ];
  });
}

/** The renders after `mark` in which the real thread panel was told its thread is a held post. */
export function panelsDrawingPosted(mark: ProbeMark): number {
  return scene.panelKinds
    .slice(mark.panelKinds)
    .filter((kind) => kind === "posted").length;
}

/** The calls after `mark` that gave the thread's origin a post the person sent. */
export function originsDrawingSent(mark: ProbeMark): number {
  return scene.originSents
    .slice(mark.originSents)
    .filter((sent) => sent !== null).length;
}

/** The two stores a send lives in, as text, to compare before and after a late settle. */
export function sendStoresSnapshot(): string {
  return JSON.stringify([
    useBotOpenThreadStore.getState().byBotId,
    useBotPendingSendsStore.getState().entries,
  ]);
}

/** What the bot's rail holds now, or `null`. */
export function heldRail(): BotRail | null {
  const { byBotId } = useBotOpenThreadStore.getState();
  return Object.hasOwn(byBotId, BOT_ID) ? byBotId[BOT_ID] : null;
}

/** What the page holds, for a failure message that says what was drawn instead. */
export function pageDescription(): string {
  return `${String(screen.queryAllByTestId("chat-messages-stub").length)} transcript list(s); page text: ${document.body.textContent.slice(0, 400)}`;
}

/**
 * Waits until the route's search names `fragment` (the place the surface
 * wrote there), and says where the route and the surface stood if it never
 * does.
 */
export async function routeNames(
  route: PlaceRoute,
  fragment: string,
): Promise<void> {
  try {
    await waitFor(() =>
      expect(route.history.location.search).toContain(fragment),
    );
  } catch (error) {
    const surface = useTracySurfaceStore.getState();
    throw new Error(
      `the route never named "${fragment}": ${route.describe()}; surface open=${String(surface.open)} bot=${String(surface.botId)}; navigating=${String(tracyNavigationPending())}; ${pageDescription()}`,
      { cause: error },
    );
  }
}
