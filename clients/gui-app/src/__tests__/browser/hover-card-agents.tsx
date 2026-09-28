import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AgentHoverTooltip } from "@/components/epic-canvas/sidebar/agent-hover-tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { HoverCard, HoverCardGroup } from "@/components/ui/hover-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The REAL `AgentHoverTooltip` over six sidebar-style rows in a seeded epic
 * session: four rows resolve to the owner card, the last two (no owner host)
 * to the label fallback. It exists for the one thing the canvas fixture's
 * tree cannot seed, a list MIXING the two outcomes (A6 in
 * `scripts/hover-card-browser.mjs`), and it is composed the way the sidebar
 * tree composes its rows: one `HoverCardGroup` around them
 * (`ChatTreePanelBody`).
 *
 * Beside them, two actionable cards on the bare primitive: one inside a real
 * modal `Dialog` (L1: the pointer reaches its link, Escape closes the card
 * before the dialog), and one whose enabled buttons (one arriving late, as
 * async metadata does) must stay out of the tab order (K1).
 *
 * `window.__hoverCardAgentsProbe.ready` gates it.
 */

const EPIC_ID = "fixture-epsilon";
const HOST_ID = "test-local-host";

const AGENTS: ReadonlyArray<TreeNode> = [
  "Plan the migration",
  "Write the tests",
  "Rebuild the index",
  "Review the diff",
  "Ship the release",
  "Sweep the worktrees",
].map((title, index) => ({
  id: `agent-${String(index + 1)}`,
  parentId: null,
  title,
  type: "chat",
  status: null,
  createdAt: 1,
  updatedAt: 1,
}));

/** The rows past this index have no owner host, so they take the label fallback. */
const OWNER_ROWS = 4;

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function openSession() {
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  const nodeById: Record<string, TreeNode> = {};
  const rootIds: string[] = [];
  const byId: Record<string, ChatProjection> = {};
  for (const node of AGENTS) {
    nodeById[node.id] = node;
    rootIds.push(node.id);
    byId[node.id] = {
      id: node.id,
      title: node.title,
      parentId: null,
      createdAt: 1,
      updatedAt: 1,
      userId: null,
      hostId: HOST_ID,
      isTitleEditedByUser: false,
      docResident: false,
      archivedAt: null,
      settings: null,
    };
  }
  handle.store.setState({
    tree: { rootIds, childrenByParent: {}, nodeById },
    chats: { allIds: Object.keys(byId), byId },
  });
  getOpenEpicRegistry().acquire(EPIC_ID, () => handle);
  return handle;
}

const SESSION = openSession();

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
    requestId: () => `hover-card-agents-${String(++requestCounter)}`,
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
      "host.notifications.indicatorState": () => ({ epics: {}, chats: {} }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
    },
  });

export function Row(props: {
  readonly node: TreeNode;
  readonly withOwner: boolean;
}): ReactNode {
  const button = (
    <button
      type="button"
      data-testid={`epic-sidebar-item-${props.node.id}`}
      className="flex h-8 w-full items-center rounded-md px-2 text-left text-ui-sm text-foreground hover:bg-foreground/8"
    >
      <span className="min-w-0 flex-1 truncate">{props.node.title}</span>
    </button>
  );
  return (
    <AgentHoverTooltip
      trigger={button}
      epicId={EPIC_ID}
      nodeId={props.node.id}
      nodeName={props.node.title}
      hostId={props.withOwner ? HOST_ID : null}
      ownerHostUnreachable={false}
      ownerKind={props.withOwner ? "chat" : null}
      roleClaims={[]}
      extraContent={null}
      side="right"
    />
  );
}

function ActionCardBody(props: { readonly name: string }): ReactNode {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), 150);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="flex flex-col items-start gap-2">
      <a
        href="#install"
        data-testid={`${props.name}-link`}
        onClick={(event) => {
          event.preventDefault();
          const clicks = Number(
            Reflect.get(window, "__hoverCardLinkClicks") ?? 0,
          );
          Reflect.set(window, "__hoverCardLinkClicks", clicks + 1);
        }}
      >
        Install Traycer in WSL
      </a>
      <button type="button" data-testid={`${props.name}-action`}>
        Refresh
      </button>
      {late ? (
        <button type="button" data-testid={`${props.name}-late-action`}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

function ActionCard(props: { readonly name: string }): ReactNode {
  return (
    <HoverCard
      trigger={
        <button type="button" data-testid={`${props.name}-trigger`}>
          {props.name}
        </button>
      }
      content={<ActionCardBody name={props.name} />}
      appearance="preview"
      semantics={{ role: "dialog", label: `${props.name} details` }}
      side="bottom"
      align="start"
      sideOffset={4}
      enabled
      open={null}
      onOpenChange={null}
      testId={`${props.name}-card`}
      className="w-64 p-3 text-ui-xs"
    />
  );
}

function ModalWithCard(): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="open-modal"
        onClick={() => setOpen(true)}
      >
        Open settings
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            A modal with an actionable card.
          </DialogDescription>
          <div data-testid="modal-body">
            <ActionCard name="modal" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function Fixture(): ReactNode {
  useEffect(() => {
    Reflect.set(window, "__hoverCardAgentsProbe", { ready: true });
  }, []);
  return (
    <div className="flex h-dvh bg-canvas text-canvas-foreground">
      <div
        data-fixture-panel
        className="flex w-72 shrink-0 flex-col gap-0.5 border-r border-border bg-background p-2"
      >
        <HoverCardGroup>
          {AGENTS.map((node, index) => (
            <Row key={node.id} node={node} withOwner={index < OWNER_ROWS} />
          ))}
        </HoverCardGroup>
      </div>
      <main
        data-fixture-content
        className="flex min-w-0 flex-1 flex-col items-start gap-3 bg-background p-4 text-ui-sm"
      >
        <ModalWithCard />
        <ActionCard name="actions" />
        <button type="button" data-testid="last-stop">
          Last stop
        </button>
      </main>
    </div>
  );
}

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
            <TooltipProvider>
              <EpicSessionContext value={SESSION}>
                {props.children}
              </EpicSessionContext>
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const fixtureErrors: string[] = [];
window.addEventListener("error", (event) => {
  fixtureErrors.push(
    event.error instanceof Error
      ? (event.error.stack ?? event.message)
      : event.message,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  fixtureErrors.push(
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason),
  );
});
Reflect.set(window, "__hoverCardAgentsErrors", fixtureErrors);

const rootRoute = createRootRoute({
  component: () => (
    <Providers>
      <Fixture />
    </Providers>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const container = document.getElementById("root");
if (container === null) throw new Error("no #root");
createRoot(container).render(<RouterProvider router={router} />);
