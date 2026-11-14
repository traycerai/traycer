import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import {
  AUTHENTICATED_USER_FIXTURE_ID,
  createAuthenticatedUserFixture,
} from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { vi } from "vitest";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { useHostBinding } from "@/lib/host/runtime";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const BILLING_USER = createAuthenticatedUserFixture(undefined);
const BILLING_TOKENS = {
  token: "sandbox-billing-test-token",
  refreshToken: "sandbox-billing-test-refresh-token",
};

export type SandboxBillingEnvironmentAnswer =
  | { readonly kind: "ready"; readonly role: "admin" | "editor" | "viewer" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" };

function localHost(hostId: string): LocalHostSnapshot {
  return {
    hostId,
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "1.2.3",
    pid: 4242,
    systemHostName: "test-machine",
    displayName: "test-machine",
    availability: "available",
  };
}

function buildRunnerHost(hostId: string): MockRunnerHost {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: localHost(hostId),
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  vi.spyOn(runnerHost, "validateAuthTokenIdentity").mockResolvedValue({
    kind: "valid",
    user: BILLING_USER,
  });
  runnerHost.selectionIdentity.set("sandbox-billing-test");
  runnerHost.setHosts(runnerHost.hosts);
  return runnerHost;
}

function buildEnvironment(
  environmentId: string,
  role: "admin" | "editor" | "viewer",
): EnvironmentDescriptorV11 {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: "team-a",
    roomId: "room-team-a",
    label: "Acme",
    effectiveRole: role,
    kind: "team",
    hostCount: 0,
    providerHandle: "acme",
  };
}

function messengerFactory(
  answer: SandboxBillingEnvironmentAnswer,
  environmentId: string,
  onEnvironmentListRequest: ((hostId: string | null) => void) | null,
): (args: {
  readonly registry: HostRpcRegistry;
}) => IHostMessenger<HostRpcRegistry> {
  return (args) => {
    let messenger: MockHostMessenger<HostRpcRegistry> | null = null;
    messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "sandbox-billing-environment-list",
      handlers: {
        "environment.list": () => {
          if (onEnvironmentListRequest !== null) {
            onEnvironmentListRequest(
              messenger?.calls.at(-1)?.authority.endpoint.hostId ?? null,
            );
          }
          if (answer.kind === "loading") {
            return new Promise<{
              readonly environments: readonly EnvironmentDescriptorV11[];
            }>(() => undefined);
          }
          if (answer.kind === "failed") {
            throw new Error("environment.list failed");
          }
          return {
            environments: [buildEnvironment(environmentId, answer.role)],
          };
        },
        "host.status": () => ({
          ready: true,
          hostVersion: "1.2.3",
          protocolVersion: { major: 1, minor: 0 },
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
      },
    });
    return messenger;
  };
}

interface BindingPreparation {
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  readonly onBinding:
    | ((binding: HostRuntimeBinding<HostRpcRegistry>) => void)
    | null;
}

function createBindingPreparationStore() {
  let prepared: BindingPreparation | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: (): BindingPreparation | null => prepared,
    prepare: (
      binding: HostRuntimeBinding<HostRpcRegistry>,
      onBinding:
        | ((binding: HostRuntimeBinding<HostRpcRegistry>) => void)
        | null,
    ): void => {
      if (prepared?.binding === binding && prepared.onBinding === onBinding) {
        return;
      }
      onBinding?.(binding);
      prepared = { binding, onBinding };
      listeners.forEach((listener) => listener());
    },
    clear: (): void => {
      if (prepared === null) return;
      prepared = null;
      listeners.forEach((listener) => listener());
    },
  };
}

export function SandboxBillingRuntime(props: {
  readonly answer: SandboxBillingEnvironmentAnswer;
  readonly environmentId: string;
  readonly hostId: string;
  readonly children: ReactNode;
  readonly queryClient: QueryClient | undefined;
  readonly onEnvironmentListRequest: ((hostId: string | null) => void) | null;
  readonly onBinding:
    | ((binding: HostRuntimeBinding<HostRpcRegistry>) => void)
    | null;
}): ReactNode {
  const [selectionReady, setSelectionReady] = useState(false);
  const [queryClient] = useState(
    () =>
      props.queryClient ??
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  const [runnerHost] = useState(() => buildRunnerHost(props.hostId));
  const factory = useMemo(
    () =>
      messengerFactory(
        props.answer,
        props.environmentId,
        props.onEnvironmentListRequest,
      ),
    [props.answer, props.environmentId, props.onEnvironmentListRequest],
  );
  useEffect(() => {
    let cancelled = false;
    void runnerHost.tokenStore
      .signIn(BILLING_TOKENS, {
        id: AUTHENTICATED_USER_FIXTURE_ID,
        name: BILLING_USER.user.name,
        email: BILLING_USER.user.email,
      })
      .then(() => {
        if (cancelled) return;
        runnerHost.setHosts(runnerHost.hosts);
        setSelectionReady(true);
      });
    return () => {
      cancelled = true;
      useSelectionAuthorityStore.getState().reset();
    };
  }, [props.hostId, runnerHost]);
  return (
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={factory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="host-runtime-loading" />}
        >
          {selectionReady ? (
            <SandboxBillingBindingGate onBinding={props.onBinding}>
              {props.children}
            </SandboxBillingBindingGate>
          ) : null}
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>
  );
}

function SandboxBillingBindingGate(props: {
  readonly children: ReactNode;
  readonly onBinding:
    | ((binding: HostRuntimeBinding<HostRpcRegistry>) => void)
    | null;
}): ReactNode {
  const binding = useHostBinding();
  const onBinding = props.onBinding;
  const [preparationStore] = useState(createBindingPreparationStore);
  const preparation = useSyncExternalStore(
    preparationStore.subscribe,
    preparationStore.getSnapshot,
    preparationStore.getSnapshot,
  );
  useEffect(() => {
    if (binding === null) {
      preparationStore.clear();
      return;
    }
    preparationStore.prepare(binding, onBinding);
  }, [binding, onBinding, preparationStore]);
  return binding !== null &&
    preparation?.binding === binding &&
    preparation.onBinding === onBinding
    ? props.children
    : null;
}
