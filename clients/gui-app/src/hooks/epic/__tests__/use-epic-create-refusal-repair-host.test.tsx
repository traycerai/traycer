import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  CreateEpicRequest,
  CreateEpicResponse,
  EpicCreateRefusal,
} from "@traycer/protocol/host/epic/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useEpicCreateForClient } from "@/hooks/epic/use-epic-create-mutation";
import { LocalStoreRepairDialogHost } from "@/components/local-store/local-store-repair-dialog-host";
import {
  closeLocalStoreRepair,
  openLocalStoreRepair,
  useLocalStoreRepairStore,
} from "@/stores/local-store/local-store-repair-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * A refused `epic.create` offers its repair on the host that REFUSED - the
 * placement host the create was dispatched to - and not on the window's
 * effective host.
 *
 * The two are the same value on an unpinned window, which is why this needs its
 * own fixture: every host-id read in the create path looks correct until a
 * surface pin makes them differ, and then repairing the effective host rebinds
 * a healthy store, reports success, and leaves the refusing one untouched. So
 * both hosts here are real and distinct, with the EFFECTIVE one set to the host
 * the create was NOT sent on - if any link in the chain re-derives a host
 * instead of carrying the dispatched one, it lands on `EFFECTIVE_HOST_ID` and
 * these assertions fail.
 *
 * The chain has three links and each is pinned below: the mutation's captured
 * dispatch host, the toast action's payload, and the dialog's two host-scoped
 * hooks.
 */

const PLACEMENT_HOST_ID = mockLocalHostEntry.hostId;
const EFFECTIVE_HOST_ID = mockRemoteHostEntry.hostId;
const USER_ID = "user-1";
const PROFILE = { userId: USER_ID, userName: "A", email: "a@example.com" };
const CONTEXT = { userId: USER_ID, username: USER_ID };

const REFUSAL: EpicCreateRefusal = {
  kind: "local-store-unavailable",
  message:
    "Traycer can't open this device's local store, so nothing was created.",
  remedy: "Quit the other Traycer running on this machine, then rebind.",
};

const CREATE_VARIABLES: CreateEpicRequest = {
  epic: {
    id: "epic-1",
    title: "Epic",
    initialUserPrompt: "hi",
    ticketCount: 0,
    specCount: 0,
    storyCount: 0,
    reviewCount: 0,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    createdBy: USER_ID,
    version: "1",
  },
  repoIdentifiers: [],
  workspaces: [],
  chat: null,
};

const ACCEPTED_RESPONSE: CreateEpicResponse = {
  roomInfo: null,
  task: null,
  initialTurnStarted: null,
};

const REFUSED_RESPONSE: CreateEpicResponse = {
  ...ACCEPTED_RESPONSE,
  refusal: REFUSAL,
};

interface CapturedToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

const toastErrorCalls: {
  message: string;
  description: string | undefined;
  action: CapturedToastAction | undefined;
}[] = [];

vi.mock("sonner", () => ({
  toast: {
    error: (
      message: string,
      options:
        | {
            readonly description: string | undefined;
            readonly action: CapturedToastAction | undefined;
          }
        | undefined,
    ) => {
      toastErrorCalls.push({
        message,
        description: options?.description,
        action: options?.action,
      });
    },
    success: () => undefined,
  },
}));

// The dialog's two host-scoped reads, recorded rather than resolved. A real
// `useHostSupportsMethod` needs the compatibility provider and a negotiated
// manifest, neither of which is the subject here - what is being pinned is
// WHICH host id reaches them, and a recorded argument states that directly
// instead of inferring it from a rendered button.
const rebindHostIds: (string | null)[] = [];
const supportsMethodArgs: { hostId: string | null; method: string }[] = [];

vi.mock("@/hooks/local-store/use-local-store-rebind-mutation", () => ({
  useLocalStoreRebindMutation: (hostId: string | null) => {
    rebindHostIds.push(hostId);
    return {
      mutate: () => undefined,
      isPending: false,
      isHostEntryPending: false,
    };
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    supportsMethodArgs.push({ hostId, method });
    return true;
  },
}));

function createFixture(response: CreateEpicResponse): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-create-refusal",
    handlers: { "epic.create": () => response },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === PLACEMENT_HOST_ID ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      identity: { userId: USER_ID, username: USER_ID, providerHandle: null },
      origin: "renderer",
    }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  return { client: spine.createRequester(mockLocalHostEntry), Wrapper };
}

