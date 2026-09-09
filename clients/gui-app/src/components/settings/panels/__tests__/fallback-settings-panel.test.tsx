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
import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";

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
    /**
     * F21's read-back: `FallbackSettingsPanelBody.refetchPolicy` calls
     * `query.refetch()` and reads `.data.policy` off the result. Defaulted in
     * `beforeEach` to resolve whatever `queryData` currently is, so a test that
     * never touches this still gets a well-formed (if irrelevant) answer; an
     * F21 case overrides it to drive "the host actually has X" independently
     * of what the panel last sent.
     */
    refetchMock: Mock<
      () => Promise<{
        readonly data: ProvidersFallbackPolicyGetResponse | undefined;
      }>
    >;
  } => ({
    queryData: undefined,
    queryIsError: false,
    setMutateAsync: vi.fn(),
    resetMutateAsync: vi.fn(),
    refetchMock: vi.fn(),
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
    refetch: fallbackMocks.refetchMock,
  }),
}));

// The F20 catalog read is out of this suite's scope; zero options is the
// documented "no answer" state that keeps the free-text Effort input, which is
// what this suite's existing assertions expect - none of them touches Effort.
vi.mock(
  "@/components/settings/panels/fallback/fallback-effort-options",
  () => ({
    useFallbackEffortOptions: () => () => [],
  }),
);

/**
 * The removal toast's options, typed AT the mock so the F18 test can invoke the
 * Undo action off the call record without asserting a shape onto it. A cast
 * there would be a test of the cast: it would keep compiling after the editor
 * stopped passing an action at all.
 */
interface UndoToastOptions {
  readonly action: { readonly label: string; readonly onClick: () => void };
}
const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<(message: string, options: UndoToastOptions) => void>(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
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
  fallbackMocks.refetchMock.mockReset();
  fallbackMocks.refetchMock.mockImplementation(() =>
    Promise.resolve({ data: fallbackMocks.queryData }),
  );
});

afterEach(() => {
  cleanup();
  toastSuccess.mockClear();
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

const TIER_SWITCH_LABEL =
  "Switch to an equivalent model on another provider - run this step";

describe("FallbackSettingsPanel - F15 a disabled step's echo does not move it past a terminal notify", () => {
  it("turning a step off then back on keeps it before notify, across the echo of the OFF commit", async () => {
    // Default policy's ladder is the canonical order - tier sits before
    // notify already, so this pins that turning it off and back ON does not
    // let the echo (which cannot represent WHERE the disabled step sat) move
    // it past the terminal notify.
    fallbackMocks.queryData = respond(policy({}));
    fallbackMocks.setMutateAsync.mockImplementation((input) =>
      Promise.resolve({ policy: input.policy }),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("switch", { name: TIER_SWITCH_LABEL }));
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(fallbackMocks.setMutateAsync.mock.calls[0][0].policy.ladder).toEqual(
      ["profile", "wait", "notify"],
    );

    // The SWITCH, not an "add this step back" link: that link is the terminal
    // `notify` row's one-way affordance (`FixedStepControl`), and `tier` is a
    // movable row, which keeps its switch in both states.
    fireEvent.click(screen.getByRole("switch", { name: TIER_SWITCH_LABEL }));
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(2);
    });
    // Falsification: change `save-succeeded`'s `displayOrder` computation in
    // `fallback-policy-draft.ts` from `fallbackDisplayOrderFor(...)` back to
    // `fallbackDisplayOrder(action.policy.ladder)` - re-deriving from the OFF
    // commit's echoed ladder (which has no "tier" in it at all) would then
    // append tier at the CANONICAL disabled position, and re-enabling it here
    // would land it after notify.
    const secondLadder =
      fallbackMocks.setMutateAsync.mock.calls[1][0].policy.ladder;
    expect(secondLadder.indexOf("tier")).toBeLessThan(
      secondLadder.indexOf("notify"),
    );
  });

  it("re-enabling a step that was already disabled at hydration (page reopened) also lands it before notify", async () => {
    fallbackMocks.queryData = respond(
      policy({ ladder: ["profile", "wait", "notify"] }),
    );
    fallbackMocks.setMutateAsync.mockResolvedValue({ policy: policy({}) });
    renderPanel();

    // The SWITCH, not an "add this step back" link: that link is the terminal
    // `notify` row's one-way affordance (`FixedStepControl`), and `tier` is a
    // movable row, which keeps its switch in both states.
    fireEvent.click(screen.getByRole("switch", { name: TIER_SWITCH_LABEL }));
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    });
    const ladder = fallbackMocks.setMutateAsync.mock.calls[0][0].policy.ladder;
    expect(ladder.indexOf("tier")).toBeLessThan(ladder.indexOf("notify"));
  });
});

