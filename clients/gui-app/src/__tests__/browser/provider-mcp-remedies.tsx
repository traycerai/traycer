import { useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProviderMcpCapabilities,
  ProviderMcpNotice,
  ProviderMcpRemedy,
  ProviderMcpServer,
} from "@traycer/protocol/host/provider-native-schemas";
import { ProviderMcpTab } from "@/components/settings/panels/provider-mcp-tab";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import "@/lib/theme-applier";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import "@/index.css";

/** The real settings tab over an in-memory host. No CLI or config file runs. */
type Scenario =
  | "blocking"
  | "row"
  | "two-rows"
  | "empty-confirmation"
  | "missing-offer"
  | "old-empty"
  | "old-row"
  | "after-remedy"
  | "after-enable";

const LOCAL_HOST: LocalHostSnapshot = {
  hostId: "mcp-browser-fixture",
  websocketUrl: "ws://127.0.0.1:9/mcp-fixture",
  version: "1.2.3",
  pid: 1,
  systemHostName: "fixture.local",
  displayName: "MCP fixture",
  availability: "available",
};
const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: LOCAL_HOST,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const remedy = {
  id: "fixture:repair",
  label: "Repair server",
  confirmation: "Repair this server before using it?",
};
const enableRemedy: ProviderMcpRemedy = {
  id: "fixture:enable:original",
  label: "Enable local-tool",
  confirmation: "Enabling runs a local program.",
};
const blockedNotice: ProviderMcpNotice = {
  id: "fixture:blocked",
  tone: "warning",
  text: "This file needs repair before its servers can be listed.",
  blocking: true,
  remedy,
};
const completedNotice: ProviderMcpNotice = {
  id: "fixture:complete",
  tone: "info",
  text: "The repair finished; no servers remain in this fixture.",
  blocking: false,
  remedy: null,
};
const enabledNotice: ProviderMcpNotice = {
  id: "fixture:enabled",
  tone: "info",
  text: "The server is enabled in this fixture.",
  blocking: false,
  remedy: null,
};

function server(args: {
  readonly name?: string;
  readonly enabled: boolean;
  readonly modern: boolean;
  readonly confirmation: ProviderMcpRemedy | null;
  readonly command?: string;
}): ProviderMcpServer {
  return {
    name: args.name ?? "local-tool",
    enabled: args.enabled,
    transport: {
      type: "stdio",
      command: args.command ?? "fixture-only",
      env: null,
    },
    status: "unknown",
    statusSource: "probe",
    statusDetail: null,
    tools: [],
    discoveryPending: false,
    instructions: null,
    configOnly: false,
    stdioDegraded: false,
    ...(args.modern ? { remedy, enableConfirmation: args.confirmation } : {}),
  };
}

const scopes = ["global"] as const;
const OLD_CAPABILITIES: ProviderMcpCapabilities = {
  transports: ["stdio"],
  authTypes: ["none"],
  authActions: [],
  actionScopes: {
    list: [...scopes],
    add: [...scopes],
    update: [],
    remove: [...scopes],
    toggleServer: [...scopes],
    toggleTool: [],
    discover: [],
    auth: [],
  },
  addServer: "cli",
  removeServer: "cli",
  updateServer: "patch",
  perToolBacking: "native",
  statusSource: "probe",
  toolsSource: "probe",
  schemasSource: "probe",
  instructionsSource: "probe",
  traycerSessionsOnlyEnforcement: false,
  stdioDegradeNotice: false,
  oauthDegradesToConfigOnly: true,
};
const NEW_CAPABILITIES: ProviderMcpCapabilities = {
  ...OLD_CAPABILITIES,
  actionScopes: { ...OLD_CAPABILITIES.actionScopes, applyRemedy: [...scopes] },
};

let scenario: Scenario = "blocking";
let rowVariant: "original" | "changed" | "same" = "original";
const mutations: string[] = [];
let deferNextRemedy = false;
let releaseDeferredRemedy: (() => void) | null = null;

