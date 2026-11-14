import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";

interface ProvidersChangedMockState {
  hostId: string;
  onChanged: ((providerId: ProviderId) => void) | null;
  closes: number;
}

const providersChangedMock = vi.hoisted((): ProvidersChangedMockState => ({
  hostId: "host-list-notification",
  onChanged: null,
  closes: 0,
}));

const clientMock = vi.hoisted(
  (): {
    current:
      | import("@traycer-clients/shared/host-client/host-client").HostClient<
          import("@/lib/host").HostRpcRegistry
        >
      | null;
  } => ({
    current: null,
  }),
);

const streamClientStub = vi.hoisted((): { readonly stub: true } => ({
  stub: true,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/providers-changed-stream-client",
  () => ({
    ProvidersChangedStreamClient: class {
      constructor(options: {
        readonly onChanged: (providerId: ProviderId) => void;
      }) {
        providersChangedMock.onChanged = options.onChanged;
      }

      close(): void {
        providersChangedMock.closes += 1;
      }
    },
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => streamClientStub,
  useStreamMethodSupport: () => "supported",
  useStreamHostId: () => providersChangedMock.hostId,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientMock.current };
});

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: () => clientMock.current };
});

vi.mock("@/lib/links/open-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links/open-link")>();
  return {
    ...actual,
    useOpenLink: () => () => Promise.resolve(),
  };
});

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ProviderProfileAddFlowHost } from "@/components/providers/provider-profile-add-flow-host";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { hostQueryKeys } from "@/lib/query-keys";
import { ProvidersChangedStreamMount } from "@/providers/providers-changed-stream-mount";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";

const HOST_ID = "host-list-notification";
const PROVIDER_ID = "claude-code";
const PROFILE_ID = "work";
const PROFILER_ID = "picker-add-flow";
const LIST_KEY = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
  HOST_ID,
  "providers.list",
  { native: null },
);

type Offers = true | false | "absent";
type ListResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;

interface DialogCopy {
  readonly text: string;
  readonly buttons: readonly string[];
}

interface PickerHarness {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly beforeResponse: ListResponse;
  readonly afterResponse: ListResponse;
  readonly setResponseAfterPush: () => void;
  readonly commitCount: () => number;
}

afterEach(() => {
  cleanup();
  useProviderProfileAddFlowStore.getState().close();
  useDesktopDialogStore.setState({ reportIssueAvailable: false });
  clientMock.current = null;
  providersChangedMock.onChanged = null;
  providersChangedMock.closes = 0;
  resetNegotiatedManifests();
  resetHostConnectionRegistryForTest();
});

function profileRow(label: string): ProviderProfile {
  return { ...profile(PROFILE_ID, "managed"), label };
}

function listBody(
  offers: Offers,
  profiles: readonly ProviderProfile[],
): ListResponse {
  const body: ListResponse = {
    providers: [provider(PROVIDER_ID, [...profiles])],
    native: null,
  };
  if (offers === "absent") return body;
  return { ...body, offersSignIns: offers };
}

function renderPickerAdd(input: {
  readonly offers: Offers;
  readonly initialResponse: ListResponse;
  readonly responseAfterPush: ListResponse;
}): PickerHarness {
  let currentResponse = input.initialResponse;
  let commitCount = 0;
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => currentResponse,
    },
  });
  clientMock.current = client;
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.list": { major: 10, minor: 12 },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useProviderProfileAddFlowStore
    .getState()
    .openForHarness("claude", null, () => undefined);
  render(
    <Profiler
      id={PROFILER_ID}
      onRender={() => {
        commitCount += 1;
      }}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProvidersChangedStreamMount />
          <ProviderProfileAddFlowHost />
        </TooltipProvider>
      </QueryClientProvider>
    </Profiler>,
  );
  return {
    client,
    messenger,
    queryClient,
    beforeResponse: input.initialResponse,
    afterResponse: input.responseAfterPush,
    setResponseAfterPush: () => {
      currentResponse = input.responseAfterPush;
    },
    commitCount: () => commitCount,
  };
}

function methodCount(
  calls: readonly { readonly method: string }[],
  method: string,
): number {
  return calls.filter((call) => call.method === method).length;
}

function dialogCopy(): DialogCopy {
  const dialog = screen.getByRole("dialog");
  return {
    text: dialog.textContent.trim(),
    buttons: within(dialog)
      .getAllByRole("button")
      .map((button) =>
        (button.getAttribute("aria-label") ?? button.textContent).trim(),
      ),
  };
}

