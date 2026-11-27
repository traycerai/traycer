// A failed read of the account's auto-archive setting: the computer never
// answering puts the away line in the status's place, anything it answered
// keeps the row's own line. The scope that names the computer is the REAL
// `useAccountHostScope`; only the host lists it reads and the host client are
// stood in.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostEntryFixture } from "@/lib/environment/__tests__/environment-test-support";
import { ChatAutoArchiveSettingsRow } from "@/components/settings/panels/chat-auto-archive-settings-row";
import { CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS } from "@/components/settings/panels/chat-auto-archive-copy";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const client = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "user-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/lib/analytics", () => ({
  trackSettingChanged: () => undefined,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => client.current,
}));
// The host lists the scope reads: one listed, reachable computer.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({
    hosts: [hostScopeOptionFixture({ hostId: "host-1", name: "Studio Mac" })],
  });
  return { useHostOptions: () => options };
});
// The scope would dial a host it does not follow; this one is followed, so no
// client of its own is built.
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

const AWAY_LINE = "Can't reach Studio Mac from here";
const ROW_DESCRIPTION =
  "Tidy up chats agents started once they go quiet. Applies on all your hosts.";

type ReadAnswer = "transport" | "refusal" | "answered";

function transportFailure(): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "The relay did not answer.",
    requestId: "req-away",
    method: "chatAutoArchive.get",
    fatalDetails: null,
  });
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "The host refused the read.",
    requestId: "req-refused",
    method: "chatAutoArchive.get",
    fatalDetails: null,
  });
}

interface Page {
  readonly queryClient: QueryClient;
  readonly answer: { current: ReadAnswer };
}

function renderRow(first: ReadAnswer): Page {
  const answer = { current: first };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-auto-archive",
    handlers: {
      "chatAutoArchive.get": () => {
        if (answer.current === "transport") {
          return Promise.reject(transportFailure());
        }
        if (answer.current === "refusal") return Promise.reject(refusal());
        return Promise.resolve({
          policy: null,
          bounds: { minSeconds: 1, maxSeconds: 31_536_000 },
        });
      },
    },
  });
  const entry = hostEntryFixture("host-1");
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  client.current = spine.createRequester(entry);
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
        <ChatAutoArchiveSettingsRow />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { queryClient, answer };
}

afterEach(() => {
  cleanup();
  client.current = null;
});

describe("<ChatAutoArchiveSettingsRow /> a failed read of the host", () => {
  it("shows the away line in the status's place when the computer never answered", async () => {
    renderRow("transport");

    expect(await screen.findByText(AWAY_LINE)).toBeTruthy();
    expect(screen.getByText(ROW_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByText(CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS)).toBeNull();
  });

  it("keeps the row's own line when the computer answered with a refusal", async () => {
    renderRow("refusal");

    expect(
      await screen.findByText(CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS),
    ).toBeTruthy();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });

  it("shows the row's normal status and a live switch once the computer answers again", async () => {
    const page = renderRow("transport");
    await screen.findByText(AWAY_LINE);

    page.answer.current = "answered";
    await act(async () => {
      await page.queryClient.invalidateQueries({
        queryKey: hostQueryKeys.chatAutoArchiveForViewer("host-1", "user-a"),
      });
    });

    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Archive idle agents automatically" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(screen.getByText(ROW_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByText(AWAY_LINE)).toBeNull();
    expect(screen.queryByText(CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS)).toBeNull();
  });
});
