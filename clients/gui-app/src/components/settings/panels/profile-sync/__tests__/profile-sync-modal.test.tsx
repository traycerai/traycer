import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ProfileCopyOutcome } from "@traycer/protocol/host/profile-copy-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  profileSyncSaveRuleSchema,
  profileSyncSelectionSchema,
  profileSyncStartSchema,
} from "@traycer/protocol/host/profile-sync-schemas";
import type {
  ProfileSyncBatch,
  ProfileSyncItem,
  ProfileSyncRule,
  ProfileSyncSelection,
} from "@traycer/protocol/host/profile-sync-schemas";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileCopyFlowHost } from "@/components/settings/panels/profile-copy/profile-copy-flow-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { clearProfileCopyObservations } from "@/hooks/providers/profile-copy/profile-copy-observations";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  ATTEMPT_ID,
  ATTEMPT_TWO_ID,
  hostDirectoryEntry,
  PREVIEW_REVISION,
  profileCopyAttempt,
  profileCopyOutcome,
  recordedOutcome,
  SCOPED_HOST_ID,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import {
  claudeProviderState,
  hostOption,
  managedProfile,
} from "../../profile-copy/__tests__/profile-copy-component-fixtures";

const harness = vi.hoisted(
  (): {
    spine: HostClient<HostRpcRegistry> | null;
    hosts: HostScopeOption[];
  } => ({
    spine: null,
    hosts: [],
  }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: harness.hosts,
    activeHostId: SCOPED_HOST_ID,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));

const RULE_ID = "99999999-9999-4999-8999-999999999999";
const SAVED_RULE: ProfileSyncRule = {
  ruleId: RULE_ID,
  sourceHostId: SOURCE_HOST_ID,
  destinationHostId: DEST_HOST_ID,
  scope: { kind: "selected", providers: ["codex"] },
  paused: false,
  revision: 1,
  lastCheckedAt: null,
  batchId: null,
  status: "waiting",
};

function resetStores(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
  useProfileCopyOperationsStore.setState({ handles: [] });
  useSettingsHostScopeStore.getState().setScopedHostId(null);
  clearProfileCopyObservations();
}

// Per-test knobs for the start and resolve answers; reset in beforeEach.
let startFailures = 0;
// The revision the preview answers with; a test moves it to model a re-check.
let previewRevision: string = PREVIEW_REVISION;
let startBatchSource: string | null = null;
let listFails = false;
let listBatches: readonly ProfileSyncBatch[] = [];
let previewSelection: ProfileSyncSelection | null = null;
let startBatchMutator: ((batch: ProfileSyncBatch) => ProfileSyncBatch) | null =
  null;
let listRules: readonly ProfileSyncRule[] | null = null;
let lastStarted: ProfileSyncBatch | null = null;
let updateStarted: ((batch: ProfileSyncBatch) => ProfileSyncBatch) | null =
  null;
let retryResult: "current" | "stale-revision" | "unavailable" = "current";
let retryOutcome: ProfileCopyOutcome | null = null;
let retryThrows = false;
let resolveThrows = false;
let saveRuleThrows = false;
let stopRuleThrows = false;

interface MountOptions {
  readonly rules: readonly ProfileSyncRule[];
  readonly providers: readonly ProviderCliState[];
  readonly previewItems: (
    selection: ProfileSyncSelection,
  ) => readonly ProfileSyncItem[];
  readonly startItems: (
    selection: ProfileSyncSelection,
  ) => readonly ProfileSyncItem[];
}

function defaultProviders(): readonly ProviderCliState[] {
  return [
    claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
    {
      ...claudeProviderState([
        managedProfile("55555555-5555-4555-8555-555555555555", "Personal"),
      ]),
      providerId: "codex",
    },
  ];
}

/** A listed (not previewed) transfer: no nested preview, no outcome. */
function listedItem(destinationHostId: string): ProfileSyncItem {
  return {
    ...syncItem(1, destinationHostId, "synced", [
      previewDestination(destinationHostId, "automatic"),
    ]),
    preview: null,
  };
}

function noItems(): readonly ProfileSyncItem[] {
  return [];
}

function mount(
  rules: readonly ProfileSyncRule[],
): MockHostMessenger<HostRpcRegistry> {
  return mountWith({
    rules,
    providers: defaultProviders(),
    previewItems: noItems,
    startItems: noItems,
  });
}

function mountWith(options: MountOptions): MockHostMessenger<HostRpcRegistry> {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-sync",
    handlers: {
      "providers.list": () => ({
        providers: [...options.providers],
        native: null,
      }),
      "providers.profileCopy.sync.list": () => {
        if (listFails) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "history unavailable",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.list",
            fatalDetails: null,
          });
        }
        return {
          batches: [
            ...listBatches,
            ...(lastStarted !== null && updateStarted !== null
              ? [updateStarted(lastStarted)]
              : []),
          ],
          rules: [...(listRules ?? options.rules)],
        };
      },
      "providers.profileCopy.sync.preview": (params) => ({
        selection: previewSelection ?? params,
        revision: previewRevision,
        items: [...options.previewItems(params)],
      }),
      "providers.profileCopy.sync.start": (params): ProfileSyncBatch => {
        if (startFailures > 0) {
          startFailures -= 1;
          // An answer lost on the wire: the host may or may not have started.
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "start unconfirmed",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.start",
            fatalDetails: null,
          });
        }
        const started: ProfileSyncBatch = {
          batchId: params.batchId,
          sourceHostId: startBatchSource ?? params.selection.sourceHostId,
          createdAt: 1,
          automatic: false,
          items: [...options.startItems(params.selection)],
        };
        const answered =
          startBatchMutator === null ? started : startBatchMutator(started);
        lastStarted = answered;
        return answered;
      },
      "providers.profileCopy.retry": () => {
        if (retryThrows) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "retry unreachable",
            requestId: "req-sync",
            method: "providers.profileCopy.retry",
            fatalDetails: null,
          });
        }
        return {
          result: retryResult,
          outcome: retryOutcome ?? profileCopyOutcome({}),
        };
      },
      "providers.profileCopy.sync.saveRule": (params): ProfileSyncRule => {
        if (saveRuleThrows) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "save unreachable",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.saveRule",
            fatalDetails: null,
          });
        }
        return {
          ...SAVED_RULE,
          ruleId: params.ruleId,
          scope: params.scope,
          paused: params.paused,
          revision: params.expectedRevision + 1,
        };
      },
      "providers.profileCopy.sync.stopRule": () => {
        if (stopRuleThrows) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "stop unreachable",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.stopRule",
            fatalDetails: null,
          });
        }
        return { batches: [], rules: [] };
      },
      "providers.profileCopy.sync.resolve": (params): ProfileSyncBatch => {
        if (resolveThrows) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "resolve unreachable",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.resolve",
            fatalDetails: null,
          });
        }
        return {
          batchId: params.batchId,
          sourceHostId: params.sourceHostId,
          createdAt: 1,
          automatic: false,
          items: [],
        };
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      harness.hosts.find((host) => host.hostId === hostId)?.entry ??
      hostDirectoryEntry(hostId, hostId),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-sync",
    }),
  );
  harness.spine = spine;
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileCopyFlowHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return messenger;
}

