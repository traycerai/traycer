import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { BotMessageComposer } from "@/components/bots/bot-message-composer";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * A BOT'S MESSAGE BOX WITH CALL BESIDE SEND, IDLE AND IN A CALL.
 *
 * The real `BotMessageComposer` in a column of the width the spec chooses,
 * because where Call sits and whether the call bar's controls fit are layout
 * claims jsdom cannot decide. Nothing of the box is reimplemented; the
 * fixture supplies the provider stack and the host's answers only.
 * `?box=channel|thread` picks the channel's box or an opened thread's,
 * `?pane=<px>` makes the column narrower than the window, as a thread beside
 * the channel is, and `?title=` names the bot.
 * `__composerCallProbe.offer` makes the deployment offer voice, so Call is
 * drawn, and `placeCall` begins a call from the box, as the controller's
 * `start` does; `pauseForDictation` is the call's widest bar: dictation came and went,
 * and Resume is up.
 */
declare global {
  interface Window {
    __composerCallProbe?: {
      readonly offer: () => void;
      readonly placeCall: () => void;
      readonly goLive: () => void;
      readonly showCaptions: () => void;
      readonly pauseForDictation: () => void;
    };
  }
}

const HOST_ID = "composer-call-host";
const BOT_ID = "bot-1";

const params = new URLSearchParams(window.location.search);
const BOT_TITLE = params.get("title") ?? "Release Bot";
const THREAD_ID = params.get("box") === "thread" ? "thread-1" : null;
const TEST_ID =
  THREAD_ID === null ? "bot-channel-composer" : "bot-thread-composer";
const PANE_PX = params.get("pane");

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4546,
  systemHostName: "composer-call-fixture",
  displayName: "composer-call-fixture",
  availability: "available",
} as const;

const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `composer-call-${String(++requestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
        updatesExternallyManaged: null,
        previousExit: null,
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
    },
  });

window.__composerCallProbe = {
  offer: () => {
    useVoiceSessionStore.setState({
      availability: "live",
      driver: {
        start: () => undefined,
        end: () => undefined,
        setMuted: () => undefined,
      },
    });
  },
  placeCall: () => {
    useVoiceSessionStore
      .getState()
      .sessionConnecting(
        { botId: BOT_ID, hostId: HOST_ID, threadId: THREAD_ID },
        BOT_TITLE,
      );
  },
  goLive: () => {
    useVoiceSessionStore.setState({ phase: "live" });
  },
  showCaptions: () => {
    useVoiceSessionStore.getState().setCaptions(true);
  },
  pauseForDictation: () => {
    const store = useVoiceSessionStore.getState();
    store.acquireDictationHold("composer");
    store.releaseDictationHold("composer");
  },
};

function noop(): void {}

export function Pane(): ReactElement {
  return (
    <div
      className="flex h-safe-dvh flex-col justify-end"
      data-testid="composer-pane"
    >
      <div
        className="flex min-w-0 flex-col"
        style={PANE_PX === null ? undefined : { width: `${PANE_PX}px` }}
        data-testid="composer-column"
      >
        <TabHostContext.Provider value={HOST_ID}>
          <BotMessageComposer
            botId={BOT_ID}
            botTitle={BOT_TITLE}
            conversationId="channel-1"
            threadId={THREAD_ID}
            announcementId={null}
            sendable
            placeholder={THREAD_ID === null ? `Message ${BOT_TITLE}` : "Reply…"}
            label={
              THREAD_ID === null
                ? `Message ${BOT_TITLE}`
                : "Reply in the thread"
            }
            testId={TEST_ID}
            failure={{ failed: false, fail: noop, clear: noop }}
            edit={null}
            onEditEnd={noop}
            seed={null}
            keptDraft={null}
            quote={null}
            onSent={() => false}
          />
        </TabHostContext.Provider>
      </div>
    </div>
  );
}

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: new MockTraycerCli(),
});

const root = document.querySelector("#root");
if (root === null) throw new Error("composer call fixture root missing");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RunnerHostProvider runnerHost={runnerHost}>
      <HostRuntimeProvider
        registry={hostRpcRegistry}
        messengerFactory={messengerFactory}
        invalidator={null}
        requestId={null}
        remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
        fallback={<div data-testid="composer-call-fallback" />}
      >
        <WindowsBridgeContext.Provider value={windowsBridgeValue}>
          <TooltipProvider>
            <Pane />
          </TooltipProvider>
        </WindowsBridgeContext.Provider>
      </HostRuntimeProvider>
    </RunnerHostProvider>
  </QueryClientProvider>,
);
