import {
  act,
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
  type ProvidersFallbackPolicyRestoreTierGroupsResponse,
  type ProvidersFallbackPolicySetResponse,
  type TierGroup,
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

/**
 * What `query.refetch()` resolves with, in the shape the panel actually reads.
 *
 * Deliberately the two fields the production code consults and no more:
 * `isSuccess` decides whether the read-back may be believed, and `data` is what
 * it returns when it may. A failed refetch sets `isSuccess: false` while KEEPING
 * `data` - that pairing is the whole of R1, so the type has to permit it.
 */
interface FallbackRefetchResult {
  readonly isSuccess: boolean;
  readonly data: ProvidersFallbackPolicyGetResponse | undefined;
}

/** The two fields `FallbackSettingsPanelBody` reads off the query. */
interface FallbackQuerySnapshot {
  readonly data: ProvidersFallbackPolicyGetResponse | undefined;
  readonly isError: boolean;
}

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
     * The RESTORE operation, drivable rather than inert.
     *
     * It used to be a `vi.fn()` minted inside the module mock's factory, which
     * is unreachable by construction - a fresh function every call, so no test
     * could ever arm it. D347 needs the restore's OWN lost reply, not a
     * stand-in, so it routes through the fixture the way `set` and `reset` do.
     * The hook itself stays mocked, which was the reason it was inert: it
     * would otherwise reach `useHostClient()` outside a provider.
     */
    restoreMutateAsync: Mock<
      (
        input: Record<string, never>,
      ) => Promise<ProvidersFallbackPolicyRestoreTierGroupsResponse>
    >;
    /**
     * F21's read-back: `FallbackSettingsPanelBody.refetchPolicy` calls
     * `query.refetch()` and decides on the result's `isSuccess`. Defaulted in
     * `beforeEach` to a successful resolution of whatever `queryData` currently
     * is, so a test that never touches this still gets a well-formed (if
     * irrelevant) answer; an F21 case overrides it to drive "the host actually
     * has X" independently of what the panel last sent.
     *
     * Carries `isSuccess` and not just `data` because the production failure
     * shape is not "no data". TanStack types
     * `QueryObserverRefetchErrorResult.data` as PRESENT and the query's error
     * reducer keeps the previous value, so a refetch that fails on an editor
     * that already loaded resolves with the STALE policy plus `isError`. A
     * double that can only express `{ data: undefined }` cannot produce the
     * one state R1 is about, which is how that path stayed unpinned.
     */
    refetchMock: Mock<() => Promise<FallbackRefetchResult>>;
    /** `useSyncExternalStore`'s two halves, plus the flag-flip that notifies. */
    subscribeToQuery: (onChange: () => void) => () => void;
    querySnapshot: () => FallbackQuerySnapshot;
    setQueryIsError: (isError: boolean) => void;
  } => {
    const listeners = new Set<() => void>();
    // Cached so `getSnapshot` returns a STABLE reference while nothing has
    // changed - React re-invokes it every render and loops if the identity
    // moves each time. Rebuilt exactly when one of the two values does, which
    // is also what makes a pre-render assignment to `queryData` visible with no
    // notification at all.
    let cached: FallbackQuerySnapshot | null = null;
    const fixture = {
      queryData: undefined as ProvidersFallbackPolicyGetResponse | undefined,
      queryIsError: false,
      setMutateAsync: vi.fn(),
      resetMutateAsync: vi.fn(),
      restoreMutateAsync: vi.fn(),
      refetchMock: vi.fn(),
      subscribeToQuery: (onChange: () => void): (() => void) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      querySnapshot: (): FallbackQuerySnapshot => {
        if (
          cached === null ||
          cached.data !== fixture.queryData ||
          cached.isError !== fixture.queryIsError
        ) {
          cached = { data: fixture.queryData, isError: fixture.queryIsError };
        }
        return cached;
      },
      setQueryIsError: (isError: boolean): void => {
        fixture.queryIsError = isError;
        for (const listener of listeners) listener();
      },
    };
    return fixture;
  },
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

/**
 * The query double SUBSCRIBES, because the real one does.
 *
 * `useFallbackPolicyQuery` is a TanStack hook: when a fetch fails, the observer
 * notifies and `FallbackSettingsPanelBody` re-renders with `isError: true`. That
 * re-render is the whole event R1 turns on - it is when the body re-evaluates
 * whether to keep the editor - and a plain `() => ({ ... })` double cannot
 * produce it, since nothing tells React to run the body again. A test written
 * against that double would assert the editor survived a re-render that never
 * happened, and would pass with the bug present.
 *
 * `useSyncExternalStore` over the same mutable fixture keeps every existing
 * test working (they assign `queryData` before rendering, and `getSnapshot`
 * rebuilds on a value change) while letting a test flip the flag mid-run and
 * have the panel actually hear about it.
 */
vi.mock("@/hooks/providers/use-fallback-policy-query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useFallbackPolicyQuery: () => {
      const snapshot = useSyncExternalStore(
        fallbackMocks.subscribeToQuery,
        fallbackMocks.querySnapshot,
      );
      return {
        isError: snapshot.isError,
        data: snapshot.data,
        refetch: fallbackMocks.refetchMock,
      };
    },
  };
});

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

// The per-row preview verdicts are not this suite's scope and would throw via
// `useHostClient()` outside a `<HostRuntimeProvider>`, so that one stays inert.
// The restore flow was inert for the same reason and is no longer - see
// `restoreMutateAsync` on the fixture type for why, and for what did NOT
// change about it.
vi.mock(
  "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation",
  () => ({
    useFallbackPolicyRestoreTierGroupsMutation: () => ({
      mutateAsync: fallbackMocks.restoreMutateAsync,
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
/**
 * Let a reply that was just settled reach the reducer and the DOM.
 *
 * These tests used to write `await act(async () => { saveA.rejectWith(…) })`,
 * whose body has no `await` - which is exactly what `require-await` objects to.
 * The fix is NOT to make the body synchronous: `act(() => …)` returns without
 * awaiting, so the promise continuations the settle just queued would still be
 * pending when the assertions below run, and every one of these tests asserts on
 * what the panel does AFTER the host answers. The await is real, it just belongs
 * in one place instead of thirty-three.
 *
 * Settle first, then call this - `deferred()`'s resolvers are plain calls and
 * need no act() of their own; what needs flushing is React's response to them.
 */
async function flushHostReplies(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

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
    Promise.resolve({ isSuccess: true, data: fallbackMocks.queryData }),
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
      // Put the post-reset policy in the cache the panel is about to READ. The
      // panel performs its own `refetchPolicy()` after the mutation settles
      // (R8: the mutation's invalidation neither refetches nor could report a
      // failure if it did), and the default `refetchMock` answers with whatever
      // `queryData` holds - so writing it here is what that read returns. This
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

  it("R3: a reset refused AFTER the dialog has closed leaves the keyboard on the enabled Reset button, not on the body", async () => {
    fallbackMocks.queryData = respond(policy({}));
    // Deferred, because the timing IS the bug. The dialog closes and the
    // request starts in one gesture, so Radix's `onCloseAutoFocus` - which it
    // runs from a `setTimeout(0)`, a tick after that render - finds the opener
    // still mounted and `disabled={isPending}`. A refusal that had already
    // settled would have re-enabled the button before then and hidden this.
    let refuseReset = (): void => {};
    fallbackMocks.resetMutateAsync.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuseReset = () =>
            reject(
              new HostRpcError({
                code: "RPC_ERROR",
                message: "reset refused",
                requestId: "req-r3",
                method: "providers.fallbackPolicy.reset",
                fatalDetails: null,
              }),
            );
        }),
    );
    renderPanel();

    const reset = screen.getByRole("button", { name: "Reset" });
    fireEvent.click(reset);
    fireEvent.click(screen.getByTestId("confirm-action"));

    // Mid-flight: the button is disabled, so the dialog's restoration cannot
    // land on it. This is the state that strands focus.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Reset" }).hasAttribute("disabled"),
      ).toBe(true);
    });
    // Radix defers `onCloseAutoFocus` to a macrotask; let it run, so this test
    // measures the state AFTER the dialog has had its say rather than before.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    refuseReset();
    await flushHostReplies();

    const dangerZone = screen.getByTestId("settings-fallback-danger-zone");
    expect(
      (await within(dangerZone).findByTestId("fallback-host-error"))
        .textContent,
    ).toContain("Couldn't save: reset refused");

    // Falsification: delete the second `useEffect` in `fallback-danger-zone.tsx`
    // (the one keyed on `isPending`). Nothing then moves focus after the
    // refusal - the dialog already spent its restoration on a disabled button -
    // and `document.activeElement` stays `document.body`.
    await waitFor(() => {
      const settled = screen.getByRole("button", { name: "Reset" });
      expect(settled.hasAttribute("disabled")).toBe(false);
      expect(document.activeElement).toBe(settled);
    });
  });

  it("a confirmed reset returns focus to the remounted Reset button, not to the document body", async () => {
    // The success half of the same guarantee, end to end at the panel. The
    // coverage walk recorded this as half-pinned - the existing confirmed-reset
    // test asserts policy values and nothing about focus - and the shared
    // dialog's own comment pointed at it as if it did.
    //
    // This is the case the dialog's `isConnected` branch deliberately declines:
    // a confirmed reset REMOUNTS the editor, so the opener the dialog captured
    // is detached when `onCloseAutoFocus` runs, and the panel's own
    // `returnFocusToReset` intent is what puts the keyboard back.
    fallbackMocks.queryData = respond(policy({ enabled: true }));
    fallbackMocks.resetMutateAsync.mockResolvedValueOnce({
      policy: policy({ enabled: false }),
    });
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: true,
      data: respond(policy({ enabled: false })),
    });
    renderPanel();

    const before = screen.getByRole("button", { name: "Reset" });
    fireEvent.click(before);
    fireEvent.click(screen.getByTestId("confirm-action"));
    // Let Radix's deferred `onCloseAutoFocus` run before measuring, so this
    // reads the settled state rather than the one before the dialog had its
    // say.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Falsification: stop passing `focusResetOnMount` from the panel (drop
    // `setReturnFocusToReset(true)` in `onPolicyReplaced`). The editor still
    // remounts, but the opener the dialog captured is gone with the old
    // subtree, so focus falls to `document.body` and stays there.
    await waitFor(() => {
      const after = screen.getByRole("button", { name: "Reset" });
      expect(document.activeElement).toBe(after);
    });
  });
});