function openSync(providerId: "claude" | null): void {
  act(() => {
    useProfileCopyFlowStore.getState().open({
      kind: "sync",
      sourceHostId: SOURCE_HOST_ID,
      providerId,
    });
  });
}

function previewCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
  return messenger.calls.filter(
    (call) => call.method === "providers.profileCopy.sync.preview",
  );
}

describe("ProfileSyncModal", () => {
  beforeEach(() => {
    resetStores();
    harness.spine = null;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
      hostOption(DEST_HOST_TWO_ID, "Old Mac", false),
    ];
    // cmdk, behind the provider picker, needs these in jsdom.
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    resetStores();
    harness.spine = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("selects no destination by default and asks for none before one is chosen", async () => {
    const messenger = mount([]);
    openSync(null);
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (const box of boxes)
      expect(box.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Choose destination devices.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(previewCalls(messenger)).toHaveLength(0);
  });

  it("never offers the source host as a destination", async () => {
    mount([]);
    openSync(null);
    await screen.findByRole("checkbox", { name: /Linux box/ });
    expect(screen.queryByRole("checkbox", { name: /Studio Mac/ })).toBeNull();
  });

  it("opens from a provider with only that provider selected, else with every provider", async () => {
    mount([]);
    openSync("claude");
    const trigger = await screen.findByRole("button", {
      name: "Choose providers",
    });
    expect(trigger.textContent).toMatch(/Claude/);
    expect(trigger.textContent).not.toMatch(/Codex/);
    cleanup();
    resetStores();
    mount([]);
    openSync(null);
    const all = await screen.findByRole("button", { name: "Choose providers" });
    expect(all.textContent).toMatch(/Claude/);
    expect(all.textContent).toMatch(/Codex/);
  });

  it("previews the multi-provider selection against the captured source after 400ms", async () => {
    const messenger = mount([]);
    openSync("claude");
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose providers" }),
    );
    fireEvent.click(await screen.findByText("Codex"));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Linux box/ }));
    expect(previewCalls(messenger)).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    // Settings moves to another host mid-flow; the request must still go to the capture.
    act(() => {
      useSettingsHostScopeStore.getState().setScopedHostId("other-host");
    });
    await waitFor(() =>
      expect(previewCalls(messenger).length).toBeGreaterThan(0),
    );
    const call = previewCalls(messenger)[0];
    expect(call.authority.endpoint.hostId).toBe(SOURCE_HOST_ID);
    expect(call.params).toMatchObject({
      sourceHostId: SOURCE_HOST_ID,
      scope: { kind: "selected", providers: ["claude", "codex"] },
      destinationHostIds: [DEST_HOST_ID],
    });
  });

  it("loads a saved rule's scope into the editor instead of resetting to every provider", async () => {
    mount([SAVED_RULE]);
    openSync(null);
    fireEvent.mouseDown(
      await screen.findByRole("tab", { name: /Automatic sync/ }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const trigger = await screen.findByRole("button", {
      name: "Choose providers",
    });
    expect(trigger.textContent).toMatch(/Codex/);
    expect(trigger.textContent).not.toMatch(/Claude/);
    const all = screen.getByRole("checkbox", {
      name: /All supported providers, including future providers/,
    });
    expect(all.getAttribute("aria-checked")).toBe("false");
  });
});

const STAMP = "c".repeat(64);
const CATALOG_PROFILE_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const CATALOG_PROFILE_B = "22222222-bbbb-4bbb-8bbb-222222222222";

type PreviewDestination = NonNullable<
  ProfileSyncItem["preview"]
>["destinations"][number];

function previewDestination(
  destinationHostId: string,
  disposition: "automatic" | "already-present",
): PreviewDestination {
  return {
    destinationHostId,
    feasibility: {
      automatic: {
        status: "available" as const,
        admissionRevision: "b".repeat(64),
      },
      manual: {
        status: "unavailable" as const,
        reason: "manual-login-unavailable" as const,
      },
    },
    disposition,
    reason: null,
    existingProfileId: null,
    destinationProviderEnabled: true,
  };
}

/** The item for another source profile, with its nested preview source to match. */
function withSourceProfile(
  item: ProfileSyncItem,
  sourceProfileId: string,
): ProfileSyncItem {
  return {
    ...item,
    sourceProfileId,
    preview:
      item.preview === null
        ? null
        : {
            ...item.preview,
            source: { ...item.preview.source, sourceProfileId },
          },
  };
}

function syncItem(
  index: number,
  destinationHostId: string,
  state: ProfileSyncItem["state"],
  destinations: PreviewDestination[],
): ProfileSyncItem {
  return {
    providerId: "claude",
    sourceProfileId: SOURCE_PROFILE_ID,
    name: `Profile ${String(index)}`,
    destinationHostId,
    operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    preview: {
      source: {
        sourceHostId: SOURCE_HOST_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
        providerId: "claude",
      },
      previewRevision: PREVIEW_REVISION,
      destinations,
    },
    outcome: null,
    state,
    sourceSettings: {
      name: `Profile ${String(index)}`,
      color: "#ef4444",
      enabled: true,
    },
    sourceIdentityStamp: STAMP,
    identityChanged: false,
    destinationSettings: null,
    baseline: null,
  };
}

function startCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
  return messenger.calls.filter(
    (call) => call.method === "providers.profileCopy.sync.start",
  );
}