describe("FallbackSettingsPanel - F18 Undo restores exactly the deleted row on top of the CURRENT draft", () => {
  it("undoing a group deletion after an unrelated commit keeps both the restored group and the new value", async () => {
    fallbackMocks.queryData = respond(
      policy({
        maxWaitMinutes: 360,
        tierGroups: [
          { id: "fast", candidates: [] },
          { id: "cheap", candidates: [] },
        ],
      }),
    );
    fallbackMocks.setMutateAsync.mockImplementation((input) =>
      Promise.resolve({ policy: input.policy }),
    );
    renderPanel();

    fireEvent.click(screen.getAllByRole("button", { name: "Delete group" })[0]);
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("fallback-tier-group-fast")).toBeNull();

    openCombobox("Longest wait for a reset");
    chooseOption("1 day");
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(2);
    });

    // Falsification: have the removal toast close over the whole policy AS IT
    // STOOD at deletion time and re-submit it (`onDelete` reverting to a
    // pre-`FallbackGroupsInverse` restore-point pattern in
    // `fallback-tier-groups-editor.tsx`) - Undo would then also revert
    // `maxWaitMinutes` back to 360, discarding the edit made after it.
    toastSuccess.mock.calls[0][1].action.onClick();

    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(3);
    });
    const finalPolicy = fallbackMocks.setMutateAsync.mock.calls[2][0].policy;
    expect(finalPolicy.tierGroups.map((group) => group.id)).toContain("fast");
    expect(finalPolicy.maxWaitMinutes).toBe(1440);
  });
});