describe("FallbackSettingsPanel - a text field commits on blur/Enter, not per keystroke (D181)", () => {
  it("R6: a GROUP RENAME sends nothing while typing and exactly one save carrying the full final name on blur, at the real panel boundary", () => {
    // The editor-level F16 test cannot establish this. Its harness wires
    // `onChange` and `onCommit` to the same `adopt`, so the final name is
    // already in the input before blur and its closing assertion holds whether
    // or not a commit happens on blur. It pins DOM identity, which is a real
    // and separate thing, and this pins the commit rule - here, where the
    // mutation spy is the panel's actual save path.
    fallbackMocks.queryData = respond(
      policy({
        tierGroups: [
          { id: "fast", candidates: [] },
          { id: "cheap", candidates: [] },
        ],
      }),
    );
    fallbackMocks.setMutateAsync.mockResolvedValue({ policy: policy({}) });
    renderPanel();

    const nameInputs = () =>
      screen.getAllByLabelText<HTMLInputElement>("Group name");
    const input = nameInputs()[0];
    input.focus();

    // Through a DUPLICATE of the sibling's name and through empty - both
    // states the schema rejects, and neither may be sent.
    for (const value of ["c", "ch", "cheap", "", "fastest"]) {
      fireEvent.change(input, { target: { value } });
      // Identity survives the intermediates: same node, still focused.
      expect(nameInputs()[0]).toBe(input);
      expect(document.activeElement).toBe(input);
    }
    // Falsification A: commit the rename from the card's `onChange` instead of
    // its `onCommit` (`fallback-tier-group-card.tsx`). Five saves would be sent
    // while typing, two of them carrying a policy the schema refuses.
    expect(fallbackMocks.setMutateAsync).not.toHaveBeenCalled();

    fireEvent.blur(input);

    // Falsification B: drop the blur/Enter commit entirely - the rename would
    // then live only in the draft and this count would be 0, which the
    // editor-level test cannot see because its harness updates the input from
    // the same handler either way.
    expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    expect(
      fallbackMocks.setMutateAsync.mock.calls[0][0].policy.tierGroups.map(
        (group) => group.id,
      ),
    ).toEqual(["fastest", "cheap"]);
  });

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
  it("turning a step off then back on preserves the WHOLE local order across the echo of the OFF commit", async () => {
    // A NONCANONICAL stored order, and deliberately one where the step being
    // disabled is not already next to `notify`.
    //
    // R6: the earlier version of this test started from the canonical ladder
    // and asserted only `tier < notify`, which its own stated falsifier cannot
    // break. Re-deriving from the echoed ladder `[profile, wait, notify]` puts
    // the disabled `tier` at the canonical disabled position - immediately
    // before `notify` - so the ordering assertion held either way and the test
    // proved nothing about the call site it named.
    //
    // Starting from `[tier, profile, wait, notify]` separates them: preserving
    // the local order keeps `tier` FIRST, while re-deriving moves it to third.
    // Both still satisfy "before notify", which is exactly why the assertion
    // below is the complete array.
    fallbackMocks.queryData = respond(
      policy({ ladder: ["tier", "profile", "wait", "notify"] }),
    );
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
    // `fallbackDisplayOrder(action.policy.ladder)`. The echo of the OFF commit
    // carries no `tier` at all, so re-deriving discards where the user had it
    // and rebuilds the row order from the canonical one - re-enabling then
    // sends `[profile, wait, tier, notify]` instead of the order that was on
    // screen the whole time.
    expect(fallbackMocks.setMutateAsync.mock.calls[1][0].policy.ladder).toEqual(
      ["tier", "profile", "wait", "notify"],
    );
  });

  it("R5: re-enabling a step below an externally authored EARLY notify moves it above the terminal step instead of committing a row that can never run", async () => {
    // Written elsewhere, not by this editor: `notify` is stored second, with
    // `tier` after it. The editor renders that honestly - the enabled steps
    // keep their stored order - so `tier` legitimately sits below `notify`.
    fallbackMocks.queryData = respond(
      policy({ ladder: ["profile", "notify", "tier"] }),
    );
    fallbackMocks.setMutateAsync.mockImplementation((input) =>
      Promise.resolve({ policy: input.policy }),
    );
    renderPanel();

    // Off: the ladder loses `tier`, and the local order deliberately does NOT
    // move it - a disable must not reorder anything.
    fireEvent.click(screen.getByRole("switch", { name: TIER_SWITCH_LABEL }));
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(fallbackMocks.setMutateAsync.mock.calls[0][0].policy.ladder).toEqual(
      ["profile", "notify"],
    );

    // Back on. This is the moment the row stops being a placeholder, so this
    // is the moment its position has to become honest.
    fireEvent.click(screen.getByRole("switch", { name: TIER_SWITCH_LABEL }));
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(2);
    });

    // Falsification: in `fallback-settings-panel.tsx`'s ladder `onToggle`, drop
    // the `fallbackDisplayOrderEnabling(...)` call and commit
    // `fallbackLadderFrom(state.displayOrder, nextEnabled)` again. The ladder
    // sent becomes `["profile", "notify", "tier"]` - a step after the one that
    // terminates the walk, which can never run, saved with nothing on screen
    // saying so. The hydrate-time rule never gets a chance to repair it,
    // because the local order agreed with every echo along the way.
    expect(fallbackMocks.setMutateAsync.mock.calls[1][0].policy.ladder).toEqual(
      ["profile", "tier", "notify"],
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

describe("FallbackSettingsPanel - R5 a move cannot carry an enabled step across an externally authored early notify", () => {
  const PROFILE_LABEL = "Switch to another profile of the same provider";
  const WAIT_LABEL = "Wait for the limit to reset";
  const TIER_LABEL = "Switch to an equivalent model on another provider";

  it("disables the two arrows that would cross the fixed slot, so no sequence of presses lands a running step below it", async () => {
    // Written elsewhere: `notify` third, with `tier` stored after it. The
    // editor renders that honestly, so the movable list is
    // [profile, wait, tier] with the fixed slot between its second and third
    // entries - the one configuration where a move has a boundary to cross.
    fallbackMocks.queryData = respond(
      policy({ ladder: ["profile", "wait", "notify", "tier"] }),
    );
    fallbackMocks.setMutateAsync.mockImplementation((input) =>
      Promise.resolve({ policy: input.policy }),
    );
    renderPanel();

    // Falsification: drop `|| movableIndex === movableBoundary - 1` from the
    // down arrow in `fallback-ladder-editor.tsx`. This first assertion goes
    // red - and the button it re-enables is the second press of the R5
    // sequence, the one that moves a running step below the terminal one.
    expect(
      screen
        .getByRole("button", { name: `Move ${WAIT_LABEL} down` })
        .hasAttribute("disabled"),
    ).toBe(true);
    // Falsification: drop `|| movableIndex === movableBoundary` from the up
    // arrow. This goes red instead - the mirror case, where pulling `tier` up
    // across the slot pushes the enabled `wait` down across it.
    expect(
      screen
        .getByRole("button", { name: `Move ${TIER_LABEL} up` })
        .hasAttribute("disabled"),
    ).toBe(true);

    // The one legal move on this ladder, and it really does commit - the
    // boundary rule constrains reordering, it does not disable it.
    fireEvent.click(
      screen.getByRole("button", { name: `Move ${PROFILE_LABEL} down` }),
    );
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(fallbackMocks.setMutateAsync.mock.calls[0][0].policy.ladder).toEqual(
      ["wait", "profile", "notify", "tier"],
    );

    // And `profile` cannot be walked any further: it now sits in the last slot
    // above the fixed one, so its own down arrow is disabled too. That is what
    // makes the guarantee a property of the surface rather than of this
    // particular click - there is no second press to reach the bad state with.
    expect(
      screen
        .getByRole("button", { name: `Move ${PROFILE_LABEL} down` })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("leaves every arrow on an ordinary ladder alone, where notify is last", () => {
    // The control that keeps the assertions above from passing for the wrong
    // reason: if the boundary were computed wrongly (say as the movable count
    // minus one) these would be disabled here too, and the panel's ordinary
    // reordering would be dead.
    fallbackMocks.queryData = respond(
      policy({ ladder: ["profile", "tier", "wait", "notify"] }),
    );
    renderPanel();

    expect(
      screen
        .getByRole("button", { name: `Move ${PROFILE_LABEL} down` })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: `Move ${TIER_LABEL} up` })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: `Move ${TIER_LABEL} down` })
        .hasAttribute("disabled"),
    ).toBe(false);
    // Still the genuine ends of the list, for the same reason they always were.
    expect(
      screen
        .getByRole("button", { name: `Move ${PROFILE_LABEL} up` })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: `Move ${WAIT_LABEL} down` })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("FallbackSettingsPanel - R8 a confirmed reset whose read fails is not shown as the reset's result", () => {
  it("keeps the pre-reset editor under a staleness banner instead of remounting it as current, and recovers on Try again", async () => {
    // The policy BEFORE the reset: automation on, an unusual grace window.
    // Both survive in the query cache when the post-reset read fails, which is
    // exactly what makes the stale editor look like a freshly loaded one.
    fallbackMocks.queryData = respond(
      policy({ enabled: true, graceWindowSeconds: 13 }),
    );
    renderPanel();

    // The host CONFIRMS the reset. `queryData` is deliberately left at the
    // pre-reset value: the read that would have replaced it is the one that
    // fails, so the cache still holds what it held before - TanStack's error
    // reducer keeps the previous data.
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ policy: createDefaultFallbackPolicy() }),
    );
    // The post-reset read fails. `isSuccess: false` WITH data present is the
    // production shape, the same one R1 turns on.
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));

    // Falsification: restore `.then(() => { onPolicyReplaced(); })` in
    // `resetAll` (`fallback-settings-panel.tsx`). The mutation resolved, so the
    // editor remounts immediately onto the pre-reset cache - no banner, no
    // notice, and a page showing settings the host no longer has as though
    // they had just been read. This `findByTestId` is what goes red.
    const banner = await screen.findByTestId("fallback-reset-unrefreshed");
    // Re-specified under D330 (sixth pass). This asserted `toContain("out of
    // date")` when written: an inequality claim - a reset of an ALREADY-DEFAULT
    // policy leaves the host holding exactly what is on screen, so "out of
    // date" is a fact about the host that the failed read is precisely what
    // denied us. The banner's subject did not change and neither did this
    // sequence; only the strength of the claim did.
    expect(banner.textContent).toContain(
      "may not be what this host is using now",
    );
    expect(banner.textContent).not.toContain("out of date");
    // The reset is NOT reported as refused anywhere: it demonstrably succeeded.
    expect(screen.queryByTestId("fallback-host-error")).toBeNull();
    // And "Saving…" is not left hanging under the danger zone for a request the
    // host has already answered - the pending save is settled by the same
    // dispatch that raises the banner.
    expect(screen.queryByText("Saving…")).toBeNull();

    // The values are still the pre-reset ones - the banner exists precisely
    // because they are, and saying so is better than silently correcting them
    // from a read that did not happen.
    expect(
      screen
        .getByRole("switch", { name: "Automatic fallback" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    // Recovery: the read succeeds this time and returns what the host actually
    // holds after the reset.
    fallbackMocks.queryData = respond(createDefaultFallbackPolicy());
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: true,
      data: fallbackMocks.queryData,
    });
    // Re-queried rather than reached through the `banner` captured above: the
    // banner has re-rendered since, and a stale handle would be testing this
    // file's bookkeeping instead of what is on screen.
    fireEvent.click(screen.getByTestId("fallback-reset-retry"));

    await waitFor(() => {
      expect(screen.queryByTestId("fallback-reset-unrefreshed")).toBeNull();
    });
    // VALUES, not just the banner: the editor is now seeded from the read, so
    // the default policy's automation-off and 15-second window are what render.
    expect(
      screen
        .getByRole("switch", { name: "Automatic fallback" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    openCombobox("Time to cancel before switching");
    expect(
      screen
        .getByRole("option", { name: "15 seconds" })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen
        .getByRole("option", { name: "13 seconds" })
        .getAttribute("data-state"),
    ).toBe("unchecked");
  });
});

describe("FallbackSettingsPanel - R8 P2 a refusal after an unread reset must not call the pre-reset policy current", () => {
  // Local rather than shared with the R1/R2 block: these two sequences care
  // about which BRANCH of `applySaveFailed` runs, so the error class is part of
  // the fixture and is stated where the fixture is.
  function refusedForTest(message: string): HostRpcError {
    return new HostRpcError({
      code: "RPC_ERROR",
      message,
      requestId: "req-r8p2-refused",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function lostTheReplyForTest(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-r8p2-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  async function resetThenFailTheRead(): Promise<void> {
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ policy: createDefaultFallbackPolicy() }),
    );
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await screen.findByTestId("fallback-reset-unrefreshed");
  }

  it("says the refused edit was not saved and the screen is still pre-reset, never that those settings are in force", async () => {
    fallbackMocks.queryData = respond(
      policy({ enabled: true, graceWindowSeconds: 13 }),
    );
    renderPanel();
    await resetThenFailTheRead();

    // An ordinary edit, refused on the revision it carried - so this reaches
    // the REVERT branch, which restores `persisted`. `reset-unrefreshed`
    // deliberately left that at the PRE-RESET policy, which the host has
    // already discarded.
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(
      refusedForTest("policy is out of date"),
    );
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");

    const notice = await screen.findByTestId("fallback-host-error");

    // Falsification: in `saveNoticeConsequence`, make the `refused-reverted`
    // arm ignore `status.persistedUnverified` and return its "still in force"
    // sentence unconditionally. The page then says the pre-reset settings are
    // "still in force" directly beside a banner saying this host has not been
    // re-read since the reset - two statements about the same values that
    // cannot both be true, and the reducer already knows which one is false.
    //
    // That flag has been renamed twice, so read the CONDITION, not the name:
    // "no write has been confirmed since the reset". It was `staleAfterReset`
    // (computed as `unrefreshedReset !== null`) until the fifth pass, which
    // rejected that question - the banner being up does not make the ROLLBACK
    // pre-reset, and once a write lands after the reset it is not - and it took
    // its present name in the sixth, when `refused-kept` began consulting it
    // too. Nothing about THIS sequence changed under either rename: no write
    // succeeds here, so the rollback really does predate the reset.
    expect(notice.textContent).not.toContain("still in force");
    expect(notice.textContent).toContain("wasn't saved");
    expect(notice.textContent).toContain("before the reset");

    // Both facts are still on screen, and they agree: the reset happened, the
    // read did not, and this edit was refused.
    expect(screen.getByTestId("fallback-reset-unrefreshed")).toBeDefined();
    expect(screen.getByTestId("fallback-reset-retry")).toBeDefined();
    // The revert put the pre-reset timing back, which is what the sentence now
    // describes rather than endorses.
    openCombobox("Time to cancel before switching");
    expect(
      screen
        .getByRole("option", { name: "13 seconds" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });

  it("clears the staleness banner when a later read-back succeeds, because its own sentence has stopped being true", async () => {
    // Cell (3) of the composition table, reachable in exactly one order:
    // reset, failed read, a NEW save goes unknown, its read-back succeeds. The
    // banner says the reset went through and we could not load what is on the
    // host - and this read is that load.
    fallbackMocks.queryData = respond(
      policy({ enabled: true, graceWindowSeconds: 13 }),
    );
    renderPanel();
    await resetThenFailTheRead();

    fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReplyForTest());
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: true,
      data: respond(createDefaultFallbackPolicy()),
    });
    fireEvent.click(screen.getByRole("switch", { name: "Automatic fallback" }));

    // Falsification: remove `unrefreshedReset: null` from the `reconciled`
    // arm's shared object in `fallback-policy-draft.ts`. The read-back lands,
    // the notice clears, and the banner stays up insisting the host's policy
    // could not be loaded - immediately after loading it.
    await waitFor(() => {
      expect(screen.queryByTestId("fallback-reset-unrefreshed")).toBeNull();
    });
    expect(screen.queryByTestId("fallback-host-error")).toBeNull();
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

  it("R4: Undo after the DELETION ITSELF was refused does not add a second copy of the group the revert already restored", async () => {
    fallbackMocks.queryData = respond(
      policy({
        tierGroups: [
          { id: "fast", candidates: [] },
          { id: "cheap", candidates: [] },
        ],
      }),
    );
    // The deletion is refused, so the revert puts "fast" back - and because the
    // list changed SHAPE, `revertKeyedGroups` re-seeds every group's identity.
    // The toast is still up, holding the draft key the deleted group had
    // before that re-seed.
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "groups are locked",
        requestId: "req-r4",
        method: "providers.fallbackPolicy.set",
        fatalDetails: null,
      }),
    );
    renderPanel();

    fireEvent.click(screen.getAllByRole("button", { name: "Delete group" })[0]);
    await screen.findByTestId("fallback-host-error");
    // The revert restored it.
    expect(screen.getByTestId("fallback-tier-group-fast")).toBeDefined();

    // Falsification: drop the `group.id === inverse.group.id` half of the
    // guard in `applyGroupsInverse` (`fallback-tier-group-keys.ts`). The stale
    // `draftKey` no longer matches anything, so the inverse inserts a SECOND
    // "fast": the draft becomes two groups with one name, the commit is
    // refused by local validation, and the user is left with a duplicate row
    // for pressing Undo on a deletion that had already been undone.
    toastSuccess.mock.calls[0][1].action.onClick();

    // Known open case, NOT covered here and tracked as followups row 10: if the
    // user RENAMES the restored group before pressing Undo, neither the stale
    // `draftKey` nor the id matches and the group is inserted again. Closing
    // that needs the inverse to be invalidated when its deletion is rolled
    // back - a generation on the keyed list - which is a new mechanism rather
    // than a guard, and was deliberately not taken in this pass.
    //
    // Nothing to put back, so nothing is sent: the only call is the refused
    // deletion itself.
    await waitFor(() => {
      expect(fallbackMocks.setMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("fallback-local-error")).toBeNull();
    expect(
      screen
        .getAllByTestId(/^fallback-tier-group-/)
        .map((node) => node.getAttribute("data-testid")),
    ).toEqual(["fallback-tier-group-fast", "fallback-tier-group-cheap"]);
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
      isSuccess: true,
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
    //
    // In the production shape: the refetch FAILED, and TanStack handed back the
    // policy the editor already had. `data` is present and stale; only
    // `isSuccess` says it must not be believed.
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
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
      isSuccess: true,
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
      fallbackMocks.refetchMock.mockResolvedValueOnce({
        isSuccess: false,
        data: fallbackMocks.queryData,
      });
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

describe("FallbackSettingsPanel - cold review R1/R2: a failed read-back, and a write nothing has settled", () => {
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function refusedByHost(message: string): HostRpcError {
    return new HostRpcError({
      code: "RPC_ERROR",
      message,
      requestId: "req-refused",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  /**
   * A promise this test settles by hand, so two saves can genuinely overlap.
   *
   * The R2 sequences are ORDERING bugs: they need A still unanswered while B is
   * answered. `mockRejectedValueOnce` cannot express that - it settles on the
   * microtask after the call - so the order the reducer sees would be fixed by
   * the mock rather than by the test.
   */
  function deferred(): {
    readonly promise: Promise<ProvidersFallbackPolicySetResponse>;
    resolveWith: (value: FallbackPolicy) => void;
    rejectWith: (error: Error) => void;
  } {
    let resolveWith = (_value: FallbackPolicy): void => {};
    let rejectWith = (_error: Error): void => {};
    const promise = new Promise<ProvidersFallbackPolicySetResponse>(
      (resolve, reject) => {
        resolveWith = (value) => resolve({ policy: value });
        rejectWith = reject;
      },
    );
    // Nothing awaits this promise until the panel does, and a rejection that
    // lands first would otherwise be an unhandled rejection before the panel's
    // own `.catch` is attached.
    promise.catch(() => {});
    return { promise, resolveWith, rejectWith };
  }

  function automaticFallback(): HTMLElement {
    return screen.getByRole("switch", { name: "Automatic fallback" });
  }

  it("R1: a read-back that FAILS keeps the editor, the draft and Check again - and never adopts the stale cached policy as the host's answer", async () => {
    // Stored: automation ON. The user turns it OFF, and the reply is lost, so
    // whether the host has it off is exactly the open question.
    fallbackMocks.queryData = respond(policy({ enabled: true }));
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReply());
    // The read-back fails. This is the PRODUCTION failure shape and the reason
    // R1 exists: TanStack types `QueryObserverRefetchErrorResult.data` as
    // present and its error reducer keeps the previous value, so what comes
    // back is the policy from BEFORE the save - automation ON - with only
    // `isSuccess: false` marking it unusable.
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    fireEvent.click(automaticFallback());

    const notice = await screen.findByTestId("fallback-host-error");

    // Falsification 1: restore `return result.data?.policy ?? null` in
    // `refetchPolicy` (`fallback-settings-panel.tsx`). The stale cached policy
    // is then dispatched as `reconciled`, which clears the notice and snaps the
    // switch back to ON - the read-back "answering" with a value that predates
    // the save it was sent to check. Both assertions below go red.
    expect(notice.textContent).toContain("may or may not have been saved");
    expect(within(notice).getByTestId("fallback-check-again")).toBeDefined();
    expect(automaticFallback().getAttribute("aria-checked")).toBe("false");

    // The other half of a failed refetch: TanStack marks the query errored and
    // notifies, so the panel BODY re-renders. Driven explicitly because the
    // double has no observer of its own - and without this the body never
    // re-runs, which would make the next assertion vacuous.
    act(() => {
      fallbackMocks.setQueryIsError(true);
    });

    // Falsification 2: restore the unconditional `if (query.isError)` return in
    // `FallbackSettingsPanelBody`, ahead of the `query.data === undefined`
    // check. The whole editor is replaced by the load-error view, taking the
    // draft, the notice and the only Check again button with it - so all three
    // of these go red at once.
    expect(screen.queryByText(/Couldn't load fallback settings/)).toBeNull();
    expect(automaticFallback().getAttribute("aria-checked")).toBe("false");
    expect(
      within(screen.getByTestId("fallback-host-error")).getByTestId(
        "fallback-check-again",
      ),
    ).toBeDefined();

    // And the recovery the notice promises actually works: the host answers
    // this time, and it says the save DID land.
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: true,
      data: respond(policy({ enabled: false })),
    });
    act(() => {
      fallbackMocks.setQueryIsError(false);
    });
    fireEvent.click(
      within(screen.getByTestId("fallback-host-error")).getByTestId(
        "fallback-check-again",
      ),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("fallback-host-error")).toBeNull();
    });
    expect(automaticFallback().getAttribute("aria-checked")).toBe("false");
  });

  it("R2a: a later save's refusal does not tear up an earlier save's unknown-outcome ticket, and the read-back still corrects the page", async () => {
    // Stored: automation OFF.
    fallbackMocks.queryData = respond(policy({ enabled: false }));
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    // A's read-back is held open until after B has been refused, which is the
    // ordering the bug needs: the ticket must survive B to still be there when
    // this answers.
    let answerReadBack = (): void => {};
    fallbackMocks.refetchMock.mockImplementationOnce(
      () =>
        new Promise<FallbackRefetchResult>((resolve) => {
          answerReadBack = () =>
            resolve({
              isSuccess: true,
              // The host DID commit A.
              data: respond(policy({ enabled: true })),
            });
        }),
    );
    renderPanel();

    // Save A: turn automation ON. Its reply is lost.
    fireEvent.click(automaticFallback());
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();
    expect(
      (await screen.findByTestId("fallback-host-error")).textContent,
    ).toContain("may or may not have been saved");

    // Save B: a different control, refused by the host while A is still open.
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");
    saveB.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();

    // B was refused, and that is reported - but B says nothing about A, so the
    // page must not claim the pre-A policy is in force, and must keep offering
    // the read-back that can settle it.
    const afterB = await screen.findByTestId("fallback-host-error");
    expect(afterB.textContent).not.toContain("still in force");
    expect(within(afterB).getByTestId("fallback-check-again")).toBeDefined();

    // Now A's read-back answers: the host has automation ON.
    answerReadBack();
    await flushHostReplies();

    // Falsification: restore `unknownSave: null` to the `save-started` arm of
    // `fallbackPolicyDraftReducer`. B's start then tears up A's ticket, so this
    // `reconciled` is dropped for naming a superseded episode, and the switch
    // stays OFF while the host has it ON - with the notice claiming the old
    // value is still in force.
    await waitFor(() => {
      expect(automaticFallback().getAttribute("aria-checked")).toBe("true");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("fallback-host-error")).toBeNull();
    });

    // And B's REFUSED value is gone from the page too, which the earlier
    // version of this test never looked at. The read-back is authoritative
    // about the whole row, not just the control A touched, so adopting it has
    // to put the timing back to the host's 15 seconds. Leaving 11 on screen
    // under no notice at all would present a value the host rejected as saved -
    // the same lie as the switch, one control over.
    openCombobox("Time to cancel before switching");
    expect(
      screen
        .getByRole("option", { name: "15 seconds" })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen
        .getByRole("option", { name: "11 seconds" })
        .getAttribute("data-state"),
    ).toBe("unchecked");
  });

  it("R2c: a read-back adopts the host's value even when the SAME control was refused in between, rather than settling on the rejected one", async () => {
    // The R2a sequence with one thing changed: A and B are the same switch. The
    // variant matters because `reconciled` decides between "adopt the host's
    // row" and "leave the draft, the user has moved on" - and after a refusal
    // the draft is not something the user moved on to, it is a value the host
    // said no to. With two different controls the difference is invisible on
    // the one control the test looked at; with one control it IS the assertion.
    fallbackMocks.queryData = respond(policy({ enabled: false }));
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    let answerReadBack = (): void => {};
    fallbackMocks.refetchMock.mockImplementationOnce(
      () =>
        new Promise<FallbackRefetchResult>((resolve) => {
          answerReadBack = () =>
            resolve({
              isSuccess: true,
              // The host committed A: automation really is ON.
              data: respond(policy({ enabled: true })),
            });
        }),
    );
    renderPanel();

    // A: ON, reply lost.
    fireEvent.click(automaticFallback());
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();
    expect(
      (await screen.findByTestId("fallback-host-error")).textContent,
    ).toContain("may or may not have been saved");

    // B: the same switch back OFF, definitively refused. The draft is left at
    // OFF - correctly, since reverting to a `persisted` that A may already have
    // superseded would claim something nothing has established.
    fireEvent.click(automaticFallback());
    saveB.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();
    expect(automaticFallback().getAttribute("aria-checked")).toBe("false");

    answerReadBack();
    await flushHostReplies();

    // Falsification: in `fallbackPolicyDraftReducer`'s `reconciled` arm, change
    // the guard `state.revision !== state.unknownSave.revision &&
    // !draftIsRefused(state)` to drop the `draftIsRefused` half. B's edit moved
    // the revision, so the arm takes the "the user has moved on" path, keeps
    // the OFF draft and clears the notice - leaving the switch showing the
    // value the host REFUSED, with nothing on screen saying so, while the read
    // it just performed said ON. Both assertions below go red.
    await waitFor(() => {
      expect(automaticFallback().getAttribute("aria-checked")).toBe("true");
    });
    expect(screen.queryByTestId("fallback-host-error")).toBeNull();
  });

  it("R2d: an older save's refusal does not relabel a NEWER unjudged draft as refused, so the read-back leaves it in the field", async () => {
    // The composition the earlier R2 pins never reach: they stop editing before
    // B is refused, so `refusedDraft` is only ever written over a draft the
    // refused request actually carried. Here the user types WHILE B is in
    // flight, which moves the revision without sending anything (`editDraft`),
    // and B's refusal then arrives against a draft it has never seen.
    fallbackMocks.queryData = respond(
      policy({
        enabled: false,
        graceWindowSeconds: 15,
        tierGroups: [
          {
            id: "fast",
            candidates: [
              {
                harnessId: "claude",
                modelFamily: "sonnet",
                reasoningEffort: null,
              },
            ],
          },
        ],
      }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    let answerReadBack = (): void => {};
    fallbackMocks.refetchMock.mockImplementationOnce(
      () =>
        new Promise<FallbackRefetchResult>((resolve) => {
          answerReadBack = () =>
            resolve({
              isSuccess: true,
              // The host committed A. Its `tierGroups` are the STORED ones -
              // "sonnet", never "opus" - which is what makes the adopt visible.
              data: respond(
                policy({
                  enabled: true,
                  graceWindowSeconds: 15,
                  tierGroups: [
                    {
                      id: "fast",
                      candidates: [
                        {
                          harnessId: "claude",
                          modelFamily: "sonnet",
                          reasoningEffort: null,
                        },
                      ],
                    },
                  ],
                }),
              ),
            });
        }),
    );
    renderPanel();

    // A (revision 1): automation ON, reply lost.
    fireEvent.click(automaticFallback());
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();
    expect(
      (await screen.findByTestId("fallback-host-error")).textContent,
    ).toContain("may or may not have been saved");

    // B (revision 2): a timing change, still in flight.
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");

    // C: typed into the family field and NOT committed - no blur, no Enter.
    //
    // Measured against the count taken a line earlier rather than against a
    // literal. A literal 2 here was asserting the FIXTURE's bookkeeping - how
    // many requests the two controls above happen to produce - and it was
    // wrong: driving the grace-window combobox costs two saves, not one, which
    // no existing test had ever had reason to notice. The property this pin
    // needs is only that TYPING sends nothing, and that is what this now says.
    // NOT focused, deliberately, and this is the second thing the fixture got
    // wrong. `commitOnLeave` commits the candidate on BLUR (D181), and Radix
    // restores focus to the Select's trigger asynchronously after
    // `chooseOption` - so focusing the input here handed it a blur on the next
    // flush and committed "opus" as a third save. That is the blur rule working
    // exactly as specified; the fixture was driving two controls in an order
    // that invokes it. Not focusing costs this pin nothing: what it needs is
    // that `edited` moved the revision without sending, which `change` alone
    // produces - the focus was only ever flavour.
    const savesBeforeTyping = fallbackMocks.setMutateAsync.mock.calls.length;
    const familyInput = screen.getByLabelText<HTMLInputElement>("Model family");
    fireEvent.change(familyInput, { target: { value: "opus" } });
    expect(fallbackMocks.setMutateAsync.mock.calls.length).toBe(
      savesBeforeTyping,
    );

    // B is refused. It carried revision 2 and has never contained "opus".
    saveB.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();
    expect(screen.getByLabelText<HTMLInputElement>("Model family").value).toBe(
      "opus",
    );

    // A's read-back answers. It is authoritative about the host's row, and it
    // may adopt over a draft this reducer put back - but C is not that.
    answerReadBack();
    await flushHostReplies();

    // Gated on the notice clearing, which BOTH `reconciled` paths do - so this
    // synchronises on the read-back having been applied without presuming which
    // path applied it, and the assertion that follows is the one that separates
    // them. Gating on the switch would have been satisfied before the read-back
    // even arrived (A had already turned it on), making it a vacuous wait.
    await waitFor(() => {
      expect(screen.queryByTestId("fallback-host-error")).toBeNull();
    });

    // Falsification: restore the flat `refusedDraft: { revision: state.revision, … }` in
    // `applySaveFailed`'s outstanding-ticket branch. B's refusal then marks
    // revision 3 - C - as refused, so `draftIsRefused` is true here and
    // `reconciled` takes its adopt path, overwriting the whole view with the
    // host's policy and replacing "opus" with the stored "sonnet" while the
    // cursor is still in the field. The switch reads `true` either way, which
    // is exactly why it cannot be the assertion.
    expect(screen.getByLabelText<HTMLInputElement>("Model family").value).toBe(
      "opus",
    );
    expect(automaticFallback().getAttribute("aria-checked")).toBe("true");
    // ...and it was never sent. Stated as a property of every request this
    // panel made, not as a count: "opus" reached no policy on the wire, so it
    // is still the user's uncommitted edit for its own blur/Enter to carry.
    const sentFamilies = fallbackMocks.setMutateAsync.mock.calls.flatMap(
      (call) =>
        call[0].policy.tierGroups.flatMap((group) =>
          group.candidates.map((candidate) => candidate.modelFamily),
        ),
    );
    expect(sentFamilies).not.toContain("opus");
    expect(fallbackMocks.setMutateAsync.mock.calls.length).toBe(
      savesBeforeTyping,
    );
  });

  it("R2b: a refusal's rollback is corrected by an older save that then succeeds, rather than standing as 'still in force'", async () => {
    // No transport loss anywhere in this one - two ordinary overlapping saves,
    // answered out of order.
    fallbackMocks.queryData = respond(policy({ enabled: false }));
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    renderPanel();

    // A turns automation ON; B changes a timing. Both are in flight.
    fireEvent.click(automaticFallback());
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");

    // B is refused FIRST, and reverts the page to the last value this editor
    // had confirmed - automation OFF - saying it is in force.
    saveB.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();
    const afterB = await screen.findByTestId("fallback-host-error");
    expect(afterB.textContent).toContain("still in force");
    expect(automaticFallback().getAttribute("aria-checked")).toBe("false");

    // Then A's reply arrives, and it SUCCEEDED: the stored policy is A's, so
    // the rollback above is showing a value the host does not have.
    saveA.resolveWith(policy({ enabled: true }));
    await flushHostReplies();

    // Falsification: delete the `draftIsRefused` branch from
    // `applySaveSucceeded` (`fallback-policy-draft.ts`), leaving the plain
    // `return { ...state, ...persisted, pendingSaves, unknownSave }`. The
    // reducer then knows `persisted` is A's policy while the controls keep
    // showing the rollback - the switch stays OFF under a notice still saying
    // those settings are in force, which is the state this test forbids.
    await waitFor(() => {
      expect(automaticFallback().getAttribute("aria-checked")).toBe("true");
    });
    // The refusal is still reported - B really was refused - and its sentence
    // is true again now that the control shows what is actually stored.
    const settled = screen.getByTestId("fallback-host-error");
    expect(settled.textContent).toContain("policy is out of date");
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

describe("FallbackSettingsPanel - R9/R10 what the page SAYS when two obligations are open at once", () => {
  // The rendered half of the composition table. The reducer cases live in
  // `fallback-policy-draft.test.ts`; these four are here because the defect is
  // in the sentence or the affordance, which only the panel produces.
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-r9r10-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function refusedByHost(message: string): HostRpcError {
    return new HostRpcError({
      code: "RPC_ERROR",
      message,
      requestId: "req-r9r10-refused",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  /** As in the R1/R2 block: two saves cannot genuinely overlap without one. */
  function deferred(): {
    readonly promise: Promise<ProvidersFallbackPolicySetResponse>;
    resolveWith: (value: FallbackPolicy) => void;
    rejectWith: (error: Error) => void;
  } {
    let resolveWith = (_value: FallbackPolicy): void => {};
    let rejectWith = (_error: Error): void => {};
    const promise = new Promise<ProvidersFallbackPolicySetResponse>(
      (resolve, reject) => {
        resolveWith = (value) => resolve({ policy: value });
        rejectWith = reject;
      },
    );
    promise.catch(() => {});
    return { promise, resolveWith, rejectWith };
  }

  function automaticFallback(): HTMLElement {
    return screen.getByRole("switch", { name: "Automatic fallback" });
  }

  /**
   * The one stored model row these sequences type into.
   *
   * A function rather than a shared constant, and annotated rather than
   * inferred: `harnessId` is a registry-derived union that a standalone
   * literal widens to `string`, and a shared array would be handed to two
   * policies at once by reference. The inline groups elsewhere in this file
   * are contextually typed by `policy({...})` and hit neither.
   */
  function storedGroups(): TierGroup[] {
    return [
      {
        id: "fast",
        candidates: [
          { harnessId: "claude", modelFamily: "sonnet", reasoningEffort: null },
        ],
      },
    ];
  }

  it("R9: a later save that succeeds takes the uncertainty notice AND its 'Check again' off the page with the ticket", async () => {
    fallbackMocks.queryData = respond(
      policy({
        enabled: false,
        graceWindowSeconds: 15,
        tierGroups: storedGroups(),
      }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    // The read-back A triggers must FAIL, or it settles the ticket itself and
    // there is nothing left for B's success to discharge.
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    // A (revision 1) and B (revision 2) are both in flight.
    fireEvent.click(automaticFallback());
    fireEvent.click(automaticFallback());
    // C is typed and left uncommitted, which moves the revision past B without
    // sending anything - the only way B's echo can land on the MOVED-ON path
    // with a notice still up, since `edited` clears the notice itself.
    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Model family"), {
      target: { value: "opus" },
    });

    // A's reply is lost. The ticket opens and brings the only retry with it.
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();
    expect(
      (await screen.findByTestId("fallback-host-error")).textContent,
    ).toContain("may or may not have been saved");
    expect(screen.getByTestId("fallback-check-again")).toBeDefined();

    // B was dispatched after A and the host confirmed it: the row is now B's,
    // whatever A did, so the sentence "may or may not have been saved" has
    // stopped being true and the button behind it answers nothing.
    saveB.resolveWith(
      policy({
        enabled: false,
        graceWindowSeconds: 15,
        tierGroups: storedGroups(),
      }),
    );
    await flushHostReplies();

    // Falsification: restore the bare
    // `return { ...state, ...persisted, pendingSaves, unknownSave };` on the
    // ordinary moved-on path of `applySaveSucceeded`. The ticket clears and
    // both of these stay on screen - a false claim, and a Check again that
    // re-reads for a request no longer outstanding and returns having settled
    // nothing.
    await waitFor(() => {
      expect(screen.queryByTestId("fallback-host-error")).toBeNull();
    });
    expect(screen.queryByTestId("fallback-check-again")).toBeNull();
    // C was never the subject of any of it and is still in the field.
    expect(screen.getByLabelText<HTMLInputElement>("Model family").value).toBe(
      "opus",
    );
  });

  it("R10: a refusal of an older draft says a later change WAS saved, rather than that nothing has been", async () => {
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    renderPanel();

    // A (revision 1) then B (revision 2), both in flight.
    fireEvent.click(automaticFallback());
    fireEvent.click(automaticFallback());
    // B answers first and is CONFIRMED, on the revision still on screen.
    const bPolicy = policy({ enabled: false, graceWindowSeconds: 15 });
    saveB.resolveWith(bPolicy);
    await flushHostReplies();
    // A is then refused. It judged an older draft, so nothing reverts - but
    // what is on screen is not "unsaved", it is the value the host just stored.
    saveA.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: drop the `draftConfirmed` arm and return the unconditional
    // "The changes you have made since are still on screen and haven't been
    // saved yet." from `saveNoticeConsequence`'s `refused-kept` case. The page
    // then tells the user their current settings are unsaved immediately after
    // the host confirmed exactly them, which is the reverse of the truth and
    // invites them to re-save a value that is already in force.
    //
    // The FIFTH pass re-specified this assertion. It used to read:
    //
    //     expect(notice.textContent).toContain("A later change was saved");
    //
    // and that wording is wrong on the sibling sequence: a correcting rollback
    // adopts an EARLIER request's policy while a NEWER one is what got refused,
    // so "a later change was saved" is false exactly half the time. The claim
    // this sentence is entitled to make is about the VALUES on screen, not
    // about which request came first, and that is what it now says.
    expect(notice.textContent).toContain("is in force");
    expect(notice.textContent).not.toContain("haven't been saved yet");
    expect(notice.textContent).toContain("policy is out of date");
  });

  it("R10: a failure that judged an older draft keeps the newer draft's validation error - and no longer hides the ticket behind it", async () => {
    fallbackMocks.queryData = respond(
      policy({
        enabled: false,
        graceWindowSeconds: 15,
        tierGroups: storedGroups(),
      }),
    );
    const saveA = deferred();
    fallbackMocks.setMutateAsync.mockImplementationOnce(() => saveA.promise);
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    // A (revision 1) goes out, then the user empties the family field: an
    // INVALID draft, kept on screen with its error, and sent nowhere.
    fireEvent.click(automaticFallback());
    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Model family"), {
      target: { value: "" },
    });
    expect(
      (await screen.findByTestId("fallback-local-error")).textContent,
    ).toContain("A model needs a family name.");

    // A's reply is lost. It carried revision 1 and has never seen the empty
    // family field, so it has judged nothing the user is looking at.
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();

    // Falsification (reducer): restore the unconditional `localError: null` in
    // `applySaveFailed`'s `unknown` branch. The invalid draft stays in the
    // field with nothing beside it and reads as accepted.
    expect(
      (await screen.findByTestId("fallback-local-error")).textContent,
    ).toContain("A model needs a family name.");
    expect(screen.getByLabelText<HTMLInputElement>("Model family").value).toBe(
      "",
    );
    // Falsification (panel): restore the early
    // `if (localError !== null) return <p .../>` in `FallbackSaveStatus`. The
    // preserved validation error then masks the notice AND the only Check
    // again, while the ticket it belongs to stays open - the R9 defect from
    // the other side, and the reason preserving `localError` had to be paired
    // with this render change rather than shipped alone.
    const hostAlert = screen.getByTestId("fallback-host-error");
    expect(hostAlert.textContent).toContain("may or may not have been saved");
    expect(screen.getByTestId("fallback-check-again")).toBeDefined();
    // R10 (fifth pass): WHICH draft that uncertainty is about. The unanswered
    // request was A; what is on screen is the never-sent, invalid C. The
    // sentence used to open "What's on screen is your change, not a confirmed
    // setting", attaching A's uncertainty to an edit A never carried - and this
    // is the cell where that is most misleading, because the other alert
    // directly above says C was not sent at all.
    //
    // Falsification: make `saveNoticeConsequence`'s `unknown` arm return its
    // first branch unconditionally.
    expect(hostAlert.textContent).toContain("hasn't been sent");
    expect(hostAlert.textContent).not.toContain(
      "What's on screen is your change",
    );
  });

  it("R8: once the user has typed since an unread reset, the banner stops calling what is on screen the pre-reset settings", async () => {
    fallbackMocks.queryData = respond(
      policy({ enabled: true, graceWindowSeconds: 13 }),
    );
    // Both read-backs fail: the reset's, which raises the banner, and the one
    // the unknown save triggers - a successful second read would discharge the
    // banner outright and there would be no sentence left to check.
    fallbackMocks.refetchMock
      .mockResolvedValueOnce({
        isSuccess: false,
        data: fallbackMocks.queryData,
      })
      .mockResolvedValueOnce({
        isSuccess: false,
        data: fallbackMocks.queryData,
      });
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ policy: createDefaultFallbackPolicy() }),
    );
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    const banner = await screen.findByTestId("fallback-reset-unrefreshed");
    // While nothing has been typed, the strong sentence is true and is said.
    expect(banner.textContent).toContain("the ones you had before the reset");

    // Now the user changes something and its reply is lost. What is on screen
    // is their own edit, which that write may well have stored.
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReply());
    fireEvent.click(automaticFallback());

    await waitFor(() => {
      expect(
        screen.getByTestId("fallback-reset-unrefreshed").textContent,
      ).toContain("what's below is your own edit");
    });
    // Falsification: pass `showingPreResetValues` a literal `true` at the
    // render site (or drop the prop and keep only the first sentence). The
    // banner then calls the user's own unsaved edit "the ones you had before
    // the reset", asserting known staleness about values whose status is
    // exactly what nobody knows.
    const after = screen.getByTestId("fallback-reset-unrefreshed");
    expect(after.textContent).not.toContain(
      "the ones you had before the reset",
    );
    // What stays true either way, and is still said.
    expect(after.textContent).toContain("has not been read yet");
    expect(screen.getByTestId("fallback-reset-retry")).toBeDefined();
  });
});

describe("FallbackSettingsPanel - R8/R10 fifth pass: the page's claims match the values behind them", () => {
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-p5-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function refusedByHost(message: string): HostRpcError {
    return new HostRpcError({
      code: "RPC_ERROR",
      message,
      requestId: "req-p5-refused",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function deferred(): {
    readonly promise: Promise<ProvidersFallbackPolicySetResponse>;
    resolveWith: (value: FallbackPolicy) => void;
    rejectWith: (error: Error) => void;
  } {
    let resolveWith = (_value: FallbackPolicy): void => {};
    let rejectWith = (_error: Error): void => {};
    const promise = new Promise<ProvidersFallbackPolicySetResponse>(
      (resolve, reject) => {
        resolveWith = (value) => resolve({ policy: value });
        rejectWith = reject;
      },
    );
    promise.catch(() => {});
    return { promise, resolveWith, rejectWith };
  }

  function automaticFallback(): HTMLElement {
    return screen.getByRole("switch", { name: "Automatic fallback" });
  }

  function storedGroups(): TierGroup[] {
    return [
      {
        id: "fast",
        candidates: [
          { harnessId: "claude", modelFamily: "sonnet", reasoningEffort: null },
        ],
      },
    ];
  }

  it("R8: a save submitted while the reset's read is still running is not called 'the settings from before the reset'", async () => {
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 13 }),
    );
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ policy: createDefaultFallbackPolicy() }),
    );
    // The reset's read-back is HELD, which is the whole point: it is a round
    // trip, and this panel disables only Reset and Restore while it runs.
    let failTheResetRead = (): void => {};
    fallbackMocks.refetchMock.mockImplementationOnce(
      () =>
        new Promise<FallbackRefetchResult>((resolve) => {
          failTheResetRead = () =>
            resolve({ isSuccess: false, data: fallbackMocks.queryData });
        }),
    );
    // ...and the read-back B's own failure will trigger, which must also fail
    // or it would settle everything and clear the banner.
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    // Flush so the reset mutation settles and `refreshAfterReset` actually
    // CALLS the refetch. Without this the read is not yet in flight: the hold's
    // resolver is assigned inside the mock's promise executor, which does not
    // run until the mock is invoked, so `failTheResetRead` was still its no-op
    // initializer and the held promise never resolved. `resetAll` reaches the
    // refetch through `mutateAsync({}).then(...)`, a microtask later than the
    // click that appears to cause it.
    await flushHostReplies();

    // B goes out INSIDE the read window, through a control that stayed live.
    const saveB = deferred();
    fallbackMocks.setMutateAsync.mockImplementationOnce(() => saveB.promise);
    fireEvent.click(automaticFallback());

    // Only now does the reset's read fail and raise the banner.
    failTheResetRead();
    await flushHostReplies();
    const banner = await screen.findByTestId("fallback-reset-unrefreshed");

    // Falsification: restore `revision: state.revision` in the
    // `reset-unrefreshed` arm. The captured revision is B's, the comparison in
    // `showingPreResetValues` comes out true, and the banner tells the user
    // that B - submitted after the reset, and at this moment still in flight -
    // is the policy they had BEFORE it.
    expect(banner.textContent).not.toContain(
      "the ones you had before the reset",
    );
    expect(banner.textContent).toContain("your own edit");
    // The banner is still up and still says the true thing.
    expect(banner.textContent).toContain("has not been read yet");

    // And it stays right once B's own reply is lost.
    saveB.rejectWith(lostTheReply());
    await flushHostReplies();
    expect(
      screen.getByTestId("fallback-reset-unrefreshed").textContent,
    ).not.toContain("the ones you had before the reset");
  });

  it("R8: a refusal that rolls back to a policy confirmed AFTER the reset says it is in force, not that it predates the reset", async () => {
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 13 }),
    );
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ policy: createDefaultFallbackPolicy() }),
    );
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    const saveB = deferred();
    const saveC = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveB.promise)
      .mockImplementationOnce(() => saveC.promise);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await screen.findByTestId("fallback-reset-unrefreshed");

    // B and C both go out AFTER the reset. B succeeds while C is on screen, so
    // it takes the ordinary moved-on branch and deliberately leaves the banner
    // up - the screen is showing C, not the host's row.
    fireEvent.click(automaticFallback());
    fireEvent.click(automaticFallback());
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 13 });
    saveB.resolveWith(bPolicy);
    await flushHostReplies();
    // C is then refused on its own revision, so the revert puts B back.
    saveC.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: compute `persistedUnverified` as `unrefreshedReset !==
    // null`, dropping the `lastConfirmedRequestId > unrefreshedReset.requestId`
    // half. The page then tells the user that B - which the host confirmed
    // AFTER the reset and is actively using - is "still the settings from
    // before the reset, which may no longer be what this host is using", which
    // is false about the only value on screen: this host's use of B is exactly
    // what was confirmed.
    expect(notice.textContent).toContain(
      "Your last saved settings are back on screen and still in force.",
    );
    expect(notice.textContent).not.toContain("before the reset");
    // The banner is still up, because the reset's own result was never read -
    // that has not stopped being true, and it is a different statement.
    expect(screen.getByTestId("fallback-reset-unrefreshed")).toBeDefined();
    expect(automaticFallback().getAttribute("aria-checked")).toBe("true");
  });

  it("R10: an unsent draft is not called in force just because a read-back stamped the revision", async () => {
    fallbackMocks.queryData = respond(
      policy({
        enabled: false,
        graceWindowSeconds: 15,
        tierGroups: storedGroups(),
      }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    // A's read-back SUCCEEDS and returns the host's row, which holds `sonnet`.
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: true,
      data: respond(
        policy({
          enabled: true,
          graceWindowSeconds: 15,
          tierGroups: storedGroups(),
        }),
      ),
    });
    renderPanel();

    fireEvent.click(automaticFallback());
    fireEvent.click(automaticFallback());
    // C is typed into the family field and never committed.
    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Model family"), {
      target: { value: "opus" },
    });
    // A's reply is lost, and its read-back lands - keeping C, and stamping
    // `persistedRevision` with the revision C is sitting at.
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();
    await waitFor(() => {
      expect(screen.queryByTestId("fallback-host-error")).toBeNull();
    });
    // Only now is B refused, so the notice is `refused-kept` and the two
    // revisions compare equal.
    saveB.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: restore `draftConfirmed: revision === persistedRevision`.
    // The page then says "what's on screen is in force" about `opus`, which has
    // never left the browser, while the policy the host actually confirmed
    // holds `sonnet`.
    expect(notice.textContent).toContain("haven't been saved yet");
    expect(notice.textContent).not.toContain("is in force");
    expect(screen.getByLabelText<HTMLInputElement>("Model family").value).toBe(
      "opus",
    );
  });

  it("D327: once a refusal rolls the display back, the banner drops its provenance clause and says only that the reset is unread", async () => {
    // Both states in ONE sequence, so the TRANSITION is what is pinned rather
    // than two independently-arranged fixtures that could drift apart.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 13 }),
    );
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ policy: createDefaultFallbackPolicy() }),
    );
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    const saveC = deferred();
    fallbackMocks.setMutateAsync.mockImplementationOnce(() => saveC.promise);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await screen.findByTestId("fallback-reset-unrefreshed");

    // POSITIVE CONTROL, and it is the same banner a moment earlier: the user
    // has committed an edit and it is still in flight, so what is on screen IS
    // their own live edit and the banner is entitled to say so.
    fireEvent.click(automaticFallback());
    const live = screen.getByTestId("fallback-reset-unrefreshed");
    expect(live.textContent).toContain("what's below is your own edit");
    expect(live.textContent).toContain("has not been read yet");

    // The host refuses it on its own revision, so the revert puts the
    // pre-reset `persisted` back. What is on screen is now neither the user's
    // edit nor something the banner should be describing at all.
    saveC.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();
    await screen.findByTestId("fallback-host-error");

    const rolledBack = screen.getByTestId("fallback-reset-unrefreshed");
    // Falsification: drop the `draftIsRefused(state)` arm from the
    // `displaySubject` expression, leaving the two-way form. The banner then
    // calls the rollback "your own edit" while the notice immediately below it
    // calls the same values "still the settings from before the reset" - two
    // alerts contradicting each other about one set of values, which is what
    // D327 removed by giving provenance to the notice alone.
    expect(rolledBack.textContent).not.toContain("your own edit");
    expect(rolledBack.textContent).not.toContain("before the reset");
    // The banner keeps its own subject, and only that.
    expect(rolledBack.textContent).toContain(
      "What the reset left on this host has not been read yet.",
    );
    // The notice is where the provenance now lives, and it still says it.
    expect(screen.getByTestId("fallback-host-error").textContent).toContain(
      "before the reset",
    );
  });

  it("R10: a confirmed policy adopted by a correcting rollback IS called in force, though the revisions differ", async () => {
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveA = deferred();
    const saveB = deferred();
    const saveC = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise)
      .mockImplementationOnce(() => saveC.promise);
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    fireEvent.click(automaticFallback());
    fireEvent.click(automaticFallback());
    // A's reply is lost; its read-back fails, so the ticket stays open.
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();
    await screen.findByTestId("fallback-check-again");
    // C is committed and refused WHILE that ticket is open, so it is kept on
    // screen and marked refused rather than reverted.
    fireEvent.click(automaticFallback());
    saveC.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();
    // B - the EARLIER request - then succeeds, proving the marked rollback
    // stale, and the correcting branch adopts B into the controls.
    const bPolicy = policy({ enabled: false, graceWindowSeconds: 15 });
    saveB.resolveWith(bPolicy);
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: restore `draftConfirmed: revision === persistedRevision`.
    // `revision` is still C's and `persistedRevision` is B's, so the page tells
    // the user the settings in front of them "haven't been saved yet" - about a
    // policy the host confirmed and this reducer itself put on screen.
    expect(notice.textContent).toContain("is in force");
    expect(notice.textContent).not.toContain("haven't been saved yet");
    // ...and the sentence does not claim the saved request was the later one,
    // because here it was the earlier one.
    expect(notice.textContent).not.toContain("A later change was saved");
  });
});