async function expectSettledDialog(offers: Offers): Promise<void> {
  const heading =
    offers === true ? "Add a profile" : "Add new Claude Code profile";
  const signInName = offers === true ? "Sign in" : "Link account";
  expect(await screen.findByRole("dialog", { name: heading })).toBeTruthy();
  expect(screen.getByRole("button", { name: signInName })).toBeTruthy();
}

function emitChanged(): void {
  const changed = providersChangedMock.onChanged;
  if (changed === null)
    throw new Error("providers.changed stream did not open");
  act(() => {
    changed(PROVIDER_ID);
  });
}

async function settleListRefetch(
  harness: PickerHarness,
  expectedCalls: number,
): Promise<void> {
  await waitFor(() => {
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(
      expectedCalls,
    );
    expect(harness.queryClient.getQueryState(LIST_KEY)?.fetchStatus).toBe(
      "idle",
    );
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      harness.afterResponse,
    );
  });
}

function expectNoLoginRequests(harness: PickerHarness): void {
  expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(0);
  expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(0);
  expect(methodCount(harness.messenger.calls, "providers.cancelLogin")).toBe(0);
}

// No observer-beside-Add case: ProviderProfileAddFlowHost observes providers.list at provider-profile-add-flow-host.tsx:56.
describe("provider list push stability while Add is open", () => {
  it.each([true, false, "absent"] as const)(
    "refetches identical list data once and keeps Add copy unchanged when offersSignIns is %s",
    async (offers) => {
      const beforeResponse = listBody(offers, [profileRow("Work")]);
      const harness = renderPickerAdd({
        offers,
        initialResponse: beforeResponse,
        responseAfterPush: beforeResponse,
      });
      await expectSettledDialog(offers);
      await waitFor(() => {
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
        expect(harness.queryClient.getQueryState(LIST_KEY)?.fetchStatus).toBe(
          "idle",
        );
      });
      const initialCopy = dialogCopy();
      const initialBytes = JSON.stringify(
        harness.queryClient.getQueryData(LIST_KEY),
      );
      const initialListReads = methodCount(
        harness.messenger.calls,
        "providers.list",
      );
      expect(initialListReads).toBe(1);
      expect(initialBytes).toBe(JSON.stringify(beforeResponse));

      const commitsBeforePush = harness.commitCount();
      harness.setResponseAfterPush();
      emitChanged();
      await settleListRefetch(harness, initialListReads + 1);
      expect(harness.commitCount() - commitsBeforePush).toBe(0);

      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(
        initialListReads + 1,
      );
      expectNoLoginRequests(harness);
      expect(dialogCopy()).toEqual(initialCopy);
      expect(JSON.stringify(harness.queryClient.getQueryData(LIST_KEY))).toBe(
        initialBytes,
      );
    },
  );

  it.each([true, false, "absent"] as const)(
    "keeps Add copy unchanged when profile data changes but offersSignIns is %s",
    async (offers) => {
      const beforeResponse = listBody(offers, [profileRow("Before")]);
      const afterResponse = listBody(offers, [profileRow("After")]);
      const harness = renderPickerAdd({
        offers,
        initialResponse: beforeResponse,
        responseAfterPush: afterResponse,
      });
      await expectSettledDialog(offers);
      await waitFor(() => {
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
        expect(harness.queryClient.getQueryState(LIST_KEY)?.fetchStatus).toBe(
          "idle",
        );
      });
      const initialCopy = dialogCopy();
      const beforeBytes = JSON.stringify(
        harness.queryClient.getQueryData(LIST_KEY),
      );
      const initialListReads = methodCount(
        harness.messenger.calls,
        "providers.list",
      );
      expect(initialListReads).toBe(1);
      expect(beforeBytes).toBe(JSON.stringify(beforeResponse));

      const commitsBeforePush = harness.commitCount();
      harness.setResponseAfterPush();
      emitChanged();
      await settleListRefetch(harness, initialListReads + 1);
      expect(harness.commitCount() - commitsBeforePush).toBe(1);

      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(
        initialListReads + 1,
      );
      expectNoLoginRequests(harness);
      expect(dialogCopy()).toEqual(initialCopy);
      expect(beforeBytes).not.toBe(JSON.stringify(afterResponse));
      expect(JSON.stringify(harness.queryClient.getQueryData(LIST_KEY))).toBe(
        JSON.stringify(afterResponse),
      );
    },
  );
});