beforeEach(() => {
  toastErrorCalls.length = 0;
  rebindHostIds.length = 0;
  supportsMethodArgs.length = 0;
  useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  // The window points at the OTHER host. This is the whole fixture: without it
  // every assertion below passes against a re-derived host id too.
  useSelectionAuthorityStore.setState({ effectiveHostId: EFFECTIVE_HOST_ID });
});

afterEach(() => {
  // `globals: false` - RTL's auto-cleanup never registers, so an unmounted
  // dialog from one case would still be in the document for the next.
  cleanup();
  closeLocalStoreRepair();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useSelectionAuthorityStore.setState(
    useSelectionAuthorityStore.getInitialState(),
    true,
  );
});

describe("a refused epic.create repairs the host it was dispatched to", () => {
  it("names the two hosts as genuinely different (the fixture's own control)", () => {
    // Stated as an assertion because every "not the effective host" claim in
    // this file is vacuous if these two ids ever collapse to one value - a
    // mock-directory edit could do it silently.
    expect(PLACEMENT_HOST_ID).not.toBe(EFFECTIVE_HOST_ID);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      EFFECTIVE_HOST_ID,
    );
  });

  it("offers Repair for the PLACEMENT host, carrying the host's own words", async () => {
    const fixture = createFixture(REFUSED_RESPONSE);
    const rendered = renderHook(() => useEpicCreateForClient(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    // RESOLVES. The refusal is data on a successful response, so a create that
    // did not happen settles through `onSuccess` - asserting the resolution is
    // half the regression, since a future discriminated arm that threw would
    // silently move this whole path into `onError`.
    await rendered.result.current.mutateAsync(CREATE_VARIABLES);

    expect(toastErrorCalls).toHaveLength(1);
    // Indexed non-optionally: the length assertion above already establishes
    // the call, so `call?.` was an optional chain on a value the type says is
    // present. `action` keeps its chain - that one is `| undefined` on the
    // captured shape, so the question it asks is real.
    const call = toastErrorCalls[0];
    // Verbatim, both of them: the typed arm exists so the host's sentences
    // reach the screen instead of "Couldn't create epic."
    expect(call.message).toBe(REFUSAL.message);
    expect(call.description).toBe(REFUSAL.remedy);
    expect(call.action?.label).toBe("Repair");

    // Nothing is pending until the user asks for the repair.
    expect(useLocalStoreRepairStore.getState().pending).toBeNull();
    call.action?.onClick();

    const pending = useLocalStoreRepairStore.getState().pending;
    expect(pending?.hostId).toBe(PLACEMENT_HOST_ID);
    expect(pending?.hostId).not.toBe(EFFECTIVE_HOST_ID);
    expect(pending?.refusal).toEqual(REFUSAL);
  });

  it("scopes the dialog's gate and its rebind to that same host", () => {
    openLocalStoreRepair({ hostId: PLACEMENT_HOST_ID, refusal: REFUSAL });

    render(createElement(LocalStoreRepairDialogHost));

    // The gate asks about the refusing host's manifest. `host.rebindLocalStore`
    // is an optional unary, so asking the window's host could offer a repair
    // the refusing host cannot serve (or withhold one it can).
    expect(supportsMethodArgs).toContainEqual({
      hostId: PLACEMENT_HOST_ID,
      method: "host.rebindLocalStore",
    });
    expect(supportsMethodArgs.some((a) => a.hostId === EFFECTIVE_HOST_ID)).toBe(
      false,
    );

    // And the mutation that would actually rebind is bound to it too.
    expect(rebindHostIds).toContain(PLACEMENT_HOST_ID);
    expect(rebindHostIds).not.toContain(EFFECTIVE_HOST_ID);
  });

  it("renders no refusal toast and offers no repair when the create is accepted", async () => {
    // The control. `refusal` is an OPTIONAL key, so an accepted create differs
    // from a refused one by its absence alone - a branch written on a
    // truthiness test over the wrong field would fire here.
    const fixture = createFixture(ACCEPTED_RESPONSE);
    const rendered = renderHook(() => useEpicCreateForClient(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await rendered.result.current.mutateAsync(CREATE_VARIABLES);

    expect(toastErrorCalls).toHaveLength(0);
    expect(useLocalStoreRepairStore.getState().pending).toBeNull();
  });
});
