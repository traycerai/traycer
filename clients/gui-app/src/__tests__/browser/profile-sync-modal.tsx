import { useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type {
  ProfileSyncDevice,
  ProfileSyncItem,
  ProfileSyncOverview,
} from "@traycer/protocol/host/profile-sync-link-schemas";
import { ProfileSyncModalHost } from "@/components/settings/panels/profile-sync/profile-sync-modal-host";
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
import { useProfileSyncModalStore } from "@/stores/settings/profile-sync-modal-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/index.css";

/**
 * The production `ProfileSyncModalHost` over a mock host messenger. It exists
 * for what jsdom cannot decide about the Sync profiles dialog - where its box
 * sits in a real viewport, whether its body scrolls while the header and
 * footer stay pinned, whether long names and row actions stay inside it, that
 * real Escape and outside-click input close it mid-request, and how it paints
 * in both themes (driven by `browser-tests/profile-sync-modal.spec.ts`).
 *
 * It syncs NOTHING and proves nothing about real devices: the messenger
 * answers a fixed overview and applies the three intents to it in memory.
 * Real two-device behaviour requires verification against real hosts.
 *
 * `window.__profileSyncProbe` gates it: `ready` once the host runtime has a
 * request context, `open()` opens the dialog from the store exactly as the
 * Providers settings entry does, `setTheme(mode)` flips the theme, and
 * `holdRequests(true)` makes every intent after it stay in flight.
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
const AIR_HOST_ID = "fixture-host-air";
const LAPTOP_HOST_ID = "fixture-host-laptop";
const MINI_HOST_ID = "fixture-host-mini";
const REMOTE_HOSTS: readonly HostDirectoryEntry[] = [
  {
    hostId: AIR_HOST_ID,
    label: "Air",
    kind: "remote",
    websocketUrl: "ws://127.0.0.1:9/air",
    version: "1.2.3",
    transportDialability: "dialable",
  },
  {
    hostId: LAPTOP_HOST_ID,
    label:
      "Travel laptop with a deliberately long device name that must truncate",
    kind: "remote",
    websocketUrl: "ws://127.0.0.1:9/laptop",
    version: "1.2.3",
    transportDialability: "dialable",
  },
  {
    hostId: MINI_HOST_ID,
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

function profileUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const SYNCED_NAMES = [
  "Personal",
  "Work",
  "Company",
  "Side project",
  "Client A",
  "Client B",
  "Research",
  "Team",
  "Sandbox",
  "Staging",
  "A profile with a deliberately long name that must truncate in its row",
] as const;

/** 13 profiles: two that need the user, eleven behind "Show all 13". */
const AIR_ITEMS: ProfileSyncItem[] = [
  {
    providerId: "claude",
    sourceProfileId: profileUuid(1),
    name: "Surya 2",
    status: "sign-in-needed",
    reason: null,
  },
  {
    providerId: "codex",
    sourceProfileId: profileUuid(2),
    name: "Team",
    status: "cannot-sync",
    reason: "account-changed",
  },
  ...SYNCED_NAMES.map((name, index): ProfileSyncItem => ({
    providerId: index % 2 === 0 ? "claude" : "grok",
    sourceProfileId: profileUuid(index + 3),
    name,
    status: "synced",
    reason: null,
  })),
];

/** The source cannot reach it: every profile waits for the device. */
const MINI_ITEMS: ProfileSyncItem[] = AIR_ITEMS.map(
  (item): ProfileSyncItem => ({
    ...item,
    status: "device-offline",
    reason: null,
  }),
);

let devices: ProfileSyncDevice[] = [
  { hostId: AIR_HOST_ID, keepInSync: true, items: AIR_ITEMS },
  { hostId: MINI_HOST_ID, keepInSync: true, items: MINI_ITEMS },
];
let holdingRequests = false;

function overview(): ProfileSyncOverview {
  return {
    sourceHostId: LOCAL_HOST.hostId,
    profileCount: AIR_ITEMS.length,
    devices,
  };
}

/** One device's record replaced, or added when the source had none. */
function writeDevice(
  hostId: string,
  update: (previous: ProfileSyncDevice | null) => ProfileSyncDevice,
): void {
  const previous = devices.find((device) => device.hostId === hostId) ?? null;
  devices = [
    ...devices.filter((device) => device.hostId !== hostId),
    update(previous),
  ];
}

function syncingItems(): ProfileSyncItem[] {
  return AIR_ITEMS.map((item): ProfileSyncItem => ({
    ...item,
    status: "syncing",
    reason: null,
  }));
}

/** A held intent never answers, so its control stays pending. */
function held(): Promise<ProfileSyncOverview> {
  return new Promise<ProfileSyncOverview>(() => {});
}

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
      "providers.profileSync.overview": () => overview(),
      "providers.profileSync.syncNow": (params) => {
        if (holdingRequests) return held();
        writeDevice(params.destinationHostId, (previous) => ({
          hostId: params.destinationHostId,
          keepInSync: previous?.keepInSync ?? false,
          items: syncingItems(),
        }));
        return overview();
      },
      "providers.profileSync.setKeepInSync": (params) => {
        if (holdingRequests) return held();
        writeDevice(params.destinationHostId, (previous) => ({
          hostId: params.destinationHostId,
          keepInSync: params.enabled,
          items: previous?.items ?? syncingItems(),
        }));
        return overview();
      },
      "providers.profileSync.acceptAccount": (params) => {
        if (holdingRequests) return held();
        writeDevice(params.destinationHostId, (previous) => ({
          hostId: params.destinationHostId,
          keepInSync: previous?.keepInSync ?? false,
          items: (previous?.items ?? []).map((item): ProfileSyncItem =>
            item.providerId === params.providerId &&
            item.sourceProfileId === params.sourceProfileId
              ? { ...item, status: "syncing", reason: null }
              : item,
          ),
        }));
        return overview();
      },
    },
  });

interface ProfileSyncProbe {
  readonly ready: boolean;
  readonly open: () => void;
  readonly setTheme: (mode: "light" | "dark") => void;
  readonly holdRequests: (hold: boolean) => void;
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
      open: () => {
        useProfileSyncModalStore.getState().open(LOCAL_HOST.hostId);
      },
      setTheme: (mode) => {
        useSettingsStore.getState().setTheme(mode);
      },
      holdRequests: (hold) => {
        holdingRequests = hold;
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
              <ProfileSyncModalHost />
            </RequestContext>
          </TooltipProvider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const container = document.getElementById("root");
if (container !== null) createRoot(container).render(<Page />);
