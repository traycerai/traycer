// An edit made while the host cannot reach the
// environment shows "Pending" and clears on its receipt after the host
// reconnects. `personal-page-frame.test.tsx` reads one status snapshot; this
// suite follows ONE mounted page across the host's answer changing, which is
// what a person watching the page actually sees.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { usePersonalRowNotes } from "@/components/settings/personal/personal-page-context";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  HostRuntimeContext,
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const HOST_ID = "host-a";
const HOST_NAME = "dev-box";
const OFFLINE_LINE = "Changes apply on dev-box when it reconnects.";

afterEach(() => {
  useSettingsEnvironmentPickStore.setState({ pick: null });
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
});

function RowNotesProbe(): ReactNode {
  const notes = usePersonalRowNotes("variable");
  return (
    <ul data-testid="row-notes">
      {[...notes.entries()].map(([key, note]) => (
        <li key={key}>{`${key}: ${note}`}</li>
      ))}
    </ul>
  );
}

/**
 * The page under the host runtime Settings gives it: the real provider, and
 * the scope's client re-provided the way a host-scoped panel does, so the
 * page's own chip reads the same host the page does.
 */
function ScopedHostRuntime(props: {
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RunnerHostProvider
      runnerHost={
        new MockRunnerHost({
          signInUrl: "https://auth.traycer.invalid/sign-in",
          authnBaseUrl: "https://authn.traycer.invalid",
          localHost: null,
          hosts: [],
          workspaceFolderPickerPaths: undefined,
          hasLocalHost: undefined,
          traycerCli: undefined,
        })
      }
    >
      <HostRuntimeProvider
        registry={hostRpcRegistry}
        messengerFactory={(args) =>
          new MockHostMessenger<HostRpcRegistry>({
            registry: args.registry,
            requestId: () => "req-runtime",
            handlers: props.handlers,
          })
        }
        invalidator={null}
        requestId={null}
        remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
        fallback={null}
      >
        <ScopedBinding>{props.children}</ScopedBinding>
      </HostRuntimeProvider>
    </RunnerHostProvider>
  );
}

function ScopedBinding(props: { readonly children: ReactNode }): ReactNode {
  const binding = useScopedHostBinding(useHostScope());
  return (
    <HostRuntimeContext.Provider value={binding}>
      {props.children}
    </HostRuntimeContext.Provider>
  );
}

interface MountedPage {
  /** Change what the host answers, then make the page read it again. */
  readonly hostNowAnswers: (
    status: EnvironmentStatusResponseV11,
  ) => Promise<void>;
}

function mountPageOver(first: EnvironmentStatusResponseV11): MountedPage {
  const answer: { current: EnvironmentStatusResponseV11 } = { current: first };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => answer.current,
    "environment.localOverrides": () => ({ overrides: [] }),
  };
  const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
  recordNegotiatedHostMethods(HOST_ID, [
    "environment.status",
    "environment.localOverrides",
  ]);
  // These cases are about a host's own pages, which a Local row reads.
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: HOST_ID, hostName: HOST_NAME },
  });
  scopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId: HOST_ID, name: HOST_NAME }),
    hostId: HOST_ID,
    status: "ready",
    client,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ScopedHostRuntime handlers={handlers}>
        <PersonalPageFrame section="shell">
          <SettingsPanelShell title="Shell" description="How terminals start.">
            <RowNotesProbe />
          </SettingsPanelShell>
        </PersonalPageFrame>
      </ScopedHostRuntime>
    </QueryClientProvider>,
  );
  return {
    hostNowAnswers: async (status) => {
      answer.current = status;
      await queryClient.invalidateQueries();
    },
  };
}

function notes(): string[] {
  return within(screen.getByTestId("row-notes"))
    .queryAllByRole("listitem")
    .map((item) => item.textContent)
    .sort();
}

/** The page's status line, or null while the page has nothing to say. */
function statusLine(): string | null {
  return screen.queryByTestId("personal-page-status")?.textContent ?? null;
}

function waitingEdit(
  reachability: EnvironmentStatusResponseV11["reachability"],
) {
  return environmentStatusFixture({
    reachability,
    pendingUploads: [pendingUploadFixture({ kind: "variable", key: "EDITED" })],
  });
}

describe("an edit made while the host is out of reach", () => {
  it("is Pending, with the page saying changes wait for the reconnect, until the receipt is accepted", async () => {
    const page = mountPageOver(waitingEdit("reconnecting"));
    await vi.waitFor(() => {
      expect(notes()).toEqual(["EDITED: Pending"]);
    });
    expect(
      (await screen.findByTestId("personal-page-status")).textContent,
    ).toBe(OFFLINE_LINE);

    await page.hostNowAnswers(
      environmentStatusFixture({
        reachability: "connected",
        pendingUploads: [
          pendingUploadFixture({
            kind: "variable",
            key: "EDITED",
            receipt: "accepted",
          }),
        ],
      }),
    );

    await vi.waitFor(() => {
      expect(notes()).toEqual([]);
    });
    expect(statusLine()).not.toBe(OFFLINE_LINE);
  });

  it("stays Pending across a reconnect that has not yet delivered its receipt", async () => {
    const page = mountPageOver(waitingEdit("reconnecting"));
    await vi.waitFor(() => {
      expect(notes()).toEqual(["EDITED: Pending"]);
    });

    await page.hostNowAnswers(waitingEdit("connected"));

    await vi.waitFor(() => {
      expect(statusLine()).not.toBe(OFFLINE_LINE);
    });
    expect(notes()).toEqual(["EDITED: Pending"]);
  });

  it("clears only the edit whose receipt arrived, not its neighbour's", async () => {
    const page = mountPageOver(
      environmentStatusFixture({
        reachability: "reconnecting",
        pendingUploads: [
          pendingUploadFixture({ kind: "variable", key: "FIRST" }),
          pendingUploadFixture({ kind: "variable", key: "SECOND" }),
        ],
      }),
    );
    await vi.waitFor(() => {
      expect(notes()).toEqual(["FIRST: Pending", "SECOND: Pending"]);
    });

    await page.hostNowAnswers(
      environmentStatusFixture({
        reachability: "connected",
        pendingUploads: [
          pendingUploadFixture({
            kind: "variable",
            key: "FIRST",
            receipt: "accepted",
          }),
          pendingUploadFixture({ kind: "variable", key: "SECOND" }),
        ],
      }),
    );

    await vi.waitFor(() => {
      expect(notes()).toEqual(["SECOND: Pending"]);
    });
  });
});
