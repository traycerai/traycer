import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ProviderId } from "@/components/home/data/landing-options";
import {
  HarnessModelPicker,
  type OpenForHarness,
} from "@/components/home/pickers/harness-model-picker";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Drives the public chat picker against a local mock host. The toolbar store
 * receives the same public catalog rows as the picker queries, so the row,
 * hint, disabled state, and trigger icon all come from production consumers.
 */

type Offered = boolean | undefined;

interface UltracodeRowProbe {
  readonly setOffered: (offered: "true" | "false" | "unknown") => void;
  readonly setCarried: (carried: boolean) => void;
}

declare global {
  interface Window {
    __ultracodeRowProbe: UltracodeRowProbe | undefined;
  }
}

const LOCAL_HOST_ID = "ultracode-picker-fixture-host";
const params = new URLSearchParams(window.location.search);
const LONG_LABEL =
  "Claude Opus 5.5 with an unusually long display name for narrow screens";
const CLAUDE_LABEL = params.get("label") === "long" ? LONG_LABEL : "Opus 5.5";
const EFFORTS = [
  { id: "low", label: "Low", description: null },
  { id: "high", label: "High", description: null },
];

function offeredFrom(value: string | null): Offered {
  if (value === "false") return false;
  if (value === "unknown") return undefined;
  return true;
}

const catalogState: { offered: Offered } = {
  offered: offeredFrom(params.get("offered")),
};
const INITIAL_CARRIED = params.get("carried") !== "0";

function fixtureModel(
  harnessId: ProviderId,
  offered: Offered,
): GuiAgentModelOption {
  const claude = harnessId === "claude";
  return guiAgentModelOptionSchema.parse({
    harnessId,
    slug: claude ? "opus" : "gpt",
    label: claude ? CLAUDE_LABEL : "GPT 5.5",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: EFFORTS,
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata:
      claude && offered !== undefined ? { ultracodeOffered: offered } : {},
  });
}

const HARNESS_OPTIONS = [
  guiHarnessOptionSchema.parse({
    id: "claude",
    label: "Claude",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
  }),
  guiHarnessOptionSchema.parse({
    id: "codex",
    label: "Codex",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
  }),
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
// The mock host never reports ready, so the picker's catalog reads stay
// disabled; seed the rows they would fetch.
queryClient.setQueryData(
  hostQueryKeys.method(LOCAL_HOST_ID, "agent.gui.listHarnesses", {}),
  { harnesses: HARNESS_OPTIONS },
);
queryClient.setQueryData(
  hostQueryKeys.method(LOCAL_HOST_ID, "providers.list", { native: null }),
  { providers: [], native: null },
);

function publishCatalog(
  store: ComposerToolbarStore,
  harnessId: ProviderId,
  offered: Offered,
  carried: boolean,
): void {
  store.getState().setCatalog({
    hostId: LOCAL_HOST_ID,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: carried,
    harnesses: HARNESS_OPTIONS,
    modelsHarnessId: harnessId,
    models: [fixtureModel(harnessId, offered)],
    modelsLoaded: true,
    tuiOnly: false,
    keepsUnavailablePick: false,
  });

  for (const id of ["claude", "codex"] as const) {
    const models = [fixtureModel(id, offered)];
    queryClient.setQueryData(
      hostQueryKeys.method(LOCAL_HOST_ID, "agent.gui.listModels", {
        harnessId: id,
        workingDirectory: null,
      }),
      { harnessId: id, models },
    );
  }
}

function initialToolbarStore(): ComposerToolbarStore {
  const store = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "ultracode-picker-browser-fixture",
    values: {
      ultracode: true,
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug: "opus", profileId: null },
      reasoning: "high",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: INITIAL_CARRIED,
    hostId: LOCAL_HOST_ID,
  });
  publishCatalog(store, "claude", catalogState.offered, INITIAL_CARRIED);
  return store;
}

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: {
    hostId: LOCAL_HOST_ID,
    websocketUrl: "ws://127.0.0.1:9/rpc",
    version: "1.2.3",
    pid: 4343,
    systemHostName: "Picker fixture",
    displayName: "Picker fixture",
    availability: "available",
  },
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `ultracode-picker-${String(++requestCounter)}`,
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
      "agent.gui.listHarnesses": () => ({ harnesses: HARNESS_OPTIONS }),
      "agent.gui.listModels": ({ harnessId }) => ({
        harnessId,
        models: [fixtureModel(harnessId, catalogState.offered)],
      }),
      "agent.gui.listCommands": ({ harnessId }) => ({
        harnessId,
        commands: [],
      }),
      "providers.list": () => ({ providers: [], native: null }),
    },
  });

/** Mount under the ready host runtime so the public open handle exists. */
function FixturePicker({ store }: { readonly store: ComposerToolbarStore }) {
  const openForHarnessRef = useRef<OpenForHarness | null>(null);
  useEffect(() => {
    openForHarnessRef.current?.("claude", null);
  }, []);
  return (
    <HarnessModelPicker
      openForHarnessRef={openForHarnessRef}
      withUltracode
      labelDisplay="model-only"
      store={store}
      maxModeContext={{ kind: "none" }}
      withServiceTier={false}
      withReasoning
      tuiOnly={false}
      lockedHarnessId={null}
      disabled={false}
      registerActivation={false}
      createProfileHostId={LOCAL_HOST_ID}
      runTargetHostId={LOCAL_HOST_ID}
      profileAdmission={null}
      terminalLoginSurface={null}
      embedding={null}
    />
  );
}

export function UltracodePickerRowFixture() {
  const [store] = useState(initialToolbarStore);
  const [offered, setOffered] = useState(catalogState.offered);
  const [carried, setCarried] = useState(INITIAL_CARRIED);
  const selection = useStore(store, (state) => state.selection);

  useEffect(() => {
    publishCatalog(store, selection.harnessId, offered, carried);
  }, [carried, offered, selection.harnessId, store]);

  useEffect(() => {
    window.__ultracodeRowProbe = {
      setOffered: (next) => {
        const nextOffered = offeredFrom(next);
        catalogState.offered = nextOffered;
        setOffered(nextOffered);
        publishCatalog(
          store,
          store.getState().selection.harnessId,
          nextOffered,
          carried,
        );
      },
      setCarried: (next) => {
        setCarried(next);
        publishCatalog(
          store,
          store.getState().selection.harnessId,
          offered,
          next,
        );
      },
    };
    return () => {
      window.__ultracodeRowProbe = undefined;
    };
  }, [carried, offered, store]);

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
          <TooltipProvider delayDuration={0}>
            <main className="min-h-safe-svh w-full bg-canvas text-canvas-foreground">
              <FixturePicker store={store} />
            </main>
          </TooltipProvider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}
