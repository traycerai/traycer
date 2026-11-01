import { createRoot } from "react-dom/client";
import { EllipsisVertical } from "lucide-react";
import { LazyMotion, domMax } from "motion/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { MobileCurrentTileBar } from "@/components/epic-canvas/mobile/mobile-current-tile-bar";
import { MobileTileMenu } from "@/components/epic-canvas/mobile/mobile-tile-menu";
import { BotChannelTitle } from "@/components/bots/bot-channel-level2";
import { BotAvatar } from "@/components/bots/bot-avatars";
import { Button } from "@/components/ui/button";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import { useTileMinimapStore } from "@/stores/tile-minimap";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import "@/index.css";

/**
 * THE LEVEL-2 MENU TRIGGER WITH A VERY LONG NAME.
 *
 * `?surface=tile` (default) mounts the production `MobileCurrentTileBar` with
 * `level2="menu"` inside the production `MobileTileMenu`; `?surface=bot` mounts
 * the production `BotChannelTitle` with `level2="menu"` in a flex row like the
 * bot channel header's. Both sit in a container `?width=<px>` wide. The claim
 * is layout: a long name must truncate inside the trigger, not push the row's
 * other controls (the minimap button, the settings button) out of the row or
 * clip the trigger's chevron. jsdom lays nothing out, so a browser decides.
 *
 * The tile bar reads the epic projection and the host runtime, so the fixture
 * mounts the same real layers `canvas-tab-strip-overflow.tsx` documents: an
 * `openStoreForTest` session and a `HostRuntimeProvider` over a mock messenger.
 * The minimap button draws only for a tile with a registered target, so one is
 * registered.
 */
const EPIC_ID = "fixture-epic";
const TAB_ID = "fixture-view-tab";
const FIXTURE_HOST_ID = "fixture-host";
const LONG_NAME =
  "A remarkably long tile name that keeps going well past any width a phone offers for it";

const FIXTURE_LOCAL_HOST: LocalHostSnapshot = {
  hostId: FIXTURE_HOST_ID,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  version: "0.0.0-fixture",
  pid: 1,
  systemHostName: "fixture",
  displayName: "fixture",
  availability: "available",
};

const fixtureStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const fixtureMessengerFactory: MessengerFactory<HostRpcRegistry> = (args) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry: args.registry,
    requestId: () => `fixture-req-${Math.random().toString(36).slice(2, 8)}`,
    handlers: {},
  });

// The minimap's drawer re-asserts the resolved theme; the app's provider is
// the one thing here not worth booting, so the context carries its value.
const RESOLVED_THEME = {
  resolvedTheme: "dark",
  themePreset: "neutral",
} as const;

const params = new URLSearchParams(window.location.search);
const width = params.get("width");
const surface = params.get("surface") ?? "tile";

const TILE: EpicCanvasTileRef = {
  id: "fixture-spec",
  instanceId: "fixture-spec-inst",
  type: "spec",
  name: LONG_NAME,
  hostId: FIXTURE_HOST_ID,
};

const MINIMAP_SNAPSHOT = {
  items: [{ key: "a", label: "First", level: 1 as const }],
  currentIndex: 0,
};
useTileMinimapStore.getState().registerTarget({
  tileInstanceId: TILE.instanceId,
  adapter: {
    title: "Table of contents",
    getSnapshot: () => MINIMAP_SNAPSHOT,
    subscribe: () => () => undefined,
    select: () => undefined,
  },
});

export function TileBarSurface(): React.ReactElement {
  return (
    <MobileTileMenu slot="primary" epicId={EPIC_ID} tabId={TAB_ID} drawn>
      <MobileCurrentTileBar
        epicId={EPIC_ID}
        tile={TILE}
        level2="menu"
        trailing={null}
      />
    </MobileTileMenu>
  );
}

export function BotHeaderSurface(): React.ReactElement {
  return (
    <header
      className="flex min-w-0 items-center gap-2 px-4 pt-3 pb-2"
      data-testid="bot-header"
    >
      <BotAvatar size="sm" />
      <BotChannelTitle
        level2="menu"
        title={LONG_NAME}
        activeBotId="fixture-bot"
        hostId={FIXTURE_HOST_ID}
        threadsView={null}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Channel settings"
        data-testid="bot-header-neighbour"
        className="ml-auto"
      >
        <EllipsisVertical aria-hidden="true" />
      </Button>
    </header>
  );
}

const runnerHost = new MockRunnerHost({
  signInUrl: "https://auth.traycer.invalid/sign-in",
  authnBaseUrl: "http://127.0.0.1:1",
  localHost: FIXTURE_LOCAL_HOST,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

const epicHandle = openStoreForTest({
  epicId: EPIC_ID,
  userId: null,
  factories: {
    streamClientFactory: fixtureStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(
  <LazyMotion features={domMax}>
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={fixtureMessengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="fixture-runtime-fallback" />}
        >
          <TooltipProvider>
            <ResolvedThemeContext.Provider value={RESOLVED_THEME}>
              <EpicSessionContext.Provider value={epicHandle}>
                <div
                  className="flex flex-col"
                  style={width === null ? undefined : { width: `${width}px` }}
                  data-testid="fixture-container"
                >
                  {surface === "bot" ? (
                    <BotHeaderSurface />
                  ) : (
                    <TileBarSurface />
                  )}
                </div>
              </EpicSessionContext.Provider>
            </ResolvedThemeContext.Provider>
          </TooltipProvider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  </LazyMotion>,
);
