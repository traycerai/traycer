import { useEffect, useRef, useState, type ReactNode } from "react";
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
import type { JsonContent } from "@traycer/protocol/common/registry";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { ComposerDraftsControl } from "@/components/composer/drafts/composer-drafts-control";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The REAL `ComposerDraftsControl` beside the REAL composer editor and the
 * app's `Toaster`, the start page's arrangement: the Drafts popover opens
 * over the editor, which keeps focus while the list is open. Only the
 * boundaries are faked - the host messenger and runner host, and the
 * navigation target. The rows are start-page drafts nobody else owns, so a
 * delete is a local one with an Undo, through the real row actions.
 * `browser-tests/composer-drafts-popover.spec.ts` drives it with real input;
 * `window.__draftsProbe` reads the landing store back.
 */

const ACTIVE_DRAFT_ID = "landing-active";
const DRAFT_IDS = ["landing-a", "landing-b", "landing-c"] as const;

function typed(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function landingTab(id: string, index: number): LandingDraftTab {
  return {
    id,
    content: typed(`Draft ${id}`),
    selection: null,
    lastTouchedAt: Date.now() - (index + 1) * 60_000,
    settings: null,
    composerMode: "chat",
    workspace: { folders: [], folderInfoByPath: {}, primaryPath: null },
    adoption: { state: "unadopted" },
    hostRevision: 0,
    generation: 1,
    syncedGeneration: 0,
    ownerHostId: null,
    origin: null,
    supersedes: null,
    publication: null,
    confirmedHostBlobHashes: [],
    closed: true,
    returnedSandbox: null,
  };
}

useLandingDraftStore.setState({
  drafts: [ACTIVE_DRAFT_ID, ...DRAFT_IDS].map(landingTab),
  activeDraftId: ACTIVE_DRAFT_ID,
});

Reflect.set(window, "__draftsProbe", {
  state: () => {
    const { drafts, activeDraftId } = useLandingDraftStore.getState();
    return {
      draftIds: drafts.map((draft) => draft.id),
      activeDraftId,
      closedById: Object.fromEntries(
        drafts.map((draft) => [draft.id, draft.closed]),
      ),
    };
  },
});

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
    requestId: () => `composer-drafts-popover-${String(++requestCounter)}`,
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
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
    },
  });

export function Fixture(): ReactNode {
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [pickerStore] = useState(() => createComposerPickerStore());
  useEffect(() => {
    Reflect.set(window, "__draftsProbeReady", true);
  }, []);
  return (
    <div className="flex h-dvh flex-col justify-end gap-2 bg-background p-4 text-ui-sm">
      <div className="flex items-end gap-2 rounded-lg border border-border p-2">
        <div className="min-w-0 flex-1">
          <ComposerPromptEditor
            ref={editorRef}
            initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
            initialSelection={null}
            pickerStore={pickerStore}
            placeholder="Message"
            editorClassName="min-h-16 w-full"
            isActive
            disabled={false}
            slashProviderId="claude"
            hasPastedImageBytes={null}
            ingestPastedComposerImages={null}
            stabilizeImageAttachmentCaret={false}
            onDocumentChange={() => undefined}
            onUserInput={() => undefined}
            onSelectionChange={() => undefined}
            onSubmit={() => undefined}
            onPaste={() => undefined}
            onDragOver={() => undefined}
            onDrop={() => undefined}
            onKeyDown={undefined}
            interceptKeyDown={null}
            onFocus={() => undefined}
            onBlur={() => undefined}
            onEditorReady={null}
          />
        </div>
        <ComposerDraftsControl
          scope={{ surface: "landing", activeDraftId: ACTIVE_DRAFT_ID }}
          hostId={null}
          pickerStore={pickerStore}
          editorRef={editorRef}
          active
        />
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => (
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
              <Fixture />
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
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