describe("FallbackSettingsPanel - sixth pass: no sentence asserts host knowledge the page lacks (D330)", () => {
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-p6-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function refusedByHost(message: string): HostRpcError {
    return new HostRpcError({
      code: "RPC_ERROR",
      message,
      requestId: "req-p6-refused",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function deferred(): {
    readonly promise: Promise<ProvidersFallbackPolicySetResponse>;
    resolveWith: (value: FallbackPolicy) => void;
    rejectWith: (error: Error) => void;
  } {
    let resolveWith = (_value: FallbackPolicy): void => {};
    let rejectWith = (_error: Error): void => {};
    const promise = new Promise<ProvidersFallbackPolicySetResponse>(
      (resolve, reject) => {
        resolveWith = (value) => resolve({ policy: value });
        rejectWith = reject;
      },
    );
    promise.catch(() => {});
    return { promise, resolveWith, rejectWith };
  }

  function automaticFallback(): HTMLElement {
    return screen.getByRole("switch", { name: "Automatic fallback" });
  }

  /** Reset confirmed, its follow-up read lost. Leaves `persisted` UNVERIFIED. */
  async function resetWithLostRead(): Promise<void> {
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ policy: createDefaultFallbackPolicy() }),
    );
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await screen.findByTestId("fallback-reset-unrefreshed");
  }

  it("R10-A: two refusals with no post-reset success never call the restored pre-reset policy 'in force'", async () => {
    // The cell the post-reset-success pin cannot reach: it contains a success
    // establishing B, and this sequence has TWO refusals and no success at all.
    fallbackMocks.queryData = respond(
      policy({ enabled: true, graceWindowSeconds: 13 }),
    );
    renderPanel();
    await resetWithLostRead();

    const saveB = deferred();
    const saveC = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveB.promise)
      .mockImplementationOnce(() => saveC.promise);
    fireEvent.click(automaticFallback());
    fireEvent.click(automaticFallback());

    // C is refused first, on its own revision: the revert restores P.
    saveC.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();
    const reverted = await screen.findByTestId("fallback-host-error");
    expect(reverted.textContent).toContain("before the reset");

    // B is then refused. It judged an older draft, so the notice becomes
    // `refused-kept` - and the display still equals `persisted`, because both
    // are P. Equality holds while the host is known to hold something else.
    saveB.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();
    const kept = screen.getByTestId("fallback-host-error");

    // Falsification: drop `status.persistedUnverified` from `refused-kept`'s
    // confirmed branch. The page says the restored PRE-reset policy "is in
    // force" while the host holds whatever the reset wrote - which nothing has
    // read.
    expect(kept.textContent).not.toContain("is in force");
    // ...and NOT by forcing the equality false, which would select a sentence
    // that is equally untrue of a value this reducer put back.
    expect(kept.textContent).not.toContain("haven't been saved yet");
    // The correct account is the one the revert arm already gives.
    expect(kept.textContent).toContain(
      "still the settings from before the reset",
    );
    expect(kept.textContent).toContain(
      "may no longer be what this host is using",
    );
  });

  it("R10-B control: with the displayed save still PENDING, the notice says it is being saved, not that it was never sent", async () => {
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    fireEvent.click(automaticFallback());
    fireEvent.click(automaticFallback());
    // A's reply is lost while B - which carries what is on screen - is still
    // in flight. B has been sent; only its answer is missing.
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: restore
    // `unknownSave.revision === revision ? … : "…a newer edit that hasn't been
    // sent."`. The page tells the user their change was never sent while the
    // request carrying it is on the wire.
    expect(notice.textContent).toContain("Another change is being saved");
    expect(notice.textContent).not.toContain("hasn't been sent");
    expect(notice.textContent).toContain("may or may not have been saved");
  });

  it("R10-B control: with the displayed save CONFIRMED, the notice says so rather than that it was never sent", async () => {
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    fireEvent.click(automaticFallback());
    fireEvent.click(automaticFallback());
    // B lands first and is CONFIRMED on the revision that is on screen.
    saveB.resolveWith(policy({ enabled: false, graceWindowSeconds: 15 }));
    await flushHostReplies();
    // Only then is A's reply reported lost.
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Same falsification as above, and this is the arm where the old wording
    // was furthest from the truth: the host has stored exactly what is on
    // screen, and the page said it had never been sent.
    // Re-specified under D347 (eighth pass). This asserted
    // `toContain("has been saved")`, quoting "A change you made since has been
    // saved." - a HISTORY claim the state cannot support, since a read-back can
    // adopt a policy nobody authored. The sentence now describes the display's
    // relation to the host, and this sequence's account is unchanged under
    // either: the values on screen really are the host's row.
    expect(notice.textContent).toContain("what this host has saved");
    expect(notice.textContent).not.toContain("hasn't been sent");
  });

  it("R8: resetting an already-default policy does not license claiming the displayed values are NOT what the host holds", async () => {
    // The reset writes defaults and the follow-up get would return the same
    // deterministic seeded groups - so the values on screen may be exactly
    // what the host now has. The get is the request that failed, which is
    // precisely why nothing here can assert an inequality.
    fallbackMocks.queryData = respond(createDefaultFallbackPolicy());
    renderPanel();
    await resetWithLostRead();

    const banner = screen.getByTestId("fallback-reset-unrefreshed");
    // Falsification: restore "out of date, and not what this host is using
    // now." to `unrefreshedResetBody`'s `pre-reset-values` arm.
    expect(banner.textContent).not.toContain("out of date");
    expect(banner.textContent).toContain(
      "may not be what this host is using now",
    );
    expect(banner.textContent).toContain(
      "haven't been re-read since the reset",
    );

    // The rollback continuation reaches the parallel claim in the notice.
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(
      refusedByHost("policy is out of date"),
    );
    fireEvent.click(automaticFallback());
    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: restore "which this host is no longer using." to
    // `PRE_RESET_ROLLBACK_ACCOUNT`.
    expect(notice.textContent).not.toContain("this host is no longer using");
    expect(notice.textContent).toContain(
      "may no longer be what this host is using",
    );
  });
});