async function pickDestinations(names: readonly RegExp[]): Promise<void> {
  for (const name of names) {
    fireEvent.click(await screen.findByRole("checkbox", { name }));
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

describe("ProfileSyncModal review regressions", () => {
  beforeEach(() => {
    startFailures = 0;
    previewRevision = PREVIEW_REVISION;
    startBatchSource = null;
    listFails = false;
    listBatches = [];
    previewSelection = null;
    startBatchMutator = null;
    listRules = null;
    lastStarted = null;
    updateStarted = null;
    retryResult = "current";
    retryOutcome = null;
    retryThrows = false;
    resolveThrows = false;
    saveRuleThrows = false;
    stopRuleThrows = false;
    resetStores();
    harness.spine = null;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
      hostOption(DEST_HOST_TWO_ID, "Old Mac", false),
    ];
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    resetStores();
    harness.spine = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("describes each destination from its own preview row and leaves already-present out of the review count", async () => {
    mountWith({
      rules: [],
      providers: defaultProviders(),
      previewItems: () => [
        // The matching destination is second: reading the first row would say
        // "already has this account" for a profile that WILL be copied.
        syncItem(1, DEST_HOST_ID, "ready", [
          previewDestination(DEST_HOST_TWO_ID, "already-present"),
          previewDestination(DEST_HOST_ID, "automatic"),
        ]),
        syncItem(2, DEST_HOST_TWO_ID, "already-present", [
          previewDestination(DEST_HOST_TWO_ID, "already-present"),
        ]),
        // A second profile on the same device: its own logical transfer.
        withSourceProfile(
          syncItem(3, DEST_HOST_TWO_ID, "ready", [
            previewDestination(DEST_HOST_TWO_ID, "automatic"),
          ]),
          "33333333-3333-4333-8333-333333333334",
        ),
      ],
      startItems: noItems,
    });
    openSync(null);
    await pickDestinations([/Linux box/, /Old Mac/]);
    const summaries = await screen.findAllByText(/\d+ profiles ·/);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.textContent).toMatch(/1 profiles · Ready/);
    // Two rows, one already present: nothing here needs review.
    expect(summaries[1]?.textContent).toMatch(/2 profiles · Ready/);
    expect(summaries[1]?.textContent).not.toMatch(/need review/);
    const firstDetails = summaries[0].closest("details");
    if (firstDetails === null)
      throw new Error("expected the Linux box details");
    expect(within(firstDetails).queryByText(/already has this/)).toBeNull();
  });

  it("an empty start answer keeps the selection, says nothing was started and refetches the preview", async () => {
    const messenger = mountWith({
      rules: [],
      providers: defaultProviders(),
      previewItems: () => [
        syncItem(1, DEST_HOST_ID, "ready", [
          previewDestination(DEST_HOST_ID, "automatic"),
        ]),
      ],
      startItems: noItems,
    });
    openSync(null);
    await pickDestinations([/Linux box/]);
    await screen.findByText("1 profile transfers selected");
    const before = previewCalls(messenger).length;
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText(
        "Nothing was started. Check the selection and try again.",
      ),
    ).toBeTruthy();
    expect(startCalls(messenger)).toHaveLength(1);
    // Still the selection view: no results screen, the destination stays chosen.
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    expect(
      screen
        .getByRole("checkbox", { name: /Linux box/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await waitFor(() =>
      expect(previewCalls(messenger).length).toBeGreaterThan(before),
    );
    // The refetch settled on the SAME preview revision. A retry must not reuse
    // the batch id of the start that started nothing, or the host would replay
    // that empty batch instead of starting the selection.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Sync now" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
    const batchIds = startCalls(messenger).map(
      (call) => profileSyncStartSchema.parse(call.params).batchId,
    );
    expect(batchIds[0]).toBeTruthy();
    expect(batchIds[1]).toBeTruthy();
    expect(batchIds[1]).not.toBe(batchIds[0]);
  });

  describe("source catalog limits the selectable providers", () => {
    function catalogWithUnsupported(): readonly ProviderCliState[] {
      return [
        claudeProviderState([
          managedProfile(CATALOG_PROFILE_A, "Work"),
          managedProfile(CATALOG_PROFILE_B, "Personal"),
        ]),
        {
          ...claudeProviderState([
            managedProfile("55555555-5555-4555-8555-555555555555", "Main"),
          ]),
          providerId: "codex",
        },
        {
          ...claudeProviderState([
            managedProfile("66666666-6666-4666-8666-666666666666", "One"),
            managedProfile("77777777-7777-4777-8777-777777777777", "Two"),
            managedProfile("88888888-8888-4888-8888-888888888888", "Three"),
          ]),
          providerId: "opencode",
        },
      ];
    }

    it("starts with only the catalog's transferable providers selected, with the matching count", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      const trigger = await screen.findByRole("button", {
        name: "Choose providers",
      });
      await waitFor(() => expect(trigger.textContent).toMatch(/Claude/));
      expect(trigger.textContent).toMatch(/Codex/);
      expect(trigger.textContent).not.toMatch(/Grok|Antigravity|Gemini|Open/);
      // Three profiles across the two (the opencode ones cannot be transferred).
      expect(screen.getByText(/2 selected/).textContent).toMatch(/3 profiles/);
    });

    it("offers only those providers, and Select all / Clear stay inside them", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.click(
        await screen.findByRole("button", { name: "Choose providers" }),
      );
      expect(await screen.findAllByRole("option")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.getByText(/0 selected/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Select all" }));
      expect(screen.getByText(/2 selected/).textContent).toMatch(/3 profiles/);
    });

    it("sends only the catalog providers in the preview and the start", async () => {
      const messenger = mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await screen.findByRole("button", { name: "Choose providers" });
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      expect(previewCalls(messenger).at(-1)?.params).toMatchObject({
        scope: { kind: "selected", providers: ["claude", "codex"] },
      });
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
      expect(startCalls(messenger)[0]?.params).toMatchObject({
        selection: {
          scope: { kind: "selected", providers: ["claude", "codex"] },
        },
      });
    });

    it("a new automatic rule defaults to the same catalog providers", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        {
          button: 0,
        },
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Add device" }),
      );
      const trigger = await screen.findByRole("button", {
        name: "Choose providers",
      });
      await waitFor(() => expect(trigger.textContent).toMatch(/Claude/));
      expect(trigger.textContent).toMatch(/Codex/);
      expect(trigger.textContent).not.toMatch(/Grok|Antigravity|Gemini|Open/);
      fireEvent.click(trigger);
      expect(await screen.findAllByRole("option")).toHaveLength(2);
    });
  });

  describe("round 2: request ids, captured source and run capacity", () => {
    const READY_ITEM = (): ProfileSyncItem[] => [
      syncItem(1, DEST_HOST_ID, "ready", [
        previewDestination(DEST_HOST_ID, "automatic"),
      ]),
    ];

    async function settled(
      messenger: MockHostMessenger<HostRpcRegistry>,
      previewsBefore: number,
    ): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => {
        expect(previewCalls(messenger).length).toBeGreaterThan(previewsBefore);
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false);
      });
    }

    it("two different selections on the same preview revision send different batch ids after an unconfirmed first start", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      const before = previewCalls(messenger).length;
      fireEvent.click(await screen.findByRole("checkbox", { name: /Old Mac/ }));
      await settled(messenger, before);
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(first.revision).toBe(second.revision);
      expect(first.selection.destinationHostIds).toEqual([DEST_HOST_ID]);
      expect(second.selection.destinationHostIds).toEqual([
        DEST_HOST_ID,
        DEST_HOST_TWO_ID,
      ]);
      expect(second.batchId).not.toBe(first.batchId);
    });

    it("an unconfirmed start retried for the same selection keeps its batch id", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(first.batchId).toBeTruthy();
      expect(second.batchId).toBe(first.batchId);
    });

    it("refuses a returned run for another source: no actions, and nothing dispatches to either device", async () => {
      // A run that is internally consistent for ANOTHER source (batch B and
      // the nested outcome's attempt both name B) must still not act on A.
      startBatchSource = DEST_HOST_ID;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: () => [
          {
            ...syncItem(1, DEST_HOST_TWO_ID, "unconfirmed", [
              previewDestination(DEST_HOST_TWO_ID, "automatic"),
            ]),
            preview: null,
            outcome: profileCopyOutcome({
              attempt: profileCopyAttempt({
                sourceHostId: DEST_HOST_ID,
                destinationHostId: DEST_HOST_TWO_ID,
                operationId: "00000000-0000-4000-8000-000000000001",
              }),
              state: "failed",
            }),
          },
        ],
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(
        await screen.findByText(
          "The device returned a run for another source. Check sync history again.",
        ),
      ).toBeTruthy();
      for (const name of [/Check status/, /Retry/, /Review/])
        expect(screen.queryByRole("button", { name })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      const dispatched = messenger.calls.filter(
        (call) =>
          call.method !== "providers.profileCopy.sync.start" &&
          call.method !== "providers.profileCopy.sync.preview" &&
          call.method !== "providers.profileCopy.sync.list" &&
          call.method !== "providers.list",
      );
      expect(dispatched).toEqual([]);
    });

    describe("run capacity of 512 profile transfers", () => {
      const LIMIT_TEXT =
        "Choose fewer providers or devices: a run supports up to 512 profile transfers.";

      function catalog(profiles: number): readonly ProviderCliState[] {
        return [
          claudeProviderState(
            Array.from({ length: profiles }, (_unused, index) =>
              managedProfile(
                `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                `Profile ${String(index + 1)}`,
              ),
            ),
          ),
        ];
      }

      function deviceName(index: number): RegExp {
        return new RegExp(`Device ${String(index)}(?!\\d)`);
      }

      async function chooseDevices(count: number): Promise<void> {
        for (let index = 1; index <= count; index += 1) {
          fireEvent.click(
            await screen.findByRole("checkbox", { name: deviceName(index) }),
          );
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
      }

      beforeEach(() => {
        harness.hosts = [
          hostOption(SOURCE_HOST_ID, "Studio Mac", true),
          ...Array.from({ length: 16 }, (_unused, index) =>
            hostOption(
              `capacity-host-${String(index + 1)}`,
              `Device ${String(index + 1)}`,
              false,
            ),
          ),
        ];
      });

      it("33 profiles to 16 devices is refused before any preview or start, with an explanation", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(33),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        expect(await screen.findByText(LIMIT_TEXT)).toBeTruthy();
        expect(previewCalls(messenger)).toHaveLength(0);
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        expect(startCalls(messenger)).toHaveLength(0);
      });

      it("dropping to 15 devices lifts the refusal and previews", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(33),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        await screen.findByText(LIMIT_TEXT);
        fireEvent.click(
          await screen.findByRole("checkbox", { name: deviceName(16) }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(0),
        );
        expect(screen.queryByText(LIMIT_TEXT)).toBeNull();
        const lastPreview = previewCalls(messenger).at(-1);
        expect(lastPreview).toBeDefined();
        const requested = profileSyncSelectionSchema.parse(lastPreview?.params);
        expect(requested.destinationHostIds).toHaveLength(15);
        expect(requested.destinationHostIds).not.toContain("capacity-host-16");
      });

      it("exactly 32 profiles to 16 devices (512) is allowed", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(32),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(0),
        );
        expect(screen.queryByText(LIMIT_TEXT)).toBeNull();
      });
    });
  });

  describe("round 3: sync history gate and host removal", () => {
    function perDestination(
      selection: ProfileSyncSelection,
    ): readonly ProfileSyncItem[] {
      return selection.destinationHostIds.map((id, index) =>
        syncItem(index + 1, id, "ready", [previewDestination(id, "automatic")]),
      );
    }

    function refreshHosts(): void {
      // The host options are read by the flow body above the modal: re-render
      // it with a fresh view object, leaving `session` (and so the modal's
      // selection state) untouched.
      act(() => {
        useProfileCopyFlowStore.setState((state) => ({
          view: state.view === null ? null : { ...state.view },
        }));
      });
    }

    it("shows no empty-rules state, Add device or editor until the sync history loads, then the authoritative rule", async () => {
      listFails = true;
      mountWith({
        rules: [SAVED_RULE],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      const retry = await screen.findByRole("button", { name: "Try again" });
      expect(screen.queryByText(/No automatic rules yet/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Add device" })).toBeNull();
      expect(screen.queryByText("Add automatic sync")).toBeNull();
      listFails = false;
      fireEvent.click(retry);
      expect(
        await screen.findByRole("heading", { name: "Linux box" }),
      ).toBeTruthy();
      expect(screen.queryByText(/No automatic rules yet/)).toBeNull();
      expect(screen.getByRole("button", { name: "Add device" })).toBeTruthy();
    });

    it("drops a removed destination from the count, the preview and the start, and keeps an offline device selectable", async () => {
      const offline = hostOption("offline-host", "Sleeping box", false);
      harness.hosts = [
        ...harness.hosts,
        {
          ...offline,
          connectable: false,
          health: { ...offline.health, live: false },
        },
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: perDestination,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/, /Old Mac/, /Sleeping box/]);
      await screen.findByText("3 profile transfers selected");
      harness.hosts = harness.hosts.filter(
        (host) => host.hostId !== DEST_HOST_TWO_ID,
      );
      refreshHosts();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(
        await screen.findByText("2 profile transfers selected"),
      ).toBeTruthy();
      expect(screen.queryByRole("checkbox", { name: /Old Mac/ })).toBeNull();
      const lastPreview = previewCalls(messenger).at(-1);
      expect(lastPreview).toBeDefined();
      const requested = profileSyncSelectionSchema.parse(lastPreview?.params);
      expect(requested.destinationHostIds).toEqual([
        DEST_HOST_ID,
        "offline-host",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
      const started = profileSyncStartSchema.parse(
        startCalls(messenger)[0].params,
      );
      expect(started.selection.destinationHostIds).toEqual([
        DEST_HOST_ID,
        "offline-host",
      ]);
    });

    it("a removed selected device no longer counts toward the 16-device limit", async () => {
      harness.hosts = [
        hostOption(SOURCE_HOST_ID, "Studio Mac", true),
        ...Array.from({ length: 17 }, (_unused, index) =>
          hostOption(
            `limit-host-${String(index + 1)}`,
            `Device ${String(index + 1)}`,
            false,
          ),
        ),
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      for (let index = 1; index <= 16; index += 1) {
        fireEvent.click(
          await screen.findByRole("checkbox", {
            name: new RegExp(`Device ${String(index)}(?!\\d)`),
          }),
        );
      }
      const seventeenth = await screen.findByRole("checkbox", {
        name: /Device 17(?!\d)/,
      });
      expect(seventeenth.hasAttribute("disabled")).toBe(true);
      harness.hosts = harness.hosts.filter(
        (host) => host.hostId !== "limit-host-16",
      );
      refreshHosts();
      const reopened = await screen.findByRole("checkbox", {
        name: /Device 17(?!\d)/,
      });
      expect(reopened.hasAttribute("disabled")).toBe(false);
      // Choosing it prunes the removed device from the outgoing request too.
      fireEvent.click(reopened);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => {
        const last = previewCalls(messenger).at(-1);
        expect(last).toBeDefined();
        const requested = profileSyncSelectionSchema.parse(last?.params);
        expect(requested.destinationHostIds).toContain("limit-host-17");
      });
      const finalPreview = profileSyncSelectionSchema.parse(
        previewCalls(messenger).at(-1)?.params,
      );
      expect(finalPreview.destinationHostIds).not.toContain("limit-host-16");
      expect(finalPreview.destinationHostIds).toHaveLength(16);
    });
  });

  describe("round 4: echoed selection, recent runs and failure scoping", () => {
    const READY = (): ProfileSyncItem[] => [
      syncItem(1, DEST_HOST_ID, "ready", [
        previewDestination(DEST_HOST_ID, "automatic"),
      ]),
    ];

    async function settledAfter(
      messenger: MockHostMessenger<HostRpcRegistry>,
      previewsBefore: number,
    ): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => {
        expect(previewCalls(messenger).length).toBeGreaterThan(previewsBefore);
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false);
      });
    }

    it("a valid preview that echoes a different selection never enables Sync now or dispatches, and keeps the local choices", async () => {
      previewSelection = {
        sourceHostId: SOURCE_HOST_ID,
        scope: { kind: "all" },
        destinationHostIds: [DEST_HOST_TWO_ID],
      };
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        // Ready, and consistent with the ECHOED selection (Old Mac), so only
        // the mismatch with the requested one can disable Sync now.
        previewItems: () => [
          syncItem(1, DEST_HOST_TWO_ID, "ready", [
            previewDestination(DEST_HOST_TWO_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await waitFor(() =>
        expect(previewCalls(messenger).length).toBeGreaterThan(0),
      );
      expect(
        await screen.findByText(
          "The device returned a different selection. Check again.",
        ),
      ).toBeTruthy();
      const sync = screen.getByRole("button", { name: "Sync now" });
      expect(sync.hasAttribute("disabled")).toBe(true);
      fireEvent.click(sync);
      expect(startCalls(messenger)).toHaveLength(0);
      expect(
        screen
          .getByRole("checkbox", { name: /Linux box/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        screen
          .getByRole("checkbox", { name: /Old Mac/ })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });

    it("shows the five newest recent runs, newest first, whatever order the host lists them in", async () => {
      const base = 1_700_000_000_000;
      const minutes = [3, 7, 1, 6, 2, 5, 4];
      listBatches = minutes.map((minute): ProfileSyncBatch => ({
        batchId: `00000000-0000-4000-8000-${String(minute).padStart(12, "0")}`,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: base + minute * 60_000,
        automatic: false,
        items: [listedItem(DEST_HOST_ID)],
      }));
      mount([]);
      openSync(null);
      await screen.findByText("Recent runs");
      const rows = screen
        .getAllByRole("button", { name: /profile transfers/ })
        .map((row) => row.textContent);
      expect(rows).toHaveLength(5);
      [7, 6, 5, 4, 3].forEach((minute, index) => {
        expect(rows[index]).toContain(
          new Date(base + minute * 60_000).toLocaleString(),
        );
      });
    });

    it("an uncertain start's failure text follows its own selection: hidden on another choice, back on return, with the same batch id", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      const before = previewCalls(messenger).length;
      fireEvent.click(screen.getByRole("checkbox", { name: /Old Mac/ }));
      await settledAfter(messenger, before);
      expect(screen.queryByText(/could not be confirmed/)).toBeNull();
      // Back on the original choices the cached preview is reused, so no new
      // preview request is expected: wait for the rendered state instead.
      fireEvent.click(screen.getByRole("checkbox", { name: /Old Mac/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(second.selection).toEqual(first.selection);
      expect(second.batchId).toBe(first.batchId);
    });

    it("an uncertain start's failure text is dropped once Check again returns a new revision, and the next start gets a new batch id", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY,
        startItems: noItems,
      });
      try {
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
        const before = previewCalls(messenger).length;
        previewRevision = "b".repeat(64);
        fireEvent.click(screen.getByRole("button", { name: "Check again" }));
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(before),
        );
        await waitFor(() =>
          expect(screen.queryByText(/could not be confirmed/)).toBeNull(),
        );
        await waitFor(() =>
          expect(
            screen
              .getByRole("button", { name: "Sync now" })
              .hasAttribute("disabled"),
          ).toBe(false),
        );
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
        const [firstCall, secondCall] = startCalls(messenger);
        const first = profileSyncStartSchema.parse(firstCall.params);
        const second = profileSyncStartSchema.parse(secondCall.params);
        expect(second.selection).toEqual(first.selection);
        expect(first.revision).toBe(PREVIEW_REVISION);
        expect(second.revision).toBe("b".repeat(64));
        expect(second.batchId).not.toBe(first.batchId);
      } finally {
        previewRevision = PREVIEW_REVISION;
      }
    });
    describe.each([
      [
        "a rejected response",
        "The device returned a run for another source. Check sync history again.",
        () => {
          startBatchSource = DEST_HOST_ID;
        },
      ],
      [
        "an empty answer",
        "Nothing was started. Check the selection and try again.",
        () => undefined,
      ],
    ])(
      "the notice for %s follows its submitted revision",
      (_label, notice, arrange) => {
        async function startAndCheck(
          nextRevision: string,
        ): Promise<MockHostMessenger<HostRpcRegistry>> {
          arrange();
          const messenger = mountWith({
            rules: [],
            providers: defaultProviders(),
            previewItems: READY,
            startItems: noItems,
          });
          try {
            openSync(null);
            await pickDestinations([/Linux box/]);
            await screen.findByText("1 profile transfers selected");
            fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
            expect(await screen.findByText(notice)).toBeTruthy();
            await waitFor(() =>
              expect(
                screen
                  .getByRole("button", { name: "Check again" })
                  .hasAttribute("disabled"),
              ).toBe(false),
            );
            const before = previewCalls(messenger).length;
            previewRevision = nextRevision;
            fireEvent.click(
              screen.getByRole("button", { name: "Check again" }),
            );
            await waitFor(() =>
              expect(previewCalls(messenger).length).toBeGreaterThan(before),
            );
            await waitFor(() =>
              expect(
                screen
                  .getByRole("button", { name: "Sync now" })
                  .hasAttribute("disabled"),
              ).toBe(false),
            );
          } finally {
            previewRevision = PREVIEW_REVISION;
          }
          return messenger;
        }

        it("stays when Check again returns the same revision", async () => {
          await startAndCheck(PREVIEW_REVISION);
          expect(screen.getByText(notice)).toBeTruthy();
        });

        it("disappears when Check again returns a new revision for the same selection", async () => {
          await startAndCheck("b".repeat(64));
          expect(screen.queryByText(notice)).toBeNull();
        });
      },
    );
  });

  describe("round 6: run ownership, automatic results link and rule capacity", () => {
    const SELECTION_ALERT =
      "The device returned a run outside this selection. Check sync history again.";
    const AUTO_BATCH = "00000000-0000-4000-8000-0000000000c1";

    beforeEach(() => {
      // Radix Select reads pointer capture, which jsdom does not implement.
      Element.prototype.hasPointerCapture = () => false;
      Element.prototype.setPointerCapture = () => undefined;
      Element.prototype.releasePointerCapture = () => undefined;
    });

    const queuedItem = (): ProfileSyncItem => ({
      ...syncItem(1, DEST_HOST_ID, "queued", [
        previewDestination(DEST_HOST_ID, "automatic"),
      ]),
      preview: null,
    });

    const outsideSelection: ReadonlyArray<
      readonly [string, (batch: ProfileSyncBatch) => ProfileSyncBatch]
    > = [
      [
        "batch id",
        (batch) => ({
          ...batch,
          batchId: "00000000-0000-4000-8000-0000000000ff",
        }),
      ],
      [
        "provider",
        (batch) => ({
          ...batch,
          items: batch.items.map((entry) => ({
            ...entry,
            providerId: "codex" as const,
          })),
        }),
      ],
      [
        "destination",
        (batch) => ({
          ...batch,
          items: batch.items.map((entry) => ({
            ...entry,
            destinationHostId: DEST_HOST_TWO_ID,
          })),
        }),
      ],
      [
        "profile",
        (batch) => ({
          ...batch,
          items: batch.items.map((entry) => ({
            ...entry,
            sourceProfileId: "00000000-0000-4000-8000-0000000000ee",
          })),
        }),
      ],
    ];

    async function startSelected(): Promise<void> {
      openSync("claude");
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    }

    function mountStart(): MockHostMessenger<HostRpcRegistry> {
      return mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: () => [queuedItem()],
      });
    }

    it.each(outsideSelection)(
      "refuses a same-source run with a different %s and keeps the selection",
      async (_label, mutate) => {
        startBatchMutator = mutate;
        mountStart();
        await startSelected();
        expect(await screen.findByText(SELECTION_ALERT)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "← Back" })).toBeNull();
        expect(
          screen
            .getByRole("checkbox", { name: /Linux box/ })
            .getAttribute("aria-checked"),
        ).toBe("true");
      },
    );

    it("opens a matching run as before", async () => {
      mountStart();
      await startSelected();
      expect(
        await screen.findByRole("button", { name: "← Back" }),
      ).toBeTruthy();
      expect(screen.queryByText(SELECTION_ALERT)).toBeNull();
    });

    function autoBatch(overrides: Partial<ProfileSyncBatch>): ProfileSyncBatch {
      return {
        batchId: AUTO_BATCH,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: 1,
        automatic: true,
        items: [
          {
            ...syncItem(1, DEST_HOST_ID, "synced", [
              previewDestination(DEST_HOST_ID, "automatic"),
            ]),
            preview: null,
          },
        ],
        ...overrides,
      };
    }

    async function openAutomatic(): Promise<void> {
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
    }

    it("offers View results for a rule only when its link resolves to a listed same-source automatic batch for its destination, and opens it", async () => {
      listBatches = [autoBatch({})];
      mount([{ ...SAVED_RULE, batchId: AUTO_BATCH }]);
      await openAutomatic();
      await screen.findByRole("heading", { name: "Linux box" });
      fireEvent.click(
        await screen.findByRole("button", { name: "View results" }),
      );
      expect(
        await screen.findByRole("button", { name: "← Back" }),
      ).toBeTruthy();
    });

    it.each([
      ["dangling", [] as ProfileSyncBatch[]],
      ["not automatic", [autoBatch({ automatic: false })]],
      [
        "another destination",
        [
          autoBatch({
            items: [
              {
                ...syncItem(1, DEST_HOST_TWO_ID, "synced", [
                  previewDestination(DEST_HOST_TWO_ID, "automatic"),
                ]),
                preview: null,
              },
            ],
          }),
        ],
      ],
      ["another source", [autoBatch({ sourceHostId: "foreign-source-host" })]],
      ["empty items", [autoBatch({ items: [] })]],
    ])("hides View results for a %s link", async (_label, batches) => {
      listBatches = batches;
      mount([{ ...SAVED_RULE, batchId: AUTO_BATCH }]);
      await openAutomatic();
      await screen.findByRole("heading", { name: "Linux box" });
      expect(screen.queryByRole("button", { name: "View results" })).toBeNull();
    });

    function ruleSet(count: number): ProfileSyncRule[] {
      return Array.from({ length: count }, (_unused, index) => ({
        ...SAVED_RULE,
        ruleId: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
        destinationHostId: `rule-dest-${String(index)}`,
      }));
    }

    it("at 64 rules Add device is disabled with the explanation, and existing rules stay manageable", async () => {
      mount(ruleSet(64));
      await openAutomatic();
      expect(
        await screen.findByText(
          "Automatic sync supports up to 64 device rules. Stop a rule to add another device.",
        ),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "Add device" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(64);
      expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(64);
      expect(screen.getAllByRole("button", { name: "Stop…" })).toHaveLength(64);
    });

    it("at 63 rules with an unused destination Add device is enabled and no capacity text shows", async () => {
      mount(ruleSet(63));
      await openAutomatic();
      await screen.findByText("Keep profiles in sync");
      expect(
        screen
          .getByRole("button", { name: "Add device" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(screen.queryByText(/supports up to 64 device rules/)).toBeNull();
    });

    it("an open new-rule editor cannot save once the list reaches 64 rules", async () => {
      const messenger = mount(ruleSet(63));
      await openAutomatic();
      fireEvent.click(
        await screen.findByRole("button", { name: "Add device" }),
      );
      fireEvent.keyDown(
        await screen.findByRole("combobox", { name: "Destination device" }),
        { key: "ArrowDown" },
      );
      fireEvent.click(await screen.findByRole("option", { name: /Linux box/ }));
      const save = await screen.findByRole("button", {
        name: "Enable automatic sync",
      });
      expect(save.hasAttribute("disabled")).toBe(false);
      listRules = ruleSet(64);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Enable automatic sync" })
            .hasAttribute("disabled"),
        ).toBe(true),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Enable automatic sync" }),
      );
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.sync.saveRule",
        ),
      ).toHaveLength(0);
    });

    it("refuses the whole rules view when any rule names another source", async () => {
      mount([
        SAVED_RULE,
        {
          ...SAVED_RULE,
          ruleId: "00000000-0000-4000-8000-0000000000d1",
          sourceHostId: DEST_HOST_ID,
          destinationHostId: DEST_HOST_TWO_ID,
        },
      ]);
      await openAutomatic();
      expect(
        await screen.findByText(
          "The device returned rules for another source. Check sync history again.",
        ),
      ).toBeTruthy();
      for (const name of ["Edit", "Pause", "Stop…", "Add device"])
        expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Linux box" })).toBeNull();
    });

    it("lists only the captured source's runs under Recent runs", async () => {
      listBatches = [1, 2].map((minute): ProfileSyncBatch => ({
        batchId: `00000000-0000-4000-8000-00000000010${String(minute)}`,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: minute * 60_000,
        automatic: false,
        items: [listedItem(DEST_HOST_ID)],
      }));
      listBatches = [
        ...listBatches,
        {
          batchId: "00000000-0000-4000-8000-000000000199",
          sourceHostId: DEST_HOST_ID,
          createdAt: 9 * 60_000,
          automatic: false,
          // Belongs to another source, so its destination is a third device.
          items: [listedItem(DEST_HOST_TWO_ID)],
        },
      ];
      mount([]);
      openSync(null);
      await screen.findByText("Recent runs");
      expect(
        screen.getAllByRole("button", { name: /profile transfers/ }),
      ).toHaveLength(2);
    });
  });

  describe("round 7: paused status and retry notices", () => {
    it("renders Paused for status paused even when the paused flag is false", async () => {
      mount([{ ...SAVED_RULE, paused: false, status: "paused" }]);
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await screen.findByRole("heading", { name: "Linux box" });
      expect(screen.getByText("Paused")).toBeTruthy();
    });

    const RETRY_OPERATION = "00000000-0000-4000-8000-000000000001";
    const STALE_TEXT = "This changed since you last looked. Review it again.";
    const UNAVAILABLE_TEXT =
      "Retry isn't possible right now. Linux box may be offline, a sign-in there may still be holding a shared resource, or this copy was cancelled.";

    function quarantined(
      attemptId: string,
      revision: number,
    ): ProfileCopyOutcome {
      return recordedOutcome({
        attempt: profileCopyAttempt({
          operationId: RETRY_OPERATION,
          attemptId,
        }),
        revision,
        state: "quarantined",
      });
    }

    async function openRetry(): Promise<MockHostMessenger<HostRpcRegistry>> {
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: () => [
          {
            ...syncItem(1, DEST_HOST_ID, "needs-action", []),
            preview: null,
            outcome: quarantined(ATTEMPT_ID, 3),
          },
        ],
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
      return messenger;
    }

    function advanceList(): Promise<void> {
      return act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }

    it("keeps the stale notice while the attempt has not advanced past the response, and hides it on a later revision", async () => {
      retryResult = "stale-revision";
      retryOutcome = quarantined(ATTEMPT_ID, 3);
      await openRetry();
      expect(await screen.findByText(STALE_TEXT)).toBeTruthy();
      // A refetch of the same revision must not clear it.
      updateStarted = (batch) => ({
        ...batch,
        items: batch.items.map((entry) => ({
          ...entry,
          outcome: quarantined(ATTEMPT_ID, 3),
        })),
      });
      await advanceList();
      expect(screen.getByText(STALE_TEXT)).toBeTruthy();
      updateStarted = (batch) => ({
        ...batch,
        items: batch.items.map((entry) => ({
          ...entry,
          outcome: quarantined(ATTEMPT_ID, 4),
        })),
      });
      await advanceList();
      await waitFor(() => expect(screen.queryByText(STALE_TEXT)).toBeNull());
    });

    it("shows the unavailable notice and hides it once another attempt is displayed", async () => {
      retryResult = "unavailable";
      retryOutcome = quarantined(ATTEMPT_ID, 3);
      await openRetry();
      expect(await screen.findByText(UNAVAILABLE_TEXT)).toBeTruthy();
      updateStarted = (batch) => ({
        ...batch,
        items: batch.items.map((entry) => ({
          ...entry,
          outcome: quarantined(ATTEMPT_TWO_ID, 3),
        })),
      });
      await advanceList();
      await waitFor(() =>
        expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull(),
      );
    });

    it("shows no notice for a current retry", async () => {
      retryResult = "current";
      retryOutcome = quarantined(ATTEMPT_ID, 3);
      const messenger = await openRetry();
      await waitFor(() =>
        expect(
          messenger.calls.filter(
            (call) => call.method === "providers.profileCopy.retry",
          ).length,
        ).toBeGreaterThan(0),
      );
      expect(screen.queryByText(STALE_TEXT)).toBeNull();
      expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull();
    });
  });

  describe("round 8: recent history and action errors", () => {
    const REACH_ERROR = /Couldn't reach Studio Mac right now/;

    function listed(minute: number, itemCount: number): ProfileSyncBatch {
      return {
        batchId: `00000000-0000-4000-8000-00000000${String(minute).padStart(4, "0")}`,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: 1_700_000_000_000 + minute * 60_000,
        automatic: false,
        items: Array.from({ length: itemCount }, (_unused, index) => ({
          ...syncItem(index + 1, DEST_HOST_ID, "synced", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
          preview: null,
        })),
      };
    }

    it("picks the five newest NON-EMPTY runs, newest first", async () => {
      listBatches = [
        listed(1, 1),
        listed(2, 1),
        listed(3, 1),
        listed(4, 1),
        listed(5, 1),
        listed(6, 0),
        listed(7, 0),
        listed(8, 0),
      ];
      mount([]);
      openSync(null);
      await screen.findByText("Recent runs");
      const rows = screen
        .getAllByRole("button", { name: /profile transfers/ })
        .map((row) => row.textContent);
      expect(rows).toHaveLength(5);
      [5, 4, 3, 2, 1].forEach((minute, index) => {
        expect(rows[index]).toContain(
          new Date(1_700_000_000_000 + minute * 60_000).toLocaleString(),
        );
      });
    });

    it("hides the Recent runs heading when every listed run is empty", async () => {
      listBatches = [listed(1, 0), listed(2, 0)];
      mount([]);
      openSync(null);
      await screen.findByRole("checkbox", { name: /Linux box/ });
      await waitFor(() =>
        expect(
          screen.queryByText(/Loading profiles and sync history/),
        ).toBeNull(),
      );
      expect(screen.queryByText("Recent runs")).toBeNull();
    });

    function quarantinedAt(
      attemptId: string,
      revision: number,
    ): ProfileCopyOutcome {
      return recordedOutcome({
        attempt: profileCopyAttempt({
          operationId: "00000000-0000-4000-8000-000000000001",
          attemptId,
        }),
        revision,
        state: "quarantined",
      });
    }

    function actionItem(): ProfileSyncItem {
      return {
        ...syncItem(1, DEST_HOST_ID, "unconfirmed", []),
        preview: null,
        outcome: quarantinedAt(ATTEMPT_ID, 3),
      };
    }

    async function startWithActions(): Promise<void> {
      mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: () => [actionItem()],
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    }

    function advanceTo(
      change: (item: ProfileSyncItem) => ProfileSyncItem,
    ): Promise<void> {
      updateStarted = (batch) => ({
        ...batch,
        items: batch.items.map(change),
      });
      return act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }

    const actions: ReadonlyArray<readonly [string, string, () => void]> = [
      [
        "Check status",
        "resolve",
        () => {
          resolveThrows = true;
        },
      ],
      [
        "Retry",
        "retry",
        () => {
          retryThrows = true;
        },
      ],
    ];
    const advances: ReadonlyArray<
      readonly [string, (item: ProfileSyncItem) => ProfileSyncItem]
    > = [
      [
        "a later revision",
        (item) => ({ ...item, outcome: quarantinedAt(ATTEMPT_ID, 4) }),
      ],
      [
        "a replacement attempt",
        (item) => ({ ...item, outcome: quarantinedAt(ATTEMPT_TWO_ID, 3) }),
      ],
      [
        "a state advance with the same outcome revision",
        (item) => ({ ...item, state: "synced" as const }),
      ],
    ];

    for (const [button, verb, fail] of actions) {
      it(`keeps a ${verb} transport error while the listed item is unchanged`, async () => {
        fail();
        await startWithActions();
        fireEvent.click(await screen.findByRole("button", { name: button }));
        expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
        await advanceTo((item) => item);
        expect(screen.getByText(REACH_ERROR)).toBeTruthy();
      });

      for (const [label, change] of advances) {
        it(`clears a ${verb} transport error once the same operation shows ${label}`, async () => {
          fail();
          await startWithActions();
          fireEvent.click(await screen.findByRole("button", { name: button }));
          expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
          await advanceTo(change);
          await waitFor(() =>
            expect(screen.queryByText(REACH_ERROR)).toBeNull(),
          );
        });
      }
    }
  });

  describe("round 9: listed rule control errors follow the polled rule", () => {
    const REACH_ERROR = /Couldn't reach Studio Mac right now/;

    async function openRules(): Promise<void> {
      mount([SAVED_RULE]);
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await screen.findByRole("heading", { name: "Linux box" });
    }

    function pollRules(rules: readonly ProfileSyncRule[]): Promise<void> {
      listRules = rules;
      return act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }

    it("keeps a Pause error at the same rule revision and hides it once a later revision is listed", async () => {
      saveRuleThrows = true;
      await openRules();
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
      await pollRules([SAVED_RULE]);
      expect(screen.getByText(REACH_ERROR)).toBeTruthy();
      await pollRules([
        { ...SAVED_RULE, paused: true, status: "paused", revision: 2 },
      ]);
      await waitFor(() => expect(screen.queryByText(REACH_ERROR)).toBeNull());
    });

    it("keeps a Stop error while the rule is listed unchanged and hides it once the rule is gone", async () => {
      stopRuleThrows = true;
      await openRules();
      fireEvent.click(screen.getByRole("button", { name: "Stop…" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Stop automatic sync" }),
      );
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
      await pollRules([SAVED_RULE]);
      expect(screen.getByText(REACH_ERROR)).toBeTruthy();
      await pollRules([]);
      await waitFor(() => expect(screen.queryByText(REACH_ERROR)).toBeNull());
    });
  });

  describe("round 10: effective pause, editor drift and vanished runs", () => {
    const CHANGED_TEXT =
      "This rule changed while you were editing. Go back and reopen it to review the latest settings.";
    const STOPPED_TEXT = "This rule was stopped while you were editing.";

    function saveCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
      return messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.sync.saveRule",
      );
    }

    async function openAutomaticTab(): Promise<void> {
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await screen.findByRole("heading", { name: "Linux box" });
    }

    const pauseCases: ReadonlyArray<
      readonly [string, ProfileSyncRule, string, boolean]
    > = [
      [
        "an active rule",
        { ...SAVED_RULE, paused: false, status: "active" },
        "Pause",
        true,
      ],
      [
        "a rule with paused:true",
        { ...SAVED_RULE, paused: true, status: "paused" },
        "Resume",
        false,
      ],
      [
        "a rule with status paused but paused:false",
        { ...SAVED_RULE, paused: false, status: "paused" },
        "Resume",
        false,
      ],
    ];
    it.each(pauseCases)(
      "%s offers the effective action and saves the matching paused flag",
      async (_label, rule, button, expectedPaused) => {
        const messenger = mount([rule]);
        await openAutomaticTab();
        fireEvent.click(screen.getByRole("button", { name: button }));
        await waitFor(() => expect(saveCalls(messenger)).toHaveLength(1));
        const sent = profileSyncSaveRuleSchema.parse(
          saveCalls(messenger)[0].params,
        );
        expect(sent.paused).toBe(expectedPaused);
        expect(sent.expectedRevision).toBe(rule.revision);
      },
    );

    async function openEditorWithDraft(): Promise<
      MockHostMessenger<HostRpcRegistry>
    > {
      const messenger = mount([SAVED_RULE]);
      await openAutomaticTab();
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      // The user's draft: every provider instead of the saved codex-only scope.
      fireEvent.click(
        await screen.findByRole("checkbox", {
          name: /All supported providers/,
        }),
      );
      return messenger;
    }

    async function pollRulesNow(
      rules: readonly ProfileSyncRule[],
    ): Promise<void> {
      listRules = rules;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }

    it("keeps the draft but blocks Save when the open rule changed, and reopening saves against the latest revision", async () => {
      const messenger = await openEditorWithDraft();
      const latest: ProfileSyncRule = {
        ...SAVED_RULE,
        scope: { kind: "selected", providers: ["claude"] },
        paused: true,
        status: "paused",
        revision: 2,
      };
      await pollRulesNow([latest]);
      expect(await screen.findByText(CHANGED_TEXT)).toBeTruthy();
      expect(
        screen
          .getByRole("checkbox", { name: /All supported providers/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      const save = screen.getByRole("button", { name: "Save changes" });
      expect(save.hasAttribute("disabled")).toBe(true);
      fireEvent.click(save);
      expect(saveCalls(messenger)).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "← Automatic sync" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
      const trigger = await screen.findByRole("button", {
        name: "Choose providers",
      });
      expect(trigger.textContent).toMatch(/Claude/);
      expect(trigger.textContent).not.toMatch(/Codex/);
      const reopened = screen.getByRole("button", { name: "Save changes" });
      expect(reopened.hasAttribute("disabled")).toBe(false);
      fireEvent.click(reopened);
      await waitFor(() => expect(saveCalls(messenger)).toHaveLength(1));
      const sent = profileSyncSaveRuleSchema.parse(
        saveCalls(messenger)[0].params,
      );
      expect(sent.expectedRevision).toBe(2);
      expect(sent.paused).toBe(true);
      expect(sent.scope).toEqual({ kind: "selected", providers: ["claude"] });
    });

    it("says the rule was stopped, offers only Back, and never recreates it", async () => {
      const messenger = await openEditorWithDraft();
      await pollRulesNow([]);
      expect(await screen.findByText(STOPPED_TEXT)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "← Automatic sync" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
      expect(saveCalls(messenger)).toHaveLength(0);
    });

    it("returns to the selection body and footer when the opened run leaves the history, and previews again", async () => {
      listBatches = [
        {
          batchId: "00000000-0000-4000-8000-0000000000a9",
          sourceHostId: SOURCE_HOST_ID,
          createdAt: 1_700_000_000_000,
          automatic: false,
          items: [listedItem(DEST_HOST_ID)],
        },
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(
        await screen.findByRole("button", { name: /profile transfers/ }),
      );
      expect(
        await screen.findByRole("button", { name: "← Back" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
      listBatches = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Done" })).toBeNull(),
      );
      expect(screen.queryByRole("button", { name: "← Back" })).toBeNull();
      expect(
        screen
          .getByRole("checkbox", { name: /Linux box/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      // The cached preview for the unchanged selection may be reused, so the
      // rendered state, not a new request, is what proves it resumed.
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(screen.getByText("1 profile transfers selected")).toBeTruthy();
      expect(previewCalls(messenger).length).toBeGreaterThan(0);
    });
  });

  describe("round 11: reordered choices are the same selection", () => {
    it("keeps the batch id of an uncertain start when the same providers and devices are re-picked in another order", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/, /Old Mac/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      // Reorder the devices: take Linux box out and put it back after Old Mac.
      fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
      // Reorder the providers the same way.
      fireEvent.click(screen.getByRole("button", { name: "Choose providers" }));
      fireEvent.click(await screen.findByRole("option", { name: /Claude/ }));
      fireEvent.click(await screen.findByRole("option", { name: /Claude/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(second.selection).toEqual(first.selection);
      expect(second.batchId).toBe(first.batchId);
      // The wire form is canonical, whatever order the user picked in.
      expect(first.selection.destinationHostIds).toEqual(
        [...first.selection.destinationHostIds].sort(),
      );
      if (first.selection.scope.kind === "selected")
        expect(first.selection.scope.providers).toEqual(
          [...first.selection.scope.providers].sort(),
        );
    });
  });
});
