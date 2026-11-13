/**
 * What the suites of the bot message box and its kept draft share (Tracy Bots
 * T158, T186): the app a case starts afresh, the box's UI loaded over it, the
 * scripted send mutation and the helpers that drive the box. Each suite keeps
 * its own `vi.hoisted` send mocks and `vi.mock` calls, which hoist per file,
 * and hands the mocks to {@link scriptedSendMutation} and {@link startCase}.
 */
import type { ReactNode } from "react";
import { vi, type Mock } from "vitest";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  OWNER_LABEL,
  restart,
  startFresh,
  type App,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

export interface SendCallbacks {
  readonly onSuccess:
    | ((response: BotConversationSendResponse) => void)
    | undefined;
  readonly onError: ((error: Error) => void) | undefined;
}

/** What a suite's `vi.hoisted` holds for the send: the calls the box made, and when each settled. */
export interface SendMocks {
  readonly send: Mock<
    (variables: BotConversationSendRequest, callbacks: SendCallbacks) => void
  >;
  readonly settled: WeakMap<SendCallbacks, Promise<void>>;
}

/** The send mutation the box gets: each send is scripted by the case through the callbacks it was handed. */
export function scriptedSendMutation(mocks: SendMocks): {
  readonly mutateAsync: (
    variables: BotConversationSendRequest,
  ) => Promise<BotConversationSendResponse>;
  readonly isPending: false;
} {
  return {
    mutateAsync: (variables) => {
      const { promise, resolve, reject } =
        Promise.withResolvers<BotConversationSendResponse>();
      const callbacks: SendCallbacks = { onSuccess: resolve, onError: reject };
      mocks.settled.set(
        callbacks,
        promise.then(
          () => undefined,
          () => undefined,
        ),
      );
      mocks.send(variables, callbacks);
      return promise;
    },
    isPending: false,
  };
}

export const RESPONSE: BotConversationSendResponse = {
  messageId: "post-1",
  requestId: "request-1",
  delivery: "written",
  threadId: "thread-1",
};

/** The failed post a box edits in the cases that edit one. */
export const EDIT = {
  requestId: "request-failed",
  text: "Failed post",
  content: null,
  held: [],
};

/** What a started app loads for a case: the box's owner, the testing library over the same React. */
export interface Ui {
  readonly owner: typeof import("@/components/bots/__tests__/bot-box-draft-owner");
  readonly rtl: typeof import("@testing-library/react");
  readonly box: typeof import("@/components/bots/__tests__/bot-box-test-support");
  readonly bridge: typeof import("@/providers/bot-drafts-persist-lifecycle-bridge");
  readonly auth: typeof import("@/stores/auth/auth-store");
  readonly query: typeof import("@tanstack/react-query");
}

async function loadUi(): Promise<Ui> {
  const owner = await import("@/components/bots/__tests__/bot-box-draft-owner");
  const rtl = await import("@testing-library/react");
  const box = await import("@/components/bots/__tests__/bot-box-test-support");
  const bridge =
    await import("@/providers/bot-drafts-persist-lifecycle-bridge");
  const auth = await import("@/stores/auth/auth-store");
  const query = await import("@tanstack/react-query");
  return { owner, rtl, box, bridge, auth, query };
}

/** The app and the UI of the running case: live bindings, set by {@link startCase}. */
export let app: App;
export let ui: Ui;

let sends: SendMocks;

/** Starts the app afresh for a case, with `mocks` as the suite's send mocks. */
export async function startCase(mocks: SendMocks): Promise<void> {
  sends = mocks;
  app = await startFresh();
  ui = await loadUi();
}

/** The app is started again over what is stored, as a restart does, and the box's UI loaded over it. */
export async function restartApp(): Promise<void> {
  ui.rtl.cleanup();
  app = await restart();
  ui = await loadUi();
}

/** Ends the case: what it rendered, its sends, the app and the clock. */
export function endCase(): void {
  ui.rtl.cleanup();
  sends.send.mockReset();
  app.close();
  vi.useRealTimers();
}

/**
 * The box mounted and its editor found, which polls on the real clock; the
 * fake clock the drafts' write debounce runs on comes after.
 */
export async function mountBox(
  initial: string,
): Promise<{ unmount: () => void }> {
  vi.useRealTimers();
  const view = ui.rtl.render(<ui.owner.OwnerBox initial={initial} />);
  await ui.box.findBoxInput(OWNER_LABEL);
  startDebounceClock();
  return view;
}

/** The bridge reads the mutation cache of the app's query client at a switch. */
export function withQueryClient(children: ReactNode): ReactNode {
  return (
    <ui.query.QueryClientProvider client={new ui.query.QueryClient()}>
      {children}
    </ui.query.QueryClientProvider>
  );
}

export function startDebounceClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

export function typeBox(sequence: string): void {
  ui.box.typeKeys(OWNER_LABEL, sequence);
}

export function boxText(): string {
  return ui.box.boxText(OWNER_LABEL);
}

export function lastSend(): SendCallbacks {
  const call = sends.send.mock.calls.at(-1);
  if (call === undefined) throw new Error("the box sent nothing");
  return call[1];
}

export async function settleSend(
  callbacks: SendCallbacks,
  outcome: (callbacks: SendCallbacks) => void,
): Promise<void> {
  await ui.rtl.act(async () => {
    outcome(callbacks);
    await sends.settled.get(callbacks);
  });
}
