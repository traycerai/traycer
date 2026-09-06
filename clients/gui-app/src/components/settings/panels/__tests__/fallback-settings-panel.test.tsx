import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  type ProvidersFallbackPolicyResetResponse,
  type ProvidersFallbackPolicySetResponse,
} from "@traycer/protocol/host/fallback-policy";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * Full-panel coverage for the two failure kinds and the reset path -
 * everything that needs the real reducer wired to real controls, with only
 * the host RPC boundary (the three fallback-policy hooks) and the host scope
 * faked, following the precedent in
 * `agent-selection-guide-section.test.tsx`.
 */
const fallbackMocks = vi.hoisted(
  (): {
    queryData: ProvidersFallbackPolicyGetResponse | undefined;
    queryIsError: boolean;
    setMutateAsync: Mock<
      (input: {
        readonly policy: FallbackPolicy;
      }) => Promise<ProvidersFallbackPolicySetResponse>
    >;
    resetMutateAsync: Mock<
      (
        input: Record<string, never>,
      ) => Promise<ProvidersFallbackPolicyResetResponse>
    >;
  } => ({
    queryData: undefined,
    queryIsError: false,
    setMutateAsync: vi.fn(),
    resetMutateAsync: vi.fn(),
  }),
);

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const host = hostScopeOptionFixture({ hostId: "host-a", name: "Test Host" });
  return {
    useHostScope: () =>
      hostScopeFixture({
        hosts: [host],
        host,
        hostId: host.hostId,
        hostLabel: host.name,
        activeHost: host,
        isViewingActive: true,
        status: "following",
        client: null,
      }),
  };
});

vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: fallbackMocks.queryIsError,
    data: fallbackMocks.queryData,
  }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-set-mutation", () => ({
  useFallbackPolicySetMutation: () => ({
    mutateAsync: fallbackMocks.setMutateAsync,
  }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-reset-mutation", () => ({
  useFallbackPolicyResetMutation: () => ({
    mutateAsync: fallbackMocks.resetMutateAsync,
  }),
}));

// Neither the "Restore the default groups" flow nor the per-row preview
// verdicts are this suite's scope - both would otherwise throw via
// `useHostClient()` outside a `<HostRuntimeProvider>`, so they are made inert.
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

// Sidesteps `useHostClient()` throwing outside a `<HostRuntimeProvider>`: the
// ladder's "profile" step hint is out of this suite's scope (model groups /
// step 4 territory), so it is made inert rather than wired up.
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), enabled: true, ...overrides };
}

function respond(
  policyValue: FallbackPolicy,
): ProvidersFallbackPolicyGetResponse {
  return {
    policy: policyValue,
    storedPolicyUnreadable: false,
    inFlightCount: 0,
  };
}

function renderPanel() {
  return render(
    <StrictMode>
      <FallbackSettingsPanel />
    </StrictMode>,
  );
}

/** Radix's select: open with the keyboard, then commit the named option. */
function openCombobox(name: string): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), {
    key: "ArrowDown",
  });
}