describe('FallbackSettingsPanel - seventh pass: "hasn\'t been sent" is claimed only on evidence (D339)', () => {
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-p7-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function refusedByHost(message: string): HostRpcError {
    return new HostRpcError({
      code: "RPC_ERROR",
      message,
      requestId: "req-p7-refused",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function deferred(): {
    readonly promise: Promise<ProvidersFallbackPolicySetResponse>;
    resolveWith: (value: FallbackPolicy) => void;
    rejectWith: (error: Error) => void;
  } {
    let resolveWith = (_value: FallbackPolicy): void => {};
    let rejectWith = (_error: Error): void => {};
    const promise = new Promise<ProvidersFallbackPolicySetResponse>(
      (resolve, reject) => {
        resolveWith = (value) => resolve({ policy: value });
        rejectWith = reject;
      },
    );
    promise.catch(() => {});
    return { promise, resolveWith, rejectWith };
  }

  function automaticFallback(): HTMLElement {
    return screen.getByRole("switch", { name: "Automatic fallback" });
  }

  const NEVER_SENT = "hasn't been sent";
  const SENT_UNKNOWN = "was sent, but we don't know what the host did with it";

  it("a read-back that ADOPTED the host's policy is not then called unsent when a later save goes unknown", async () => {
    // Sequence 1. A and B are both in flight. B's reply is lost, its read-back
    // returns exactly B, and `reconciled` adopts - the controls now show a
    // policy the host has confirmed to us. THEN A's reply is lost, so the
    // ticket names A while the display is still B's revision.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    renderPanel();

    fireEvent.click(automaticFallback());
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");

    // B's reply is lost and its read-back answers with B's own values.
    //
    // The `…Once` is B's answer; the persistent stub behind it is A's. BOTH
    // lost replies fire a read-back, and the base fixture's `refetchMock` is a
    // bare `vi.fn()` returning `undefined` - so a sequence that outruns its
    // stubs throws inside the handler, no notice is ever raised, and the test
    // fails as an ABSENT element rather than a wrong one.
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: true,
      data: respond(bPolicy),
    });
    saveB.rejectWith(lostTheReply());
    await flushHostReplies();
    await flushHostReplies();

    // Now A's reply is lost. Its ticket is the outstanding one; the display is
    // the policy the read-back just confirmed.
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: drop the `confirmedViewRevision: state.revision` from
    // `applyReconciled`'s adopting arm. The classifier then finds no
    // confirmation at this revision, falls to the final arm, and tells the user
    // the values a read-back just confirmed have never been sent.
    expect(notice.textContent).not.toContain(NEVER_SENT);
    // Re-specified under D347 (eighth pass). This asserted
    // `toContain("has been saved")`, quoting "A change you made since has been
    // saved." - a HISTORY claim the state cannot support, since a read-back can
    // adopt a policy nobody authored. The sentence now describes the display's
    // relation to the host, and this sequence's account is unchanged under
    // either: the values on screen really are the host's row.
    expect(notice.textContent).toContain("what this host has saved");
    // The controls still show what the host confirmed.
    expect(automaticFallback().getAttribute("aria-checked")).toBe("true");
  });

  it("a correcting rollback's adopted policy is not called unsent when a later save goes unknown", async () => {
    // Sequence 2. A, B, C in flight. C is refused (rollback), then B succeeds -
    // the correcting branch adopts B into the controls WITHOUT moving the
    // revision, which stays at C's. Then A's reply is lost.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveA = deferred();
    const saveB = deferred();
    const saveC = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise)
      .mockImplementationOnce(() => saveC.promise);
    // A's loss fires a read-back; persistent, so the sequence cannot outrun it.
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    fireEvent.click(automaticFallback());
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");
    openCombobox("Time to cancel before switching");
    chooseOption("12 seconds");

    saveC.rejectWith(refusedByHost("policy is out of date"));
    await flushHostReplies();
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    saveB.resolveWith(bPolicy);
    await flushHostReplies();

    saveA.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: in `applySaveSucceeded`, revert the correcting-rollback
    // return to recording `pending.revision` instead of `confirmedViewRevision`
    // (which is `state.revision`). The display sits at C's revision while the
    // confirmation is recorded against B's, so the two never match.
    //
    // BOTH halves, and the negative alone is why this pin measured nothing when
    // it was first written. Under that ablation the display does not fall to
    // "hasn't been sent" - C really was dispatched at this revision, so the
    // positive gate correctly refuses to call it unsent - it falls to
    // `sent-unknown`, which satisfies the negative while the page has stopped
    // saying the values are saved. The recipe reddened nothing and the pin
    // looked fine. What the page must actually say here is that the host
    // confirmed them.
    expect(notice.textContent).not.toContain(NEVER_SENT);
    expect(notice.textContent).not.toContain(SENT_UNKNOWN);
    // Re-specified under D347 (eighth pass). This asserted
    // `toContain("has been saved")`, quoting "A change you made since has been
    // saved." - a HISTORY claim the state cannot support, since a read-back can
    // adopt a policy nobody authored. The sentence now describes the display's
    // relation to the host, and this sequence's account is unchanged under
    // either: the values on screen really are the host's row.
    expect(notice.textContent).toContain("what this host has saved");
    expect(automaticFallback().getAttribute("aria-checked")).toBe("true");
  });

  it("a save that was sent and never confirmed says so, rather than claiming it was never sent", async () => {
    // Sequence 3. A and B in flight. B's reply is lost AND its read-back fails,
    // then A's reply is lost and its read-back fails too - A's failure replaces
    // the single ticket. B's values are on screen, were dispatched, and appear
    // in no lookup at all: not pending (it settled), not confirmed (nothing
    // confirmed it), not the unanswered draft (that is A now).
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    renderPanel();

    fireEvent.click(automaticFallback());
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");

    saveB.rejectWith(lostTheReply());
    await flushHostReplies();
    saveA.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: remove the `neverDispatched` gate from
    // `displayDispatchState` so the final arm is reached by elimination again.
    // Nothing distinguishes this display - dispatched, unconfirmed - from an
    // edit the user never submitted, and the page picks the one verdict it has
    // no evidence for.
    expect(notice.textContent).not.toContain(NEVER_SENT);
    expect(notice.textContent).toContain(SENT_UNKNOWN);
  });

  // The pin for "a reset must not raise the dispatch high-water mark" lives in
  // the REDUCER suite, not here, and the reason is a reachability fact rather
  // than a preference - but it is narrower than it first looked, so state the
  // scope: in the CONFIRMED-reset-with-failed-read scenario, `applyEdited`
  // clears `hostError` on both returns, so the moved-on `unknown` notice only
  // exists when the edit PRECEDES the lost reply (the invalid-C shape), and a
  // reset dispatched after that edit discharges the very ticket the notice
  // belongs to, because `applyResetUnrefreshed` drops any `unknownSave` with a
  // lower request id. THAT ordering cannot show all three at once.
  //
  // A reset whose OWN RPC is lost is a different scenario and does render all
  // three together - it is the eighth pass's no-draft pin below. The original
  // claim was written as if it covered every reset; it covers one. See
  // "D339: a reset does not raise the dispatch high-water mark" in
  // `fallback/__tests__/fallback-policy-draft.test.ts`.
});