function listResult() {
  switch (scenario) {
    case "blocking":
      return {
        providers: [],
        native: {
          ok: true as const,
          kind: "mcp" as const,
          servers: [],
          notices: [blockedNotice],
        },
      };
    case "row":
    case "two-rows":
      return {
        providers: [],
        native: {
          ok: true as const,
          kind: "mcp" as const,
          servers: [
            server({
              enabled: false,
              modern: true,
              confirmation:
                rowVariant === "changed"
                  ? { ...enableRemedy, id: "fixture:enable:changed" }
                  : enableRemedy,
              command:
                rowVariant === "changed" ? "fixture-changed" : "fixture-only",
            }),
            ...(scenario === "two-rows"
              ? [
                  server({
                    name: "other-tool",
                    enabled: true,
                    modern: true,
                    confirmation: null,
                  }),
                ]
              : []),
          ],
          notices: [],
        },
      };
    case "empty-confirmation":
      return {
        providers: [],
        native: {
          ok: true as const,
          kind: "mcp" as const,
          servers: [
            server({
              enabled: false,
              modern: true,
              confirmation: { ...enableRemedy, confirmation: "" },
            }),
          ],
          notices: [],
        },
      };
    case "missing-offer":
      return {
        providers: [],
        native: {
          ok: true as const,
          kind: "mcp" as const,
          servers: [
            server({ enabled: false, modern: true, confirmation: null }),
          ],
          notices: [],
        },
      };
    case "old-empty":
      return {
        providers: [],
        native: { ok: true as const, kind: "mcp" as const, servers: [] },
      };
    case "old-row":
      return {
        providers: [],
        native: {
          ok: true as const,
          kind: "mcp" as const,
          servers: [
            server({ enabled: false, modern: false, confirmation: null }),
          ],
        },
      };
    case "after-remedy":
      return {
        providers: [],
        native: {
          ok: true as const,
          kind: "mcp" as const,
          servers: [],
          notices: [completedNotice],
        },
      };
    case "after-enable":
      return {
        providers: [],
        native: {
          ok: true as const,
          kind: "mcp" as const,
          servers: [
            server({
              enabled: true,
              modern: true,
              confirmation: enableRemedy,
            }),
          ],
          notices: [enabledNotice],
        },
      };
  }
}

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `mcp-fixture-${String(++requestCounter)}`,
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
      }),
      "host.notifications.indicatorState": () => ({ epics: {}, chats: {} }),
      "providers.list": () => listResult(),
      "providers.nativeMutate": (params) => {
        const mutation = params.mutation;
        if (mutation.kind !== "mcp")
          throw new Error("Unexpected fixture mutation");
        mutations.push(mutation.mutation.action);
        if (mutation.mutation.action === "applyRemedy") {
          if (deferNextRemedy) {
            deferNextRemedy = false;
            return new Promise<
              ResponseOfMethod<HostRpcRegistry, "providers.nativeMutate">
            >((resolve) => {
              releaseDeferredRemedy = () =>
                resolve({
                  result: {
                    ok: false,
                    code: "external_drift",
                    detail: "Earlier offer failed",
                  },
                });
            });
          }
          const enabling =
            mutation.mutation.remedyId.startsWith("fixture:enable:");
          scenario = enabling ? "after-enable" : "after-remedy";
          return {
            result: {
              ok: true,
              kind: "mcp",
              servers: enabling
                ? [
                    server({
                      enabled: true,
                      modern: true,
                      confirmation: enableRemedy,
                    }),
                  ]
                : [],
              notices: [enabling ? enabledNotice : completedNotice],
            },
          };
        }
        if (mutation.mutation.action === "toggleServer") {
          scenario = "after-enable";
          return {
            result: {
              ok: true,
              kind: "mcp",
              servers: [
                server({
                  enabled: true,
                  modern: true,
                  confirmation: enableRemedy,
                }),
              ],
              notices: [enabledNotice],
            },
          };
        }
        throw new Error("Unexpected fixture mutation action");
      },
    },
  });

interface ProbeWindow extends Window {
  __kimiMcpProbe?: {
    readonly ready: boolean;
    readonly setScenario: (next: Scenario) => void;
    readonly refreshRow: (variant: "changed" | "same") => Promise<void>;
    readonly mutationActions: () => readonly string[];
    readonly deferRemedyError: () => void;
    readonly failDeferredRemedy: () => void;
    readonly mutationSettled: () => boolean;
  };
}
const probeWindow: ProbeWindow = window;

export function RequestContext(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => setReady(true));
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "fixture" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  return ready ? props.children : null;
}

export function FixtureTab(): ReactNode {
  const [view, setView] = useState(0);
  useLayoutEffect(() => {
    probeWindow.__kimiMcpProbe = {
      ready: true,
      setScenario: (next) => {
        scenario = next;
        rowVariant = "original";
        mutations.length = 0;
        queryClient.clear();
        setView((previous) => previous + 1);
      },
      refreshRow: async (variant) => {
        rowVariant = variant;
        await queryClient.invalidateQueries();
      },
      mutationActions: () => [...mutations],
      deferRemedyError: () => {
        deferNextRemedy = true;
      },
      failDeferredRemedy: () => {
        releaseDeferredRemedy?.();
        releaseDeferredRemedy = null;
      },
      mutationSettled: () => queryClient.isMutating() === 0,
    };
  }, []);
  const oldHost = scenario === "old-empty" || scenario === "old-row";
  return (
    <main className="mx-auto w-full max-w-3xl p-4">
      <ProviderMcpTab
        key={view}
        providerId="kimi"
        providerLabel="Kimi"
        capabilities={oldHost ? OLD_CAPABILITIES : NEW_CAPABILITIES}
        cliBinaryResolved
      />
    </main>
  );
}

export function Page(): ReactNode {
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
          <TooltipProvider>
            <RequestContext>
              <FixtureTab />
            </RequestContext>
          </TooltipProvider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const container = document.getElementById("root");
if (container !== null) createRoot(container).render(<Page />);