function chooseOption(name: string): void {
  const item = screen.getByRole("option", { name });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

beforeEach(() => {
  fallbackMocks.queryData = respond(policy({}));
  fallbackMocks.queryIsError = false;
  fallbackMocks.setMutateAsync.mockReset();
  fallbackMocks.resetMutateAsync.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FallbackSettingsPanel - local validation failure sends nothing", () => {
  it("keeps the invalid draft on screen, shows the error under the edited group, and never calls the save mutation", async () => {
    // The stored grace window is already outside the WIRE schema's own range
    // (max 300) - unreachable through this control alone, but exactly the
    // state a programmatic writer can leave behind. Editing a DIFFERENT,
    // ordinary control still produces an invalid combined draft, which is a
    // real path a person can hit without ever touching the bad field.
    fallbackMocks.queryData = respond(
      policy({ graceWindowSeconds: 400, maxWaitMinutes: 360 }),
    );
    renderPanel();

    openCombobox("Longest wait for a reset");
    chooseOption("1 day");

    const error = await screen.findByTestId("fallback-local-error");
    expect(error.textContent).toContain(
      "Time to cancel must be a whole number of seconds.",
    );
    expect(error.textContent).toContain("nothing has been saved");

    // The pin: stub `validateFallbackPolicyDraft` to always report "valid"
    // (or delete the `if (validation.kind === "invalid") return;` guard in
    // `commit`) and this assertion goes red - the mutation would fire despite
    // the draft being invalid.
    expect(fallbackMocks.setMutateAsync).not.toHaveBeenCalled();

    // The edited-but-invalid value is still what is on screen. Selecting an
    // option closes the popover, so it has to be reopened to read the
    // control's current selection back.
    openCombobox("Longest wait for a reset");
    expect(
      screen.getByRole("option", { name: "1 day" }).getAttribute("data-state"),
    ).toBe("checked");

    // Scoped to "behavior" - no error under the danger zone. Stub
    // `FallbackSaveStatus`'s `activeField === props.field` gate to always
    // render (or drop the `field` prop threading entirely) and this would
    // print the error a second time here.
    const dangerZone = screen.getByTestId("settings-fallback-danger-zone");
    expect(within(dangerZone).queryByTestId("fallback-local-error")).toBeNull();
  });
});

describe("FallbackSettingsPanel - a host rejection reverts and names the reason", () => {
  it("reverts the control to the persisted value and prints the host's reason under the group that was edited", async () => {
    fallbackMocks.queryData = respond(
      policy({ graceWindowSeconds: 15, maxWaitMinutes: 360 }),
    );
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "policy is out of date",
        requestId: "req-1",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
      }),
    );
    renderPanel();

    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");

    const error = await screen.findByTestId("fallback-host-error");
    expect(error.textContent).toContain("Couldn't save: policy is out of date");
    expect(error.textContent).toContain(
      "Your last saved settings are back on screen and still in force.",
    );

    // The revert: the control shows the PERSISTED value again, not the
    // rejected edit.
    openCombobox("Time to cancel before switching");
    expect(
      screen
        .getByRole("option", { name: "15 seconds" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });
});

describe("FallbackSettingsPanel - reset reads from the refetch, never the mutation response", () => {
  it("remounts the editor onto whatever the next read returns, ignoring the reset mutation's own response entirely", async () => {
    // The starting policy is deliberately DISABLED, which is the opposite of
    // what the gate below waits for. An enabled fixture made that `waitFor`
    // vacuous - it was satisfied by the first render, so the test read its
    // assertions before any remount had happened and reported the failure
    // against the wrong line.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    renderPanel();

    // Installed BEFORE the click, not after it. The panel calls
    // `resetMutation.mutateAsync({}).then(...)` synchronously from the confirm
    // handler, so a mock armed afterwards leaves the bare `vi.fn()` in place,
    // `mutateAsync` answers `undefined`, and the `.then` throws inside a React
    // event handler - which surfaces as an unrelated assertion failure three
    // lines later rather than as "the mutation was never stubbed".
    //
    // The mutation resolves with a policy that is DISABLED and has a
    // DIFFERENT grace window - if the panel ever wrote this response into the
    // reducer (the D116/D127 bug this test exists to catch), the assertions
    // below would see these values instead of the refetch's.
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() => {
      // Simulate the refetch landing (the real mutation invalidates and
      // awaits the query, so by the time `mutateAsync` resolves the next read
      // is already in place) with policy the panel has not seen before. This
      // body has nothing to await - it just mutates the mocked query's data
      // and returns - so it stays a plain function returning an already-
      // resolved promise, rather than an `async` function with no `await` in
      // it.
      fallbackMocks.queryData = respond(
        policy({ enabled: true, graceWindowSeconds: 13 }),
      );
      return Promise.resolve({
        policy: policy({ enabled: false, graceWindowSeconds: 10 }),
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));

    // Wait for the remount to reflect the REFETCHED policy (enabled, 13
    // seconds), not the mutation's own response (disabled, 10 seconds). Only
    // the refetch can turn this switch on: the fixture starts it off and the
    // mutation response would leave it off.
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Automatic fallback" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    openCombobox("Time to cancel before switching");
    expect(
      screen
        .getByRole("option", { name: "13 seconds" })
        .getAttribute("data-state"),
    ).toBe("checked");
    // The mutation's own value must not be the one in force. Stated as
    // UNCHECKED rather than absent: 10 is a standing member of
    // `GRACE_WINDOW_SECONDS`, so the option is in this menu whatever the policy
    // says, and asserting its absence asked for something that can never be
    // true rather than for the thing the test is about.
    expect(
      screen
        .getByRole("option", { name: "10 seconds" })
        .getAttribute("data-state"),
    ).toBe("unchecked");
  });
});

describe("FallbackSettingsPanel - a refused reset reports under the danger zone", () => {
  it("prints the reset's own refusal under the danger zone, not under whichever group was edited last", async () => {
    fallbackMocks.queryData = respond(policy({ graceWindowSeconds: 15 }));
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "stale edit",
        requestId: "req-2",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
      }),
    );
    renderPanel();

    // Leave a rejected edit sitting under "behavior" first.
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");
    await screen.findByTestId("fallback-host-error");

    fallbackMocks.resetMutateAsync.mockRejectedValueOnce(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "reset refused",
        requestId: "req-3",
        method: "providers.fallbackPolicy.reset",
        fatalDetails: null,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));

    const dangerZone = screen.getByTestId("settings-fallback-danger-zone");
    const dangerError = await within(dangerZone).findByTestId(
      "fallback-host-error",
    );
    expect(dangerError.textContent).toContain("Couldn't save: reset refused");

    // The stale "behavior" error from before the reset must not remain
    // rendered anywhere - only one status line is ever active at a time, and
    // the group it belonged to renders nothing once `activeField` moves on.
    expect(screen.queryByText(/stale edit/)).toBeNull();
  });
});