describe("FallbackSettingsPanel - F21 an ambiguous transport failure does not claim the host's value", () => {
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  it("the automatic read-back settles an ambiguous failure on the HOST's value, even when that contradicts the revert a refusal would have done", async () => {
    // The scenario the outcome exists for: the host DID apply the save and the
    // reply was lost on the way back. Persisted is ON, the user turned it OFF,
    // and the host now has it OFF.
    fallbackMocks.queryData = respond(policy({ enabled: true }));
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReply());
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      data: respond(policy({ enabled: false })),
    });
    renderPanel();

    fireEvent.click(screen.getByRole("switch", { name: "Automatic fallback" }));

    // Falsification: fold `HostTransportFailureError` into the `refused` arm of
    // `classifyFallbackSaveFailure` (`fallback-settings-panel.tsx`). The
    // reducer would then revert to the persisted value and never fire the
    // read-back, so the switch would settle ON - the panel telling the user
    // automatic fallback is running while the host has it off, which is
    // precisely the claim this outcome may not make.
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Automatic fallback" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });
    // Settled, so nothing is left claiming uncertainty.
    await waitFor(() => {
      expect(screen.queryByTestId("fallback-host-error")).toBeNull();
    });
  });

  it("a read-back that answers nothing leaves the notice standing with 'Check again', and the manual retry settles it", async () => {
    fallbackMocks.queryData = respond(policy({ enabled: true }));
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReply());
    // The automatic read-back cannot answer either - `refetchPolicy` returns
    // `null` and the reducer is left holding the unknown save.
    fallbackMocks.refetchMock.mockResolvedValueOnce({ data: undefined });
    renderPanel();

    fireEvent.click(screen.getByRole("switch", { name: "Automatic fallback" }));

    const notice = await screen.findByTestId("fallback-host-error");
    expect(notice.textContent).not.toContain("still in force");
    expect(notice.textContent).toContain("may or may not have been saved");
    // The user's edit stands: an unknown outcome does not revert.
    expect(
      screen
        .getByRole("switch", { name: "Automatic fallback" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    const checkAgain = within(notice).getByTestId("fallback-check-again");

    // This time the host answers, and it says ON - a value the failed save's
    // own draft disagrees with, which is the whole reason neither was claimed.
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      data: respond(policy({ enabled: true })),
    });
    fireEvent.click(checkAgain);

    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Automatic fallback" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
    expect(screen.queryByTestId("fallback-host-error")).toBeNull();
  });

  it("a read-back that REJECTS reaches the same standing notice, and never leaks an unhandled rejection", async () => {
    // The positive control for this pair is the test above: a read-back that
    // RESOLVES with no data reaches the standing notice through
    // `refetchPolicy` returning `null`. This one drives the other route to the
    // same state - the promise rejecting - which is the route the panel's own
    // doc promises and only a `.catch` delivers.
    //
    // Same shape as the existing capture in
    // `src/lib/__tests__/epic-title-write-settlement.test.ts` - collected into
    // an array rather than a spy so a failure names WHAT leaked, not just that
    // something did.
    //
    // This capture is the ONLY thing in this workspace that can turn a leaked
    // rejection into a failing test, which is the whole justification for
    // asserting on it rather than trusting the runner. Three independent
    // reasons, none of them ours to change:
    //
    //  1. `vitest.config.ts:116` sets `dangerouslyIgnoreUnhandledErrors: true`,
    //     so vitest never converts an unhandled rejection into a run failure
    //     here - deliberately, to stop post-teardown escapes flaking CI.
    //  2. The setup file registers a PERMANENT `unhandledRejection` listener
    //     (`__tests__/test-browser-apis.ts:110-122`), so vitest's own reporter
    //     has already stood down before this test starts: `catchError`
    //     (`vitest/dist/chunks/init.*.js`) opens with
    //     `if (processListeners(event).length > 1) return;`.
    //  3. That setup listener only `console.error`s. A log is not an assertion,
    //     and nothing reads it.
    //
    // So the ablation below reddens THIS assertion and nothing else - there is
    // no file-level unhandled error racing it, and no runner behaviour to
    // attribute the failure to instead.
    //
    // The `finally` is still required, but for listener hygiene rather than for
    // vitest suppression (2 means the count is >1 with or without us): it
    // restores the count so the next capture in this file attributes its own
    // leaks rather than inheriting ours.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      fallbackMocks.queryData = respond(policy({ enabled: true }));
      fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReply());
      fallbackMocks.refetchMock.mockRejectedValueOnce(
        new Error("the read-back could not reach the host either"),
      );
      renderPanel();

      fireEvent.click(
        screen.getByRole("switch", { name: "Automatic fallback" }),
      );

      const notice = await screen.findByTestId("fallback-host-error");
      expect(notice.textContent).toContain("may or may not have been saved");
      // Still offered, because nothing has settled the question.
      expect(within(notice).getByTestId("fallback-check-again")).toBeDefined();
      // And the edit stands: a read-back that failed settles nothing, so it
      // must not revert any more than the failed save did.
      expect(
        screen
          .getByRole("switch", { name: "Automatic fallback" })
          .getAttribute("aria-checked"),
      ).toBe("false");

      // Falsification: drop the `.catch` after `reconcileUnknownSave(requestId)`
      // in `fallback-settings-panel.tsx`'s `commit`. The rejection the `void`
      // discards is then nobody's, Node reports it, and this fails - while
      // every OTHER assertion here still passes, which is why THIS assertion
      // and not the rendered state is what pins the change.
      //
      // TWO macrotasks, per the precedent this borrows: one for the rejection
      // to travel the promise chain, one for Node to run the check that judges
      // it unhandled. With a single tick the array is still empty at the
      // assertion whether or not the `.catch` exists - i.e. the pin would pass
      // for the wrong reason, which is the one failure mode it cannot afford.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("F21e: 'Check again' failing leaves the notice standing and leaks no unhandled rejection either", async () => {
    // The button path, which is a DIFFERENT `reconcileUnknownSave` call site
    // from the one F21d covers (`checkSaveOutcomeAgain` vs `commit`), and the
    // one a person reaches deliberately.
    //
    // F21c already clicks this same button - but with a RESOLVING refetch, so
    // it cannot see this: it exercises the settle, never the failure. Without
    // this test the button's reject path has no coverage at all, which is how
    // three of the four call sites kept an unowned rejection after the first
    // fix.
    //
    // Capture and drain as in F21d: two macrotasks, and this test's own
    // listener is the only thing in the workspace that can fail on a leak
    // (`vitest.config.ts:116`, `test-browser-apis.ts:110-122`).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      fallbackMocks.queryData = respond(policy({ enabled: true }));
      fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReply());
      // Call 1 is the AUTOMATIC read-back: answers nothing, so the notice and
      // its "Check again" stand. Call 2 is the button, and it rejects.
      fallbackMocks.refetchMock.mockResolvedValueOnce({ data: undefined });
      fallbackMocks.refetchMock.mockRejectedValueOnce(
        new Error("the host is still unreachable"),
      );
      renderPanel();

      fireEvent.click(
        screen.getByRole("switch", { name: "Automatic fallback" }),
      );

      const notice = await screen.findByTestId("fallback-host-error");
      fireEvent.click(within(notice).getByTestId("fallback-check-again"));

      // Still standing, and still offering the retry: a read-back that failed
      // settles nothing, so nothing about the notice may change.
      const after = await screen.findByTestId("fallback-host-error");
      expect(after.textContent).toContain("may or may not have been saved");
      expect(within(after).getByTestId("fallback-check-again")).toBeDefined();

      // Falsification: drop the `.catch` at the `checkSaveOutcomeAgain` call
      // site in `fallback-settings-panel.tsx`. Every assertion above still
      // passes - the notice is produced by NOT dispatching `reconciled` either
      // way - and only this one moves.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("CONTROL: a RetryableTransportError still reverts, says nothing was saved, and offers no 'Check again'", async () => {
    fallbackMocks.queryData = respond(policy({ enabled: true }));
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(
      new RetryableTransportError({
        code: "RPC_ERROR",
        message: "Couldn't reach this host, so nothing was saved.",
        requestId: "req-retry",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
        replaySafetyFromKey: false,
      }),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("switch", { name: "Automatic fallback" }));
    const notice = await screen.findByTestId("fallback-host-error");
    expect(notice.textContent).toContain("nothing was saved");
    expect(notice.textContent).toContain("still in force");
    expect(within(notice).queryByTestId("fallback-check-again")).toBeNull();
    expect(
      screen
        .getByRole("switch", { name: "Automatic fallback" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("FallbackSettingsPanel - F24 a Model family input keeps its identity across an async-rejected save", () => {
  it("stays the same DOM node and keeps focus once the rejection reverts the row", async () => {
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
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "policy is out of date",
        requestId: "req-reject",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
      }),
    );
    renderPanel();

    const familyInput = screen.getByLabelText<HTMLInputElement>("Model family");
    familyInput.focus();
    fireEvent.change(familyInput, { target: { value: "opus" } });
    fireEvent.keyDown(familyInput, { key: "Enter" });

    await screen.findByTestId("fallback-host-error");

    // Falsification: route `save-failed`'s revert through `reconcileKeyedGroups`
    // instead of `revertKeyedGroups` (fallback-policy-draft.ts) - a rejected
    // value-only edit would then be treated as a foreign list (identical
    // shape, different VALUE fails that stricter check) and re-seed, remounting
    // this exact input out from under the keystroke that was rejected.
    expect(screen.getByLabelText("Model family")).toBe(familyInput);
    expect(document.activeElement).toBe(familyInput);
  });
});
