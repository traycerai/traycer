import { useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { EpicLeftPanelLoadingHost } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { EpicLeftPanelStaticRail } from "@/components/epic-canvas/sidebar/epic-sidebar-rail";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { railStackMembers, type RailEntry } from "@/lib/layout/rail";
import { useLayoutStore } from "@/stores/layout/layout-store";
import { useEpicLeftPanelStore } from "@/stores/epics/left-panel-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE SIDEBAR STACK'S DRAG GESTURES (L-166, L-181), in real Chrome with real
 * mouse input.
 *
 * The real rail (`orientation="horizontal"`, the task panel's icon row) above
 * the real sidebar body, inside the real `RootDndProvider`, over a rail whose
 * first entry is a stack of four: Agents, Artifacts, Sharing and Git Diff.
 * The body draws its sections through the loading definitions, which are the
 * real section headers - the drag source - over skeleton bodies, so no epic
 * session is needed.
 *
 * `window.__leftPanelStackProbe` reads the rail back as the stacks it holds,
 * and `reset` re-seeds it between tests.
 */
interface LeftPanelStackProbe {
  readonly ready: true;
  readonly reset: () => void;
  /** Each rail entry: a panel's region id, or a stack's member list. */
  readonly rail: () => ReadonlyArray<string | ReadonlyArray<string>>;
}

declare global {
  interface Window {
    __leftPanelStackProbe?: LeftPanelStackProbe;
  }
}

const TAB_ID = "left-panel-stack-tab";
const EPIC_ID = "left-panel-stack-epic";

const SEEDED_RAIL: ReadonlyArray<RailEntry> = [
  { kind: "panel", id: "railAgents" },
  {
    kind: "stack",
    id: "stack:railAgents+railArtifacts+railSharing+railGitDiff",
  },
  { kind: "panel", id: "railArtifacts" },
  { kind: "panel", id: "railSharing" },
  { kind: "panel", id: "railGitDiff" },
  { kind: "panel", id: "railTerminals" },
  { kind: "panel", id: "railBrowsers" },
  { kind: "panel", id: "railPullRequests" },
  { kind: "panel", id: "railFileTree" },
  { kind: "panel", id: "railComments" },
];

function seed(): void {
  const { arrangement } = useLayoutStore.getState();
  useLayoutStore
    .getState()
    .setArrangement({ ...arrangement, rail: SEEDED_RAIL });
  useEpicLeftPanelStore.getState().setActivePanelIdAndExpand(TAB_ID, "chats");
}

function readRail(): ReadonlyArray<string | ReadonlyArray<string>> {
  return useLayoutStore.getState().arrangement.rail.flatMap((entry) => {
    if (entry.kind === "stack") return [railStackMembers(entry.id) ?? []];
    return entry.kind === "panel" ? [entry.id] : [];
  });
}

export function Fixture(): ReactNode {
  useEffect(() => {
    window.__leftPanelStackProbe = { ready: true, reset: seed, rail: readRail };
    return () => {
      window.__leftPanelStackProbe = undefined;
    };
  }, []);
  return (
    <div className="flex h-dvh bg-canvas text-canvas-foreground">
      <RootDndProvider>
        <div
          data-fixture-panel
          className="flex h-full w-96 shrink-0 flex-col overflow-hidden border-r border-border bg-background"
        >
          {/* `EpicSidebarColumn`'s own composition of the open panel. */}
          <SidebarProvider
            defaultOpen
            className="h-full min-h-0 w-full flex-col"
          >
            <EpicLeftPanelStaticRail
              epicId={EPIC_ID}
              tabId={TAB_ID}
              orientation="horizontal"
            />
            <div className="min-h-0 flex-1">
              <EpicLeftPanelLoadingHost epicId={EPIC_ID} tabId={TAB_ID} />
            </div>
          </SidebarProvider>
        </div>
        <main className="min-w-0 flex-1" />
      </RootDndProvider>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

let requestCounter = 0;

const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `left-panel-stack-${String(++requestCounter)}`,
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
      }),
    },
  });

export function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>{props.children}</TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

seed();

const container = document.getElementById("root");
if (container !== null)
  createRoot(container).render(
    <Providers>
      <Fixture />
    </Providers>,
  );
