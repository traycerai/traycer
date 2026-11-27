// A failed read of the host's recent decisions: the computer never answering
// shows the away notice, anything it answered keeps the page's own line. The
// scope the notice names is the REAL `usePersonalHostScope`; only the host
// lists it reads and the host client are stood in.
import "../../../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { AUTO_JUDGE_RECENT_LIMIT_MAX } from "@traycer/protocol/host/auto-mode/contracts";
import { ActivityTab } from "@/components/settings/panels/permissions/activity-tab";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { queryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const hostMock = vi.hoisted(
  (): { client: unknown; binding: { readonly auth: unknown } | null } => ({
    client: null,
    binding: null,
  }),
);

vi.mock("@/hooks/host/use-addressable-host-id", async () => {
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  return { useAddressableHostId: () => entry.hostId };
});
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => hostMock.client,
  useHostBinding: () => hostMock.binding,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/chats/use-visible-chats", () => ({
  useVisibleChats: () => new Map(),
}));
// The host lists the scope reads: one listed, reachable computer.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  const options = hostOptionsFixture({
    hosts: [
      hostScopeOptionFixture({ hostId: entry.hostId, name: "Studio Mac" }),
    ],
  });
  return { useHostOptions: () => options };
});
// The scope would dial a host it does not follow; this one is followed, so no
// client of its own is built.
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

const OWN_LINE =
  "Couldn't read this host's recent decisions. Reopen Settings to try again.";
const AWAY_TITLE = "Can't reach Studio Mac from here";

type ReadAnswer = "transport" | "refusal" | "answered";

function transportFailure(): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "The relay did not answer.",
    requestId: "req-away",
    method: "autoJudge.listRecent",
    fatalDetails: null,
  });
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "The host refused the read.",
    requestId: "req-refused",
    method: "autoJudge.listRecent",
    fatalDetails: null,
  });
}

interface Page {
  readonly queryClient: QueryClient;
  readonly answer: { current: ReadAnswer };
}

function renderPage(first: ReadAnswer): Page {
  const answer = { current: first };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-activity",
    handlers: {
      "autoJudge.listRecent": () => {
        if (answer.current === "transport") {
          return Promise.reject(transportFailure());
        }
        if (answer.current === "refusal") return Promise.reject(refusal());
        return Promise.resolve({
          entries: [
            {
              id: "entry-1",
              at: new Date().toISOString(),
              chatId: "chat-1",
              chatTitle: "Fix the build",
              toolName: "Bash",
              inputSummary: "git push --force origin main",
              outcome: "allow",
              stage: "fast",
              rule: null,
              reason: null,
              tier: null,
              judge: { harnessId: "traycer", model: "haiku" },
              judgeKind: "traycer",
              judgeSource: "default",
              unattended: false,
              failureKind: null,
            },
          ],
        });
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostMock.client = spine.createRequester(mockLocalHostEntry);
  hostMock.binding = { auth: null };
  recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
    "autoJudge.listRecent",
  ]);
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
        <ActivityTab
          onAllowFromNowOn={() => undefined}
          onFixInJudge={() => undefined}
        />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { queryClient, answer };
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.client = null;
  hostMock.binding = null;
});

describe("<ActivityTab /> a failed read of the host", () => {
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

  it("lists the decisions and drops the notice once the computer answers again", async () => {
    const page = renderPage("transport");
    await screen.findByTestId("host-scope-unreachable");

    page.answer.current = "answered";
    await act(async () => {
      await page.queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<HostRpcRegistry, "autoJudge.listRecent">(
          mockLocalHostEntry.hostId,
          "autoJudge.listRecent",
          { limit: AUTO_JUDGE_RECENT_LIMIT_MAX },
        ),
      });
    });

    expect(
      await screen.findByText("git push --force origin main"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    });
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });
});
