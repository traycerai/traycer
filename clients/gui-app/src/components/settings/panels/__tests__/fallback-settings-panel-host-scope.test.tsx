import { cleanup, fireEvent, screen } from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
  type ProvidersFallbackPolicySetResponse,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";

/**
 * The scoping guarantee: a draft belongs to the host it was typed against, and
 * cannot be carried to another one.
 *
 * The policy is stored per Traycer user PER HOST (`provider-accounts.json` is
 * machine-local), so an editor that kept its draft across a host switch would
 * write one machine's settings into another machine's row - under the other
 * machine's name, with nothing on screen saying so. The panel prevents it by
 * keying the editor on `scope.hostId`, which remounts and re-seeds the reducer.
 *
 * What this suite can and cannot say. `useHostScope` is mocked, so "the policy
 * is re-read for the new host" is expressed as "the panel renders the new
 * host's policy" - the real per-host resolution happens inside
 * `useFallbackPolicyQuery`'s `useHostClient()`, which is mocked here too. The
 * claim proved is the panel's half: the draft does not survive, and what
 * replaces it is the new host's value.
 */
const scopeMocks = vi.hoisted(
  (): {
    hostId: string;
    hostName: string;
    queryData: ProvidersFallbackPolicyGetResponse | undefined;
    setMutateAsync: Mock<
      (input: {
        readonly policy: FallbackPolicy;
      }) => Promise<ProvidersFallbackPolicySetResponse>
    >;
  } => ({
    hostId: "host-a",
    hostName: "Studio",
    queryData: undefined,
    setMutateAsync: vi.fn(),
  }),
);

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    // Read per render, not captured once: the whole subject is what happens
    // when this answer CHANGES between two renders.
    useHostScope: () => {
      const host = hostScopeOptionFixture({
        hostId: scopeMocks.hostId,
        name: scopeMocks.hostName,
      });
      return hostScopeFixture({
        hosts: [host],
        host,
        hostId: host.hostId,
        hostLabel: host.name,
        activeHost: host,
        isViewingActive: true,
        status: "following",
        client: null,
      });
    },
  };
});

vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: false,
    data: scopeMocks.queryData,
  }),
}));