describe("FallbackSettingsPanel - eighth pass: a sentence describes the thing it names (D347)", () => {
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-p8-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function deferred(): {
    readonly promise: Promise<ProvidersFallbackPolicySetResponse>;
    resolveWith: (value: FallbackPolicy) => void;
    rejectWith: (error: Error) => void;
  } {
    let resolveWith = (_value: FallbackPolicy): void => {};
    let rejectWith = (_error: Error): void => {};
    const promise = new Promise<ProvidersFallbackPolicySetResponse>(
      (resolve, reject) => {
        resolveWith = (value) => resolve({ policy: value });
        rejectWith = reject;
      },
    );
    promise.catch(() => {});
    return { promise, resolveWith, rejectWith };
  }

  function automaticFallback(): HTMLElement {
    return screen.getByRole("switch", { name: "Automatic fallback" });
  }

  const AUTHORED = "change you made since";

  /**
   * A local copy: the sibling of this name lives inside another `describe` and
   * is not in scope here. Annotated rather than inferred for the reason stated
   * at that one - `harnessId` is a registry-derived union a standalone literal
   * widens to `string`.
   */
  function storedGroups(): TierGroup[] {
    return [
      {
        id: "fast",
        candidates: [
          { harnessId: "claude", modelFamily: "sonnet", reasoningEffort: null },
        ],
      },
    ];
  }

  it("a read-back that adopts the ORIGINAL policy does not say a change of yours was saved", async () => {
    // A and B both go out; B's reply is lost; the read-back returns P - the
    // policy that was there before either - so NEITHER save committed. The
    // adopting arm puts P on screen and records confirmation at the display's
    // revision, which is right: the display IS the host's row. What must not
    // follow is the claim that a change the user made has been saved.
    const original = policy({ enabled: false, graceWindowSeconds: 15 });
    fallbackMocks.queryData = respond(original);
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    renderPanel();

    fireEvent.click(automaticFallback());
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");

    // The read-back answers with the ORIGINAL, not with B.
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: true,
      data: respond(original),
    });
    saveB.rejectWith(lostTheReply());
    await flushHostReplies();
    await flushHostReplies();

    saveA.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: restore "A change you made since has been saved." to
    // `displayAccount`'s `confirmed` arm. The page then credits the user with a
    // save while the controls show the settings they started from - the switch
    // is back OFF, which is what P says and what neither of their saves asked
    // for.
    expect(notice.textContent).not.toContain(AUTHORED);
    expect(notice.textContent).toContain("what this host has saved");
    // The controls are P, which is what makes the sentence above the true one.
    expect(automaticFallback().getAttribute("aria-checked")).toBe("false");
  });

  it("CONTROL: when the read-back returns the displayed change, the display account still holds", async () => {
    // The positive control for the pin above: the same shape, except the
    // read-back returns B. The sentence is unchanged - it describes the
    // display's relation to the host either way, which is the point of D347 -
    // so this pin is what stops the fix being "delete the confirmed arm".
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveA = deferred();
    const saveB = deferred();
    fallbackMocks.setMutateAsync
      .mockImplementationOnce(() => saveA.promise)
      .mockImplementationOnce(() => saveB.promise);
    renderPanel();

    fireEvent.click(automaticFallback());
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");

    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fallbackMocks.refetchMock.mockResolvedValueOnce({
      isSuccess: true,
      data: respond(bPolicy),
    });
    saveB.rejectWith(lostTheReply());
    await flushHostReplies();
    await flushHostReplies();

    saveA.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    expect(notice.textContent).toContain("what this host has saved");
    expect(automaticFallback().getAttribute("aria-checked")).toBe("true");
  });

  it("a RESET whose own reply is lost does not describe an unsent edit as the unanswered request", async () => {
    // The no-draft unknown outcome. The reset's RPC is lost, so the uncertainty
    // is about the RESET; the display is an invalid edit that was never sent
    // anywhere. Before `carries` reached the ticket, the first arm matched on
    // revision alone - a reset moves no revision - and the page told the user
    // that what was on screen "may or may not have been saved".
    fallbackMocks.queryData = respond(
      policy({
        enabled: false,
        graceWindowSeconds: 15,
        tierGroups: storedGroups(),
      }),
    );
    renderPanel();

    // An invalid edit: kept on screen, sent nowhere.
    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Model family"), {
      target: { value: "" },
    });
    expect(
      (await screen.findByTestId("fallback-local-error")).textContent,
    ).toContain("A model needs a family name.");

    fallbackMocks.resetMutateAsync.mockRejectedValueOnce(lostTheReply());
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: drop `unknownSave.carries === "draft"` from
    // `displayDispatchState`'s first arm. The reset's uncertainty is then
    // pinned to the invalid draft, which the reset never carried and nothing
    // ever sent.
    expect(notice.textContent).toContain("whether the reset went through");
    expect(notice.textContent).not.toContain(
      "What's on screen is your change, not a confirmed setting",
    );
    // The display's own account comes from the gate, and it is TRUE of these
    // values: nothing dispatched them.
    expect(notice.textContent).toContain("hasn't been sent");
  });

  it("a RESTORE whose own reply is lost is named as the restore, not as the reset", async () => {
    // The same shape one operation over, and the reason `carries` distinguishes
    // the two rather than collapsing them into "no-draft": the sentence names
    // what was lost, so a restore described as "the reset" would be this
    // panel's own recurring defect with a different noun.
    //
    // ZERO groups, because "Restore the default groups" is the tier-group
    // editor's EMPTY-STATE button and renders nowhere else. The first draft of
    // this pin seeded a group and made an invalid edit - scaffolding carried
    // over from the reset pin without asking whether it was needed. It is not,
    // and the two requirements were in fact mutually exclusive: a "Model
    // family" field only exists INSIDE a group. What the display has to be here
    // is UNSENT, not invalid, and with no draft ever dispatched
    // `lastDispatchedRevision` is null - so the gate proves it unsent from the
    // strongest evidence there is, with no edit at all.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15, tierGroups: [] }),
    );
    renderPanel();

    fallbackMocks.restoreMutateAsync.mockRejectedValueOnce(lostTheReply());
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Restore the default groups" }),
    );
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: collapse `carries` back to "draft" | "no-draft" and give
    // both no-draft operations the reset's sentence. The page then reports a
    // reset that never happened.
    expect(notice.textContent).toContain(
      "whether restoring the default groups went through",
    );
    expect(notice.textContent).not.toContain("whether the reset went through");
    // Re-specified under D353 (ninth pass). This asserted
    // `toContain("hasn't been sent")`, which was the whole `uncommitted` arm at
    // the time. The matrix splits that arm: this display is `loaded-unchanged`
    // - untouched values straight from the load - and "a newer edit that hasn't
    // been sent" was false about both halves. The REQUEST half of this pin is
    // unchanged; only the display account moved, and it moved because the cell
    // it always occupied finally has its own sentence.
    expect(notice.textContent).toContain("what was loaded");
    expect(notice.textContent).toContain("nothing has been changed since");
    expect(notice.textContent).not.toContain("a newer edit");
  });
});

