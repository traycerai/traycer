// An unresolved page whose settings read failed: the computer never answering
// shows the away notice, anything it answered keeps the page's own line. The
// frame, the window's scope and the read are real; only the host lists the
// scope reads and the host client are stood in. The page itself starts no
// read: the status read it observes is the one the settings surface makes, so
// `StatusRead` makes it the way that surface does.
const hostMock = vi.hoisted((): { client: unknown } => ({ client: null }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => hostMock.client,
}));
// The host lists the scope reads: one listed, reachable computer.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({
    hosts: [hostScopeOptionFixture({ hostId: "host-a", name: "Studio Mac" })],
  });
  return { useHostOptions: () => options };
});
// The scope would dial a host it does not follow; this one is followed, so no
// client of its own is built.
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { UNRESOLVED_PICK } from "@/lib/settings-environment-pages";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const OWN_LINE = "Couldn't read these settings.";
const AWAY_TITLE = "Can't reach Studio Mac from here";

type ReadAnswer = "transport" | "refusal" | "answered";

function transportFailure(): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "The relay did not answer.",
    requestId: "req-away",
    method: "environment.status",
    fatalDetails: null,
  });
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "The host refused the read.",
    requestId: "req-refused",
    method: "environment.status",
    fatalDetails: null,
  });
}

beforeEach(() => {
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: UNRESOLVED_PICK,
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.client = null;
});

/** The window host's status read, which the unresolved page observes. */
function StatusRead(): null {
  const scope = usePersonalHostScope();
  useEnvironmentStatusRead(scope.client, scope.hostId, true);
  return null;
}

interface Page {
  readonly queryClient: QueryClient;
  readonly answer: { current: ReadAnswer };
  readonly reads: { current: number };
}

function renderPage(first: ReadAnswer): Page {
  const answer = { current: first };
  const reads = { current: 0 };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => {
      reads.current += 1;
      if (answer.current === "transport") {
        return Promise.reject(transportFailure());
      }
      if (answer.current === "refusal") return Promise.reject(refusal());
      return Promise.resolve(environmentStatusFixture({}));
    },
  };
  hostMock.client = buildEnvironmentClient({
    hostId: "host-a",
    handlers,
  }).client;
  recordNegotiatedHostMethods("host-a", ["environment.status"]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <StatusRead />
        <PersonalPageFrame section="providers">
          <button>Edit configuration</button>
        </PersonalPageFrame>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { queryClient, answer, reads };
}

describe("<UnresolvedEnvironmentPage /> a failed settings read", () => {
  it("shows the away notice, not the page's own line, when the computer never answered", async () => {
    renderPage("transport");

    const notice = await screen.findByTestId("host-scope-unreachable");
    expect(notice.textContent).toContain(AWAY_TITLE);
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });

  it("keeps the page's own line when the computer answered with a refusal", async () => {
    renderPage("refusal");

    expect(await screen.findByText(OWN_LINE)).toBeTruthy();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });

  it("returns to the page's loading state, without the notice, once the computer answers again", async () => {
    const page = renderPage("transport");
    await screen.findByTestId("host-scope-unreachable");

    page.answer.current = "answered";
    await act(async () => {
      await page.queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
          "host-a",
          "environment.status",
          {},
        ),
      });
    });

    expect(
      await screen.findByTestId("environment-source-loading"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    });
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });

  it("draws the page's own Retry inside the notice, and a press reads again and leaves the failure", async () => {
    const page = renderPage("transport");
    const notice = await screen.findByTestId("host-scope-unreachable");
    const retry = within(notice).getByRole("button", { name: "Retry" });
    expect(screen.queryByText(OWN_LINE)).toBeNull();
    const readsBefore = page.reads.current;

    page.answer.current = "answered";
    await userEvent.click(retry);

    expect(
      await screen.findByTestId("environment-source-loading"),
    ).toBeTruthy();
    expect(page.reads.current).toBeGreaterThan(readsBefore);
    await waitFor(() => {
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    });
  });
});