// The in-flight-count poll calls `useHostClient()` too, unreachable outside a
// `<HostRuntimeProvider>`. `data: undefined` leaves the panel on the count
// the mocked policy read above carries; the polled count itself is
// `fallback-settings-panel-in-flight-count.test.tsx`'s subject, not this
// scoping suite's.
vi.mock("@/hooks/providers/use-fallback-in-flight-count-query", () => ({
  useFallbackInFlightCountQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-set-mutation", () => ({
  useFallbackPolicySetMutation: () => ({
    mutateAsync: scopeMocks.setMutateAsync,
  }),
}));
vi.mock("@/hooks/providers/use-fallback-policy-reset-mutation", () => ({
  useFallbackPolicyResetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock(
  "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation",
  () => ({
    useFallbackPolicyRestoreTierGroupsMutation: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock(
  "@/hooks/providers/use-fallback-policy-preview-tier-groups-query",
  () => ({
    useFallbackPolicyPreviewTierGroupsQuery: () => ({
      data: undefined,
      isFetching: false,
    }),
  }),
);
// The Model and Effort cells' catalog read is out of this suite's scope, and
// `useFallbackCatalogOptions` calls `useHostClient()`, which throws outside a
// `<HostRuntimeProvider>` (`src/lib/host/runtime.ts:125`). Empty catalogs are
// the documented "no answer" state: the Model cell still renders - pinned on
// the row's own stored family - so `modelTriggerText()` below can read it
// straight off the Select's trigger. `importOriginal` keeps
// `catalogModelForFamily`, which the card imports directly from this module.
vi.mock(
  "@/components/settings/panels/fallback/fallback-catalog-options",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/panels/fallback/fallback-catalog-options")
      >();
    return {
      ...actual,
      useFallbackCatalogOptions: () => ({
        modelsFor: () => [],
        effortsFor: () => [],
      }),
    };
  },
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessModelsQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";
import {
  openFallbackTab,
  renderWithFallbackQueryClient,
} from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";

function groups(modelFamily: string): TierGroup[] {
  return [
    {
      id: "frontier",
      candidates: [{ harnessId: "claude", modelFamily, reasoningEffort: null }],
    },
  ];
}

function respond(
  overrides: Partial<FallbackPolicy>,
): ProvidersFallbackPolicyGetResponse {
  return {
    policy: { ...createDefaultFallbackPolicy(), enabled: true, ...overrides },
    storedPolicyUnreadable: false,
    inFlightCount: 0,
  };
}

function renderPanel() {
  return renderWithFallbackQueryClient(
    <StrictMode>
      <FallbackSettingsPanel />
    </StrictMode>,
  );
}

/**
 * The group's name field - the one free-text control left on a row now that
 * the Model and Effort cells are Selects (which commit on every interaction,
 * not on blur/Enter), so it is what still carries an UNCOMMITTED draft value
 * to drive this suite's "typed but not sent" states.
 */
function groupNameInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Group name");
}

/** The Model cell's own displayed value - a pinned family name here, since
 * the catalog mock above never resolves it to a catalog model. Reading it
 * off the trigger is this suite's way of seeing WHICH host's policy is on
 * screen, now that the value used to live in a plain textbox. */
function modelTriggerText(): string {
  return screen.getByRole("combobox", { name: "Model" }).textContent;
}

beforeEach(() => {
  scopeMocks.hostId = "host-a";
  scopeMocks.hostName = "Studio";
  scopeMocks.queryData = respond({ tierGroups: groups("opus") });
  scopeMocks.setMutateAsync.mockReset();
  scopeMocks.setMutateAsync.mockResolvedValue({
    policy: { ...createDefaultFallbackPolicy(), enabled: true },
  });
});

afterEach(() => {
  cleanup();
});

describe("FallbackSettingsPanel - a draft cannot travel to another host", () => {
  it("drops an uncommitted edit and shows the new host's policy when the scope moves", () => {
    const { rerender } = renderPanel();
    openFallbackTab("equivalentModels");
    expect(groupNameInput().value).toBe("frontier");
    expect(modelTriggerText()).toBe("opus");

    // Typed but NOT committed - no blur, no Enter - so it exists only in this
    // host's draft and has never been sent anywhere.
    fireEvent.change(groupNameInput(), { target: { value: "frontier-typed" } });
    expect(groupNameInput().value).toBe("frontier-typed");
    expect(scopeMocks.setMutateAsync).not.toHaveBeenCalled();

    // The picker moves to another machine, whose stored policy is different.
    scopeMocks.hostId = "host-b";
    scopeMocks.hostName = "Laptop";
    scopeMocks.queryData = respond({ tierGroups: groups("haiku") });
    rerender(
      <StrictMode>
        <FallbackSettingsPanel />
      </StrictMode>,
    );

    // The draft did not travel: what is on screen is host B's stored value,
    // not the text typed against host A. The host switch remounted the
    // editor (its `key` carries `scope.hostId`), which reset the tab rail
    // back to its default - reopen it to reach the group's controls again.
    openFallbackTab("equivalentModels");
    expect(groupNameInput().value).toBe("frontier");
    expect(modelTriggerText()).toBe("haiku");
    // And it was not written to either host on the way out. This is the half
    // that matters most - a draft that vanished from the screen but was saved
    // to the new host's row would satisfy the assertion above.
    expect(scopeMocks.setMutateAsync).not.toHaveBeenCalled();
    // The header names the host it is now configuring, so the surface is not
    // silently pointing somewhere else.
    expect(
      screen.getByText(/Applies to your chat agents on Laptop/),
    ).toBeTruthy();
  });

  it("CONTROL: the same uncommitted edit survives a re-render that does NOT change the host", () => {
    // Without this, the test above would pass on a panel that discarded every
    // draft on every render - which would be a different bug wearing the same
    // green. The only difference between the two is `scope.hostId`.
    const { rerender } = renderPanel();
    openFallbackTab("equivalentModels");
    fireEvent.change(groupNameInput(), { target: { value: "frontier-typed" } });

    scopeMocks.queryData = respond({ tierGroups: groups("haiku") });
    rerender(
      <StrictMode>
        <FallbackSettingsPanel />
      </StrictMode>,
    );

    // Still the typed value: a later READ does not reach a control either, which
    // is the other half of the seeding rule - a background refetch must not yank
    // a value out from under someone mid-edit. Only the HOST changing does.
    expect(groupNameInput().value).toBe("frontier-typed");
    expect(scopeMocks.setMutateAsync).not.toHaveBeenCalled();
  });
});
