import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
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
  CreateEpicRequestV12,
  CreateEpicResponse,
  CreateEpicResponseV12,
  EpicCreateRefusal,
  EpicCreateRefusalV12,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  RebindLocalStoreRequest,
  RebindLocalStoreResponse,
} from "@traycer/protocol/host/local-store/schemas";
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
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { putImage } from "@/lib/composer/composer-image-store";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  clearEpicCreateSeedPending,
  markEpicCreateSeedPending,
  readEpicCreateSeed,
} from "@/lib/worktree/pending-epic-create-seeds";

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

interface RebindMutateCallbacks {
  readonly onSuccess: (response: RebindLocalStoreResponse) => void;
}
/**
 * Every `mutate(...)` call the dialog made, so a test can invoke the
 * confirm's own `onSuccess` directly - a real mutation never resolves in
 * this fixture (no host round-trip is wired), so this is the only way to
 * drive the dialog's refused-rebind branch.
 */
const recordedMutateCalls: {
  readonly hostId: string | null;
  readonly callbacks: RebindMutateCallbacks;
}[] = [];

vi.mock("@/hooks/local-store/use-local-store-rebind-mutation", () => ({
  useLocalStoreRebindMutation: (hostId: string | null) => {
    rebindHostIds.push(hostId);
    return {
      mutate: (
        _variables: RebindLocalStoreRequest,
        callbacks: RebindMutateCallbacks,
      ) => {
        recordedMutateCalls.push({ hostId, callbacks });
      },
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
  recordedMutateCalls.length = 0;
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

describe("a second refusal for the same host while the dialog is mounted", () => {
  const REFUSAL_A: EpicCreateRefusal = {
    kind: "local-store-unavailable",
    message: "Message A.",
    remedy: "Remedy A.",
  };
  const REFUSAL_B: EpicCreateRefusal = {
    kind: "local-store-unavailable",
    message: "Message B.",
    remedy: "Remedy B.",
  };
  const REBIND_REFUSAL: RebindLocalStoreResponse = {
    status: "refused",
    message: "Rebind message.",
    remedy: "Rebind remedy.",
  };

  it("renders the NEW refusal's message and remedy, clearing a rebind refusal from a prior request", () => {
    // `LocalStoreRepairDialogHost` keys its mounted dialog by HOST ONLY
    // (`key={pending.hostId}`), so a second refusal on the SAME host arrives
    // as a prop change on a still-mounted dialog, not a remount - the exact
    // case a naive `useState` initializer misses.
    openLocalStoreRepair({ hostId: PLACEMENT_HOST_ID, refusal: REFUSAL_A });
    render(createElement(LocalStoreRepairDialogHost));

    expect(screen.getByRole("dialog").textContent).toContain(
      `${REFUSAL_A.message} ${REFUSAL_A.remedy}`,
    );

    // Trigger the rebind confirm, and have it come back refused - this is
    // what leaves a `repairRefusal` behind for the NEXT request to inherit
    // if the reset is missing.
    fireEvent.click(screen.getByRole("button", { name: "Rebind local store" }));
    expect(recordedMutateCalls).toHaveLength(1);
    expect(recordedMutateCalls[0].hostId).toBe(PLACEMENT_HOST_ID);
    act(() => {
      recordedMutateCalls[0].callbacks.onSuccess(REBIND_REFUSAL);
    });

    // The dialog now shows the REBIND's own words in place of the create's.
    expect(screen.getByRole("dialog").textContent).toContain(
      `${REBIND_REFUSAL.message} ${REBIND_REFUSAL.remedy}`,
    );

    // A second refusal for the SAME host arrives while mounted.
    act(() => {
      openLocalStoreRepair({ hostId: PLACEMENT_HOST_ID, refusal: REFUSAL_B });
    });

    const description = screen.getByRole("dialog").textContent;
    // Before the fix, `repairRefusal` from the rebind above survived this
    // prop change and kept rendering the rebind's remedy over request B's
    // own words.
    expect(description).toContain(REFUSAL_B.message);
    expect(description).toContain(REFUSAL_B.remedy);
    expect(description).not.toContain(REBIND_REFUSAL.remedy);
    expect(description).not.toContain(REFUSAL_A.message);
  });
});

describe("a missing-attachment-bytes refusal retries once under the same idempotency key", () => {
  const MISSING_BYTES_REFUSAL: EpicCreateRefusalV12 = {
    kind: "missing-attachment-bytes",
    message: "Traycer couldn't find the bytes for one of these images.",
    remedy: "Re-upload the image and try again.",
  };

  const SETTINGS = {
    harnessId: "codex" as const,
    model: "gpt-5.4",
    permissionMode: "supervised" as const,
    reasoningEffort: "high",
    serviceTier: null,
    agentMode: "epic" as const,
    profileId: null,
  };

  function hashOnlyDoc(hash: string): JsonContent {
    return {
      type: "doc",
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "img-1",
            fileName: "a.png",
            mimeType: "image/png",
            size: 9,
            hash,
            b64content: null,
            byHashEligible: true,
          },
        },
      ],
    };
  }

  function createVariablesWithHash(hash: string): CreateEpicRequestV12 {
    return {
      epic: {
        id: "epic-mab",
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
      chat: {
        chatId: "chat-mab",
        parentId: null,
        hostId: PLACEMENT_HOST_ID,
        title: "Chat",
        worktreeIntent: null,
        initialMessage: {
          messageId: "msg-mab",
          clientActionId: "action-mab",
          content: hashOnlyDoc(hash),
          sender: { type: "user", userId: USER_ID },
          settings: SETTINGS,
          accountContext: { type: "PERSONAL" },
          attachmentsByHash: true,
        },
      },
    };
  }

  /**
   * A fixture whose `epic.create` handler can answer DIFFERENTLY per call
   * (refusal, then success) and whose `drafts.putBlob` handler acks whatever
   * it is asked to upload - the two RPCs the retry actually drives.
   */
  // `@1.2`, not the released response: `missing-attachment-bytes` exists only
  // in the `@1.2` refusal enum, so a `CreateEpicResponse[]` cannot hold the one
  // refusal this whole describe block is about.
  function createRetryFixture(
    createResponses: readonly CreateEpicResponseV12[],
  ): {
    readonly client: HostClient<HostRpcRegistry>;
    readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
    readonly createCalls: () => ReadonlyArray<{
      readonly idempotencyKey: string | null;
    }>;
    readonly putBlobCalls: () => ReadonlyArray<{ readonly sha256: string }>;
  } {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let createCallCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-mab",
      handlers: {
        "epic.create": () => {
          const call = createCallCount;
          createCallCount += 1;
          const response = createResponses[call];
          if (response === undefined) {
            throw new Error(`unexpected epic.create call ${String(call)}`);
          }
          return response;
        },
        "drafts.putBlob": () => ({ ok: true as const }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === PLACEMENT_HOST_ID ? mockLocalHostEntry : null,
      messenger,
      // `drafts.putBlob` dispatches through `requestWithOptions` with its own
      // extended `responseTimeoutMs`, which `HostClient` validates against the
      // registry-declared scheduling policy - the default policy declares no
      // permitted timeout for ANY method, so without the app's real table this
      // upload is refused before it ever reaches the messenger.
      schedulingPolicy: hostRpcSchedulingPolicy,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        identity: { userId: USER_ID, username: USER_ID, providerHandle: null },
        origin: "renderer",
      }),
    );
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    return {
      client: spine.createRequester(mockLocalHostEntry),
      Wrapper,
      createCalls: () =>
        messenger.calls
          .filter((call) => call.method === "epic.create")
          .map((call) => ({ idempotencyKey: call.idempotencyKey })),
      putBlobCalls: () =>
        messenger.calls
          .filter((call) => call.method === "drafts.putBlob")
          .map((call) => ({
            sha256: (call.params as { readonly sha256: string }).sha256,
          })),
    };
  }

  beforeEach(() => {
    installFreshIndexedDb();
    resetDraftBlobTransportForTests();
  });

  afterEach(() => {
    resetDraftBlobTransportForTests();
    clearEpicCreateSeedPending("epic-mab", "chat-mab");
  });

  it("uploads exactly once and retries once under the same idempotency key, and onSuccess never sees the first refusal", async () => {
    const hash = await putImage(new Uint8Array([1, 2, 3, 4]));
    const acceptedTask = null;
    const fixture = createRetryFixture([
      { roomInfo: null, task: acceptedTask, refusal: MISSING_BYTES_REFUSAL },
      // `roomInfo: null` IS the success shape - the wire's own comment says so,
      // and a room carries no field this case reads. What separates this
      // response from the refusal above it is the ABSENT `refusal`, nothing
      // else. (The `{ docId }` this used to carry was on no schema at all.)
      { roomInfo: null, task: acceptedTask, initialTurnStarted: true },
    ]);
    const rendered = renderHook(() => useEpicCreateForClient(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    const result = await rendered.result.current.mutateAsync(
      createVariablesWithHash(hash),
    );

    const putBlobCalls = fixture.putBlobCalls();
    const createCalls = fixture.createCalls();
    expect(putBlobCalls).toHaveLength(1);
    expect(putBlobCalls[0].sha256).toBe(hash);
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0].idempotencyKey).toBe("epic-mab");
    expect(createCalls[1].idempotencyKey).toBe("epic-mab");
    // The FINAL response only - the refusal never reached the create's own
    // resolution.
    expect(result.refusal).toBeUndefined();
    // `onSuccess`'s refusal branch (which toasts) never fired: it only ever
    // saw the final, accepted response.
    expect(toastErrorCalls).toHaveLength(0);
  });

  it("a SECOND missing-attachment-bytes refusal ends in a plain toast, never opening the repair dialog", async () => {
    const hash = await putImage(new Uint8Array([5, 6, 7, 8]));
    const fixture = createRetryFixture([
      { roomInfo: null, task: null, refusal: MISSING_BYTES_REFUSAL },
      { roomInfo: null, task: null, refusal: MISSING_BYTES_REFUSAL },
    ]);
    const rendered = renderHook(() => useEpicCreateForClient(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await rendered.result.current.mutateAsync(createVariablesWithHash(hash));

    expect(fixture.createCalls()).toHaveLength(2);
    expect(toastErrorCalls).toHaveLength(1);
    const call = toastErrorCalls[0];
    expect(call.message).toBe(MISSING_BYTES_REFUSAL.message);
    expect(call.description).toBe(MISSING_BYTES_REFUSAL.remedy);
    // No `action` at all - never the Repair affordance.
    expect(call.action).toBeUndefined();
    expect(useLocalStoreRepairStore.getState().pending).toBeNull();
  });

  // NARROWED (was "the binding seed survives the first refusal that the
  // retry then succeeds past"): that title claimed to pin the seed's
  // survival THROUGH the retry, but this harness mounts only
  // `useEpicCreateForClient` - the mutation hook - and nothing in this hook
  // ever CLEARS a seed entry, on a refusal, a retry, or a success. The
  // clearing logic (`clearEpicCreateSeedPending` / `clearUnheldEpicCreateSeed`)
  // lives entirely in `createLandingEpic`'s own `.then`/`.catch`
  // (`use-landing-composer-actions.ts`), which this harness does not mount.
  // So the old assertion passed even if a first refusal leaked straight
  // through to a caller that DOES clear on refusal - it was proving that
  // THIS hook doesn't touch the entry, not that the retry protects it.
  //
  // What this case still legitimately covers: `armEpicCreateSeedHoldTimer`
  // is a no-op for a pair with no entry (documented at its own definition)
  // and, more to the point, this mutation hook's `onSuccess` never calls any
  // of the clearing functions - only the re-registering/arming ones. A
  // pre-existing entry is therefore inert cargo to this hook regardless of
  // how many refusals the retry absorbs underneath it.
  //
  // The real pin for "does the seed survive a missing-attachment-bytes
  // refusal the retry then succeeds past" is in the landing suite, which
  // owns the teardown this harness cannot reach:
  // `src/components/home/__tests__/use-landing-composer-actions.test.tsx`,
  // describe "missing-attachment-bytes refusal retry survives the seed
  // (B3-7)".
  it("never clears a pre-existing seed entry of its own accord, refusal-then-retry included", async () => {
    const hash = await putImage(new Uint8Array([9, 9, 9, 9]));
    const fixture = createRetryFixture([
      { roomInfo: null, task: null, refusal: MISSING_BYTES_REFUSAL },
      { roomInfo: null, task: null, initialTurnStarted: true },
    ]);
    const released: number[] = [];
    markEpicCreateSeedPending("epic-mab", "chat-mab", {
      hostId: PLACEMENT_HOST_ID,
      seededMessageId: "msg-mab",
      seedRows: true,
      heldForDeferredCreate: false,
      release: () => {
        released.push(1);
      },
    });
    const rendered = renderHook(() => useEpicCreateForClient(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await rendered.result.current.mutateAsync(createVariablesWithHash(hash));

    // This hook's own `onSuccess` armed the entry's timer (it is unheld, so
    // that timer alone would eventually release it) but never called a
    // clearing function - `release` above proves that, since only a clear
    // (direct or via the armed timer firing) invokes it.
    expect(readEpicCreateSeed("epic-mab", "chat-mab")).not.toBeNull();
    expect(released).toEqual([]);
  });
});