describe("FallbackSettingsPanel - a text field commits on blur/Enter, not per keystroke (D181)", () => {
  it("sends exactly one save carrying the full typed value, only once the field is left - unlike an immediate control", () => {
    fallbackMocks.queryData = respond(
      policy({
        tierGroups: [
          {
            id: "fast",
            candidates: [
              { harnessId: "claude", modelFamily: "", reasoningEffort: null },
            ],
          },
        ],
      }),
    );
    // Every commit in this test needs somewhere to resolve to; the content of
    // the response is irrelevant here, since every assertion below reads the
    // REQUEST the mutation was called with, never its resolved value.
    fallbackMocks.setMutateAsync.mockResolvedValue({
      policy: policy({}),
    });
    renderPanel();

    const familyInput = () =>
      screen.getByLabelText<HTMLInputElement>("Model family");

    // Five keystrokes, each its own `change` event - the draft moves each
    // time, and nothing is sent while typing is in progress.
    for (const value of ["o", "op", "opu", "opus", "opus1"]) {
      fireEvent.change(familyInput(), { target: { value } });
    }
    expect(fallbackMocks.setMutateAsync).not.toHaveBeenCalled();

    fireEvent.blur(familyInput());
    expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    const blurCall = fallbackMocks.setMutateAsync.mock.calls[0][0];
    // The FULL five-character value, not a stale prefix - the count
    // assertion alone would still pass if blur sent whatever value the
    // handler had captured earliest ("o").
    expect(blurCall.policy.tierGroups[0].candidates[0].modelFamily).toBe(
      "opus1",
    );

    // Enter also commits, and needs no blur to do it.
    fireEvent.change(familyInput(), { target: { value: "sonnet" } });
    expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(familyInput(), { key: "Enter" });
    expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(2);
    const enterCall = fallbackMocks.setMutateAsync.mock.calls[1][0];
    expect(enterCall.policy.tierGroups[0].candidates[0].modelFamily).toBe(
      "sonnet",
    );

    // The control: an immediate control (the master switch) is unaffected by
    // the blur/Enter rule and still commits on its own interaction, with no
    // blur involved at all. Without this, a change that broke committing
    // ENTIRELY (e.g. `commit` silently doing nothing) would read as "text
    // fields correctly wait for blur" instead of "nothing saves any more".
    fireEvent.click(screen.getByRole("switch", { name: "Automatic fallback" }));
    expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(3);
  });
});