describe("FallbackSettingsPanel - ninth pass: every sentence derives from the matrix (D353)", () => {
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-p9-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function deferred(): {
    readonly promise: Promise<ProvidersFallbackPolicySetResponse>;
    resolveWith: (value: FallbackPolicy) => void;
    rejectWith: (error: Error) => void;
  } {
    let resolveWith = (_value: FallbackPolicy): void => {};
    let rejectWith = (_error: Error): void => {};
    const promise = new Promise<ProvidersFallbackPolicySetResponse>(
      (resolve, reject) => {
        resolveWith = (value) => resolve({ policy: value });
        rejectWith = reject;
      },
    );
    promise.catch(() => {});
    return { promise, resolveWith, rejectWith };
  }

  function automaticFallback(): HTMLElement {
    return screen.getByRole("switch", { name: "Automatic fallback" });
  }

  function groupsPolicy(): FallbackPolicy {
    return policy({
      enabled: false,
      graceWindowSeconds: 15,
      tierGroups: [
        {
          id: "fast",
          candidates: [
            {
              harnessId: "claude",
              modelFamily: "sonnet",
              reasoningEffort: null,
            },
          ],
        },
      ],
    });
  }

  it("MATRIX confirmed x reset x unknown: a confirmed display stops being called what the host has once a reset goes unanswered", async () => {
    // The cell eight passes never reached. B is confirmed, so the display is
    // `confirmed`; then the RESET's own reply is lost - not its read, its reply
    // - so no staleness banner is ever raised (that path needs a CONFIRMED
    // reset) and nothing re-reads the row. The host may already hold defaults.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const saveB = deferred();
    fallbackMocks.setMutateAsync.mockImplementationOnce(() => saveB.promise);
    renderPanel();

    const bPolicy = policy({ enabled: true, graceWindowSeconds: 15 });
    fireEvent.click(automaticFallback());
    saveB.resolveWith(bPolicy);
    await flushHostReplies();

    // The reset's own reply is lost.
    fallbackMocks.resetMutateAsync.mockRejectedValueOnce(lostTheReply());
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: drop the `authorityInvalidated` branch from
    // `displayAccount`'s `confirmed` arm. The page says "What's on screen is
    // what this host has saved" while an unanswered reset may already have
    // replaced the row - and no banner contradicts it, because the reset was
    // never confirmed.
    expect(notice.textContent).not.toContain("is what this host has saved");
    // The confirmation is KEPT, not collapsed into "we don't know": B really
    // was stored, and the sentence says so in the past tense.
    //
    // Re-specified in the tenth pass (N3). This pin's sequence dispatches the
    // reset LAST, so "before the reset" happened to be true here - which is
    // exactly why it survived: the wording asserted an order this state does
    // not carry, and only the reverse dispatch order shows it. That order has
    // its own pin; this one keeps the claim it was written for, which is that
    // the confirmation is not thrown away.
    expect(notice.textContent).toContain("was confirmed as saved on this host");
    expect(notice.textContent).toContain(
      "A reset is also outstanding whose result is unknown",
    );
    // BOTH orderings rejected, not just the first one. "before the" said the
    // confirmation came first and "since then" said the reset did; this state
    // knows neither, so neither may appear.
    expect(notice.textContent).not.toContain("before the");
    expect(notice.textContent).not.toContain("since then");
    expect(notice.textContent).toContain("hasn't been re-read");
    // The REQUEST account names the reset, per the matrix's second axis.
    expect(notice.textContent).toContain("whether the reset went through");
    expect(screen.queryByTestId("fallback-reset-unrefreshed")).toBeNull();
  });

  it("MATRIX edited-unsent x reset x unknown: a reset does not erase the validation error of a draft it never carried", async () => {
    // `applySaveFailed` cleared `localError` whenever the settled request's
    // revision equalled the display's - which a reset satisfies for free, since
    // it sends no draft and so moves no revision.
    fallbackMocks.queryData = respond(groupsPolicy());
    renderPanel();

    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Model family"), {
      target: { value: "" },
    });
    expect(
      (await screen.findByTestId("fallback-local-error")).textContent,
    ).toContain("A model needs a family name.");

    fallbackMocks.resetMutateAsync.mockRejectedValueOnce(lostTheReply());
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await flushHostReplies();

    // Falsification: drop `pending.carries === "draft"` from
    // `clearsValidation`, which BOTH of `applySaveFailed`'s surviving-ticket
    // returns call - the `unknown` branch and the refused-with-outstanding-
    // ticket branch beside it, which carried the identical expression. (The
    // third `localError: null` in that function is the revert, which replaces
    // the draft wholesale, so clearing is right there and it is not gated.)
    // The invalid family field keeps its empty value and
    // loses the error beside it, so the control reads as accepted - the exact
    // defect the revision check exists to prevent, reached through the one
    // operation that check cannot see.
    //
    // BOTH alerts, asserted together: the eighth-pass reset pin checked the
    // local one only BEFORE the reset, which is why this survived it.
    expect(screen.getByTestId("fallback-local-error").textContent).toContain(
      "A model needs a family name.",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Model family").value).toBe(
      "",
    );
    const notice = screen.getByTestId("fallback-host-error");
    expect(notice.textContent).toContain("whether the reset went through");
    // The uncertainty is the reset's, so its recovery is on screen too.
    expect(screen.getByTestId("fallback-check-again")).toBeDefined();
  });

  // The `loaded-unchanged x restore x unknown` cell is pinned by the eighth
  // pass's restore pin, re-specified above rather than duplicated here: it is
  // the same sequence, and two pins asserting one cell is the co-firing shape
  // this lane already warned itself about. Its positive control follows.

  it("MATRIX edited-unsent x reset x unknown: a VALID edit nobody sent is still called unsent", async () => {
    // The `uncommitted` half of the split the restore pin above pins from the
    // `loaded-unchanged` side, and a cell neither existing assertion covers.
    //
    // WHAT MAKES A DISPLAY UNSENT HERE. `commit` dispatches `edited` and then
    // `save-started` in the same tick, and `applySaveStarted` stamps
    // `lastDispatchedRevision` at the post-edit revision - so every switch,
    // select, arrow and button leaves `revision === lastDispatchedRevision` and
    // the display is `sent-unknown`, never `uncommitted`. Only `editDraft`, the
    // TEXT-field path, moves the draft while sending nothing. `uncommitted` is
    // therefore reachable from a text edit and from nothing else, which also
    // makes it unreachable under a RESTORE: that button is the tier-group
    // editor's empty state and a "Model family" field only exists inside a
    // group. The operation here is the reset for that reason, not by preference.
    //
    // VALID, which is what is new. Both existing "hasn't been sent" assertions
    // reach `uncommitted` through an INVALID draft, where a validation alert
    // sits above the notice already saying the edit was not sent. Strip that
    // second voice and the notice has to carry the claim alone.
    fallbackMocks.queryData = respond(groupsPolicy());
    renderPanel();

    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Model family"), {
      target: { value: "opus" },
    });
    // No `save-started` behind this: a valid text edit is still only an edit.
    expect(screen.queryByTestId("fallback-local-error")).toBeNull();

    fallbackMocks.resetMutateAsync.mockRejectedValueOnce(lostTheReply());
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: M3i, the INVERSE of M3 - collapse the same line to
    // `return "loaded-unchanged"`. M3 itself collapses toward `uncommitted`,
    // which is what this display already is, so M3 leaves this pin green and
    // reddens the restore pin instead. The two recipes and the two pins are
    // the two halves of one split. Under M3i these values, which are NOT the
    // loaded ones, get called what was loaded.
    expect(notice.textContent).toContain("hasn't been sent");
    expect(notice.textContent).not.toContain("what was loaded");
    // The reset's own account is unchanged by any of this - the two sentences
    // answer independent questions, which is the factorisation itself.
    expect(notice.textContent).toContain("whether the reset went through");
  });
});

