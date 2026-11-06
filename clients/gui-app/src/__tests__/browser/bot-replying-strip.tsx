import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { BotMessageComposer } from "@/components/bots/bot-message-composer";
import { BotReplyingStrip } from "@/components/bots/bot-replying-strip";
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
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE REPLYING STRIP IN A DOCK, WITH AND WITHOUT A TURN TO OPEN.
 *
 * The real `BotReplyingStrip` and the real `BotMessageComposer` in two docks
 * as the channel stacks them, siblings of one column with no gap of their
 * own: a transcript stand-in above, the strip, the message box below. The
 * strip's touch band must stay off the box, whose own padding and frame sit
 * right under the line, so the box is the real one. The first dock's strip
 * names a turn that has been running for a few seconds; the second names
 * none, to compare heights. Opening the turn is counted on the first dock's
 * `data-opened`. `?theme=dark` draws it dark.
 */
const theme = new URLSearchParams(window.location.search).get("theme");
useSettingsStore.getState().setTheme(theme === "dark" ? "dark" : "light");

const HOST_ID = "replying-strip-host";
const BOT_ID = "bot-1";
const STARTED_AT = Date.now() - 75_000;

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4546,
  systemHostName: "replying-strip-fixture",
  displayName: "replying-strip-fixture",
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
    requestId: () => `replying-strip-${String(++requestCounter)}`,
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

function noop(): void {}

export function Dock(props: {
  readonly id: string;
  readonly withTurn: boolean;
  readonly onOpen: () => void;
}): ReactElement {
  return (
    <div
      data-testid={`dock-${props.id}`}
      className="flex h-96 w-full max-w-md flex-col border border-border/60"
    >
      <div className="min-h-0 flex-1 p-4 text-ui-sm">Transcript</div>
      <BotReplyingStrip
        botTitle="Tracy"
        activity={{
          state: "replying",
          startedAt: STARTED_AT,
          step: null,
          requestId: "request-1",
          reason: null,
        }}
        turn={
          props.withTurn
            ? {
                summary: null,
                startedAt: STARTED_AT,
                endedAt: null,
                open: props.onOpen,
              }
            : null
        }
        testId={`strip-${props.id}`}
      />
      <BotMessageComposer
        botId={BOT_ID}
        botTitle="Tracy"
        conversationId="channel-1"
        threadId={null}
        announcementId={null}
        sendable
        placeholder="Message Tracy"
        label="Message Tracy"
        testId={`composer-${props.id}`}
        failure={{ failed: false, unsent: null, fail: noop, clear: noop }}
        edit={null}
        onEditEnd={noop}
        onEditResume={noop}
        seed={null}
        keptDraft={null}
        quote={null}
        onSent={() => false}
      />
    </div>
  );
}

export function Page(): ReactElement {
  const onOpen = (): void => {
    const dock = document.querySelector('[data-testid="dock-turn"]');
    const opened = Number(dock?.getAttribute("data-opened") ?? "0") + 1;
    dock?.setAttribute("data-opened", String(opened));
  };
  return (
    <TabHostContext.Provider value={HOST_ID}>
      <div className="flex w-full gap-4 bg-background p-4 text-foreground">
        <Dock id="turn" withTurn onOpen={onOpen} />
        <Dock id="plain" withTurn={false} onOpen={onOpen} />
      </div>
    </TabHostContext.Provider>
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
if (root === null) throw new Error("bot replying strip fixture root missing");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RunnerHostProvider runnerHost={runnerHost}>
      <HostRuntimeProvider
        registry={hostRpcRegistry}
        messengerFactory={messengerFactory}
        invalidator={null}
        requestId={null}
        remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
        fallback={<div data-testid="replying-strip-fallback" />}
      >
        <WindowsBridgeContext.Provider value={windowsBridgeValue}>
          <TooltipProvider>
            <Page />
          </TooltipProvider>
        </WindowsBridgeContext.Provider>
      </HostRuntimeProvider>
    </RunnerHostProvider>
  </QueryClientProvider>,
);
