import { useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import { ProfileCopyFlowHost } from "@/components/settings/panels/profile-copy/profile-copy-flow-host";
import {
  claudeProviderState,
  managedProfile,
} from "@/components/settings/panels/profile-copy/__tests__/profile-copy-component-fixtures";
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
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/index.css";

/**
 * The production `ProfileCopyFlowHost` with a `sync` view, over a mock host
 * messenger. It exists for what jsdom cannot decide about the Sync profiles
 * dialog - where its box sits in a real viewport, whether its body scrolls
 * while the header and footer stay pinned, and how it paints in both themes
 * (driven by `browser-tests/profile-sync-modal.spec.ts`).
 *
 * It simulates NO transfer and proves nothing about real devices: the
 * messenger answers a catalog, an empty history and an empty preview, so the
 * only things on screen are the picker and the destination list. Real
 * two-device behaviour requires verification against real hosts.
 *
 * `window.__profileSyncProbe` gates it: `ready` once the host runtime has a
 * request context, `open(providerId)` opens the dialog from the store exactly
 * as the Providers settings entry does, and `setTheme(mode)` flips the theme.
 */

const LOCAL_HOST: LocalHostSnapshot = {
  hostId: "fixture-host-studio",
  websocketUrl: "ws://127.0.0.1:9/studio",
  version: "1.2.3",
  pid: 1,
  systemHostName: "mac-studio.local",
  displayName: "Mac Studio",
  availability: "available",
};
const REMOTE_HOSTS: readonly HostDirectoryEntry[] = [
  {
    hostId: "fixture-host-builder",
    label: "Build VM",
    kind: "remote",
    websocketUrl: "ws://127.0.0.1:9/builder",
    version: "1.2.3",
    transportDialability: "dialable",
  },
  {
    hostId: "fixture-host-laptop",
    label:
      "Travel laptop with a deliberately long device name that must truncate",
    kind: "remote",
    websocketUrl: "ws://127.0.0.1:9/laptop",
    version: "1.2.3",
    transportDialability: "dialable",
  },
  {
    hostId: "fixture-host-mini",
    label: "Old Mac mini",
    kind: "remote",
    websocketUrl: null,
    version: "1.2.3",
    transportDialability: "not-dialable",
  },
];

const REGISTRY: HostListResponse = {
  hosts: REMOTE_HOSTS.map((entry) => ({
    hostId: entry.hostId,
    displayName: entry.label,
    platform: "darwin",
    kind: "personal",
    publicKey: "fixture",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatePolicy: "manual",
    status: {
      connectivity: entry.websocketUrl === null ? "offline" : "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: entry.version,
      lastSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  })),
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
// The fixture has no authn, whose fetch answers a signed-out `null`; the
// registry query is answered with the fleet above whenever it holds anything else.
queryClient.getQueryCache().subscribe(() => {
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: ["auth", "registered-hosts"] })) {
    if (query.state.data !== REGISTRY)
      queryClient.setQueryData(query.queryKey, REGISTRY);
  }
});

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: LOCAL_HOST,
  hosts: REMOTE_HOSTS,
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `profile-sync-${String(++requestCounter)}`,
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
      "providers.list": () => ({
        providers: [
          claudeProviderState([
            managedProfile("33333333-3333-4333-8333-333333333333", "Work"),
            managedProfile("44444444-4444-4444-8444-444444444444", "Personal"),
          ]),
          {
            ...claudeProviderState([
              managedProfile("55555555-5555-4555-8555-555555555555", "Main"),
            ]),
            providerId: "codex",
          },
        ],
        native: null,
      }),
      "providers.profileCopy.sync.list": () => ({ batches: [], rules: [] }),
      "providers.profileCopy.sync.preview": (params) => ({
        selection: params,
        revision: "a".repeat(64),
        items: [],
      }),
    },
  });

interface ProfileSyncProbe {
  readonly ready: boolean;
  readonly sourceHostId: string;
  readonly open: (providerId: "claude" | "codex" | null) => void;
  readonly setTheme: (mode: "light" | "dark") => void;
}
interface ProbeWindow extends Window {
  __profileSyncProbe?: ProfileSyncProbe;
}
const probeWindow: ProbeWindow = window;

export function RequestContext(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => {
      setReady(true);
    });
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "fixture" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  useLayoutEffect(() => {
    probeWindow.__profileSyncProbe = {
      ready,
      sourceHostId: LOCAL_HOST.hostId,
      open: (providerId) => {
        useProfileCopyFlowStore.getState().open({
          kind: "sync",
          sourceHostId: LOCAL_HOST.hostId,
          providerId,
        });
      },
      setTheme: (mode) => {
        useSettingsStore.getState().setTheme(mode);
      },
    };
  }, [ready]);
  return ready ? props.children : null;
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
          remoteFetcher={() =>
            Promise.resolve({ kind: "hosts", entries: REMOTE_HOSTS })
          }
          fallback={<div data-fixture-runtime-fallback />}
        >
          <TooltipProvider>
            <RequestContext>
              <ProfileCopyFlowHost />
            </RequestContext>
          </TooltipProvider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const container = document.getElementById("root");
if (container !== null) createRoot(container).render(<Page />);