describe("FallbackSettingsPanel - tenth pass: the state model's last three gaps", () => {
  function lostTheReply(): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "lost the connection",
      requestId: "req-p10-unknown",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function refusedByHost(message: string): HostRpcError {
    return new HostRpcError({
      code: "RPC_ERROR",
      message,
      requestId: "req-p10-refused",
      method: "providers.fallbackPolicy.set",
      fatalDetails: null,
    });
  }

  function deferred(): {
    readonly promise: Promise<ProvidersFallbackPolicySetResponse>;
    resolveWith: (value: FallbackPolicy) => void;
    rejectWith: (error: Error) => void;
  } {
    let resolveWith = (_value: FallbackPolicy): void => {};
    let rejectWith = (_error: Error): void => {};
    const promise = new Promise<ProvidersFallbackPolicySetResponse>(
      (resolve, reject) => {
        resolveWith = (value) => resolve({ policy: value });
        rejectWith = reject;
      },
    );
    promise.catch(() => {});
    return { promise, resolveWith, rejectWith };
  }

  function automaticFallback(): HTMLElement {
    return screen.getByRole("switch", { name: "Automatic fallback" });
  }

  function failEveryRead(): void {
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: false,
      data: fallbackMocks.queryData,
    });
  }

  function groupsPolicy(): FallbackPolicy {
    return policy({
      enabled: false,
      graceWindowSeconds: 15,
      tierGroups: [
        {
          id: "fast",
          candidates: [
            {
              harnessId: "claude",
              modelFamily: "sonnet",
              reasoningEffort: null,
            },
          ],
        },
      ],
    });
  }

  it("N3: the confirmed-but-unverified sentence claims no ORDER, because the reset can have been dispatched FIRST", async () => {
    // The ninth pass wrote "was what this host had saved before the reset",
    // which asserts a relation nothing in this state carries. This is the order
    // that makes it false: R goes out first, the host applies it, B is
    // confirmed on top of it, and R's LOSS is the last thing to arrive. The
    // displayed values were saved AFTER the reset, not before it.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    const reset = deferred();
    fallbackMocks.resetMutateAsync.mockImplementationOnce(() => reset.promise);
    renderPanel();

    // R first, and left in flight. Only Reset and Restore are disabled while it
    // runs, so the toggle below is ordinary usage rather than a contrived race.
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await flushHostReplies();

    // B is dispatched and CONFIRMED while R is still outstanding.
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 15 });
    const saveB = deferred();
    fallbackMocks.setMutateAsync.mockImplementationOnce(() => saveB.promise);
    fireEvent.click(automaticFallback());
    saveB.resolveWith(bPolicy);
    await flushHostReplies();

    // R's reply is lost, last.
    failEveryRead();
    reset.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: restore the "before the ${operationNoun(...)}" wording in
    // `displayAccount`'s `confirmed` authority branch. This sequence then reads
    // "was what this host had saved before the reset" about values the host
    // took AFTER it - the one relation the sentence stated, stated backwards.
    expect(notice.textContent).not.toContain("before the reset");
    // What IS known: the confirmation happened, and something since has no
    // answer. Historical, not relative.
    expect(notice.textContent).toContain("was confirmed as saved on this host");
    expect(notice.textContent).toContain(
      "A reset is also outstanding whose result is unknown",
    );
    // BOTH orderings rejected, not just the first one. "before the" said the
    // confirmation came first and "since then" said the reset did; this state
    // knows neither, so neither may appear.
    expect(notice.textContent).not.toContain("before the");
    expect(notice.textContent).not.toContain("since then");
    expect(notice.textContent).toContain("hasn't been re-read");
  });

  it("N1: refused-on-screen - a refusal that was never rolled back is not described as settings put back", async () => {
    // The display state the matrix did not have. `draftIsRefused` meant EITHER
    // "values restored" OR "refused draft kept because another outcome is
    // unknown", and both got the rollback's sentence.
    //
    // X is load-bearing and is NOT scaffolding: `displayAccount` is reached
    // from the `unknown` arm alone, so without a third unanswered request the
    // notice stays `refused-unverified` and the wrong sentence never renders.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
    renderPanel();

    // A: dispatched, reply lost, read fails. The ticket is open from here on.
    // The toggle carries the value, so nothing here needs to name it.
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReply());
    failEveryRead();
    fireEvent.click(automaticFallback());
    await flushHostReplies();

    // B: a NEW edit, refused by the host while A is still unknown. The reducer
    // deliberately does not revert - reverting would claim the old value is in
    // force when A's lost reply may already have replaced it - so the value the
    // host TURNED DOWN is what stays in the controls.
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(
      refusedByHost("that grace window is out of range"),
    );
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");
    await flushHostReplies();

    // X: the reset's own reply is lost, which is what puts the notice back on
    // the `unknown` arm and renders the display account.
    fallbackMocks.resetMutateAsync.mockRejectedValueOnce(lostTheReply());
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // Falsification: collapse the classifier's refusal arm back to a single
    // `if (input.refused !== null) return "rollback";` - dropping the
    // `refused-on-screen` state - or record `restoredPersisted: true` on the
    // outstanding-ticket branch. The page then
    // says a refused value the reducer never restored is "your last saved
    // settings, put back": wrong about the values AND about what happened.
    expect(notice.textContent).not.toContain("put back");
    expect(notice.textContent).not.toContain("last saved settings");
    expect(notice.textContent).toContain("a change the host turned down");
    // The REQUEST account is still the reset's, unchanged by any of this.
    expect(notice.textContent).toContain("whether the reset went through");
  });

  it("N1: a refused RESET does not erase the unsent invalid draft it never carried", async () => {
    // A USER'S DRAFT ERASED, not copy. The kept-refusal constructor tested only
    // `pending.revision === state.revision`, and a reset satisfies that for
    // free: it sends no draft, so it moves no revision, so its pending revision
    // is whatever the user is looking at. The refusal therefore marked C - an
    // unsent, invalid draft the reset never carried - as "a value the host
    // refused", `draftIsRefused` went true, and the next read-back took
    // `applyReconciled`'s ADOPTING arm and replaced C and its validation error
    // with the host's row.
    fallbackMocks.queryData = respond(groupsPolicy());
    renderPanel();

    // A goes unknown and its read fails, so the ticket is open and the refusal
    // below takes the outstanding-ticket branch rather than reverting.
    fallbackMocks.setMutateAsync.mockRejectedValueOnce(lostTheReply());
    failEveryRead();
    fireEvent.click(automaticFallback());
    await flushHostReplies();

    // C: an unsent, INVALID draft. Nothing dispatches it - `commit` returns
    // after `edited` because the new candidate's family is blank.
    fireEvent.click(screen.getByRole("button", { name: "Add a model" }));
    expect(
      (await screen.findByTestId("fallback-local-error")).textContent,
    ).toContain("A model needs a family name.");

    // The reset is refused. It carried defaults; it never carried C.
    fallbackMocks.resetMutateAsync.mockRejectedValueOnce(
      refusedByHost("resetting is disabled for this host"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await flushHostReplies();

    // Check again: the read-back succeeds and returns the host's policy.
    fallbackMocks.refetchMock.mockResolvedValue({
      isSuccess: true,
      data: fallbackMocks.queryData,
    });
    fireEvent.click(screen.getByTestId("fallback-check-again"));
    await flushHostReplies();

    // Falsification: drop the `pending.carries === "draft"` term from
    // `judgedTheDisplay`. The refused reset marks C, `draftIsRefused` goes
    // true, the read-back adopts over it, and both assertions below fail
    // together - the empty field is gone AND the error that explained it is.
    expect(
      screen.getAllByLabelText<HTMLInputElement>("Model family").length,
    ).toBeGreaterThan(1);
    expect(screen.getByTestId("fallback-local-error").textContent).toContain(
      "A model needs a family name.",
    );
  });

  it("REACHABILITY: a RESTORE can be unanswered while the display is an unsent edit", async () => {
    // The ninth pass argued this cell was impossible - the Restore button lives
    // in the zero-group empty state, and a "Model family" field only exists
    // inside a group. Both halves of that are true and the conclusion is still
    // wrong: only the Restore BUTTON takes `restorePending`. "Add a group"
    // renders outside `EmptyGroups` and is never disabled, so groups can be
    // built while the restore's RPC is in flight.
    //
    // "Add a model" is what makes the draft UNSENT, and it is needed: an empty
    // group is schema-valid (`candidates` has no `.min(1)`), so adding a group
    // alone dispatches a save and the display would be `sent-unknown`. The new
    // candidate's family is deliberately blank, so `commit` returns after
    // `edited` and nothing goes out - which is also the correction to "only a
    // text edit can reach this state": this one is two button clicks.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15, tierGroups: [] }),
    );
    const restore = deferred();
    fallbackMocks.restoreMutateAsync.mockImplementationOnce(
      () => restore.promise,
    );
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore the default groups" }),
    );
    await flushHostReplies();

    fireEvent.click(screen.getByRole("button", { name: "Add a group" }));
    await flushHostReplies();
    fireEvent.click(screen.getByRole("button", { name: "Add a model" }));
    await flushHostReplies();

    failEveryRead();
    restore.rejectWith(lostTheReply());
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // The cell renders, which is the reachability claim itself: both accounts
    // are present and each names its own subject.
    expect(notice.textContent).toContain(
      "whether restoring the default groups went through",
    );
    expect(notice.textContent).toContain("hasn't been sent");
  });

  it("the refused-kept consequence over a CONFIRMED display says the host has it, not that changes are unsaved", async () => {
    // RETITLED in the tenth close-out to what it actually tests. It was written
    // as `loaded-unchanged × set × refused` and it is not that composition: the
    // second toggle is CONFIRMED here (`saveBack.resolveWith`), so
    // `confirmedViewRevision === revision` and the display state is
    // `confirmed`. What the pin really holds is the `refused-kept` consequence
    // over a display the host has confirmed - which is a claim worth pinning,
    // just not the one in the old title.
    //
    // The never-dispatched variant (Enter-commit a family, type it BACK without
    // committing, then the earlier refusal arrives) is genuinely
    // `loaded-unchanged`, and it is marked UNPINNED in the coverage row rather
    // than written: it renders the SAME sentence. `refused-kept` never calls
    // `displayAccount`, and its `draftConfirmed` branch is taken in both cases
    // because typing a value back to the loaded one leaves the draft equal to
    // `persisted`. A second pin would assert identical text about a different
    // internal state - a test that cannot fail differently from this one.
    fallbackMocks.queryData = respond(
      policy({ enabled: false, graceWindowSeconds: 15, tierGroups: [] }),
    );
    const saveA = deferred();
    fallbackMocks.setMutateAsync.mockImplementationOnce(() => saveA.promise);
    renderPanel();

    // A goes out on the toggle...
    fireEvent.click(automaticFallback());
    await flushHostReplies();
    // ...and the user puts it back where it was, which sends a SECOND save.
    // That save is what moves the revision past A's; the values are the loaded
    // ones again either way, and sameness is what the sentence is about.
    const backPolicy = policy({ enabled: false, graceWindowSeconds: 15 });
    const saveBack = deferred();
    fallbackMocks.setMutateAsync.mockImplementationOnce(() => saveBack.promise);
    fireEvent.click(automaticFallback());
    saveBack.resolveWith(backPolicy);
    await flushHostReplies();

    // A's refusal arrives last, judging a draft two edits old.
    saveA.rejectWith(refusedByHost("automatic fallback can't be enabled here"));
    await flushHostReplies();

    const notice = await screen.findByTestId("fallback-host-error");
    // WHICH SENTENCE this cell actually gets, which is the correction Run 2
    // forced. The first version of this pin asserted `not.toContain("a newer
    // edit that hasn't been sent")` and reddened under NOTHING - because
    // `displayAccount` is reached from the `unknown` arm alone, and this
    // notice is `refused-kept`, which returns its own consequence copy and
    // never consults the display axis. The string it denied cannot appear here
    // under any mutation of the split, so the assertion was vacuous: the
    // sequence reached the CELL and not the SENTENCE.
    //
    // So the cell is REACHABLE - which was the claim, and it holds - but it is
    // not a display-account cell. Those exist only where `displayAccount` is
    // called. See the P3 scope table in SETTINGS.md.
    //
    // Falsification: drop the `status.draftConfirmed` branch from
    // `saveNoticeConsequence`'s `refused-kept` arm. The page then says "The
    // changes you have made since are still on screen and haven't been saved
    // yet" about values that are the loaded ones and that the host has
    // confirmed - the arm's own reason for existing.
    expect(notice.textContent).toContain("This change wasn't saved.");
    expect(notice.textContent).toContain(
      "What's on screen is a different change the host has confirmed, and it is in force.",
    );
  });
});
