import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import { ProviderAutoJudgeSection } from "@/components/settings/panels/provider-auto-judge-section";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");

// The section gates on the WRITE method as well as on the catalog, because a
// host can answer `agent.gui.listHarnesses@9.1` and not advertise
// `providers.setAutoJudge` (registered `degrade: { kind: "unsupported" }`).
// The negotiated-manifest registry is the real one here - only the host id is
// mocked - so these cases exercise `useHostMethodSupport` rather than a stand-in
// for it.
const HOST_ID = vi.hoisted(() => "host-provider-auto-judge");
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST_ID,
}));

const guiHarnessesQueryMock = vi.hoisted(() => ({
  data: undefined as { harnesses: GuiHarnessOption[] } | undefined,
}));
// Typed so the call records below are a typed tuple rather than `any`: the
// `no-unsafe-*` rules are on in tests too, and reading `.onError` off an
// untyped mock call is exactly what they refuse.
type SetAutoJudgeVariables = {
  readonly harnessId: string;
  readonly autoJudge: string;
};
type SetAutoJudgeCallbacks = { readonly onError: () => void };
const setAutoJudgeMutateMock = vi.hoisted(() =>
  vi.fn<
    (variables: SetAutoJudgeVariables, callbacks: SetAutoJudgeCallbacks) => void
  >(),
);
const setAutoJudgeMock = vi.hoisted(() => ({
  mutate: setAutoJudgeMutateMock,
  isPending: false,
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () =>
    guiHarnessesQueryMock.data === undefined
      ? { data: undefined }
      : { data: guiHarnessesQueryMock.data },
}));

// The echo now also expires on the authoritative read COMPLETING, not only on
// the stored value changing - so the section observes `providers.list`'s
// `dataUpdatedAt` as a fetch counter. Held constant here: every case below is
// "the refetch has not landed yet", which is the window the echo exists for.
// A test that wants the echo retired advances this instead of changing the
// value, which is exactly the case value-only expiry could not reach.
const providersUpdatedAt = vi.hoisted(() => ({ current: 1_000 }));
// `isFetching` is STATED, not omitted. The section now holds the selector
// locked through the authoritative refresh as well as through the write, so a
// mock without this field answers `undefined` and silently reduces the new flag
// to the old one - the control would look correct in every case here while the
// refresh half went untested. Defaults to settled; the case about the lock
// moves it.
const providersFetching = vi.hoisted(() => ({ current: false }));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    dataUpdatedAt: providersUpdatedAt.current,
    isFetching: providersFetching.current,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-auto-judge-mutation", () => ({
  useProvidersSetAutoJudge: () => setAutoJudgeMock,
}));

// The card's "All permission settings" link opens Settings; the call is the
// contract, so the opener is a typed stand-in.
const openSettingsMock = vi.hoisted(() =>
  vi.fn<
    (opts: {
      readonly section: string | null;
      readonly resetToGeneral: boolean;
      readonly tab: string | null;
      readonly draft: null;
      readonly hostId: string | null;
    }) => void
  >(),
);
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: openSettingsMock }),
}));

// The supported case, which is every case that is not explicitly about the
// gate. Seeded per test rather than once, so a case that wants the OTHER
// answer records its own manifest over this one.
beforeEach(() => {
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.setAutoJudge": { major: 1, minor: 0 },
    // The READ half. `providers.list@9.1` is the only line that publishes
    // `autoJudge`, and the section refuses to present a stored value it cannot
    // actually read - so a manifest naming only the setter now lands on the
    // unreadable panel rather than the switch. Both halves are the supported
    // case; the cases about either gate record their own manifest.
    "providers.list": { major: 9, minor: 1 },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  providersUpdatedAt.current = 1_000;
  providersFetching.current = false;
  vi.clearAllMocks();
  guiHarnessesQueryMock.data = undefined;
  setAutoJudgeMock.isPending = false;
});

function harnessRow(overrides: Partial<GuiHarnessOption>): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: CLAUDE_HARNESS_ID,
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    nativeAutoJudge: false,
    ...overrides,
  });
}

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    // `selected` is a discriminated union with no null member - which binary
    // this provider runs is always one of the three. Nothing in this section
    // reads it; it is here because `ProviderCliState` requires it.
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    ...overrides,
  };
}

describe("<ProviderAutoJudgeSection />", () => {
  it("draws the card's heading and link, but no switch or line, while the catalog has not loaded", () => {
    guiHarnessesQueryMock.data = undefined;

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    expect(screen.getByText("Who reviews Claude Code's commands")).toBeTruthy();
    expect(screen.getByTestId("provider-auto-judge-all-settings")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("provider-auto-judge-readonly")).toBeNull();
  });

  it("opens Permissions on its Judge tab from 'All permission settings'", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);
    fireEvent.click(screen.getByTestId("provider-auto-judge-all-settings"));

    expect(openSettingsMock).toHaveBeenCalledTimes(1);
    expect(openSettingsMock).toHaveBeenCalledWith({
      section: "permissions",
      tab: "judge",
      draft: null,
      resetToGeneral: false,
      hostId: null,
    });
  });

  it("renders a read-only Traycer's judge line, and no select, when the harness row reports nativeAutoJudge: false", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: false })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    // The tab is drawn for every provider, so "nothing to choose" is still
    // an answer: the question the card is headed with, and where the judge
    // that answers it is chosen. No switch with one option.
    expect(screen.getByText("Who reviews Claude Code's commands")).toBeTruthy();
    const readonly = screen.getByTestId("provider-auto-judge-readonly");
    expect(readonly.textContent).toBe(
      "Reviewed by Traycer's judge. Change it under Permissions.",
    );
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("renders the row when nativeAutoJudge is true", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    // Spelled out rather than built from `PROVIDER_DISPLAY_NAMES`: this is the
    // label a user reads, and the row is deliberately NOT called "Auto mode
    // judge" any more - the row under Settings ▸ Permissions carries that name and
    // THIS is the one that wins. An assertion derived from the same constant
    // the component interpolates would follow a rename instead of catching it.
    expect(screen.getByText("Who reviews Claude Code's commands")).toBeTruthy();
  });

  it("renders Traycer's judge selected when the stored state has no autoJudge key", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch("Traycer's judge");
  });

  it("renders the provider's classifier selected when the stored state carries autoJudge: 'provider'", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: "provider" })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });

  it("sends providers.setAutoJudge with {harnessId, autoJudge: 'provider'} and keeps showing the choice as a local echo", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );

    // Two arguments now: the variables, plus a per-call `onError` the row uses
    // to retire its echo when the write is refused. The callback's identity is
    // not the contract, so only its presence is asserted.
    expect(setAutoJudgeMutateMock.mock.calls.length).toBe(1);
    const [variables, callbacks] = setAutoJudgeMutateMock.mock.calls[0];
    expect(variables).toEqual({
      harnessId: CLAUDE_HARNESS_ID,
      autoJudge: "provider",
    });
    expect(typeof callbacks.onError).toBe("function");
    // The echo, not a `providers.list` re-read: the fixture still says nothing
    // was ever stored, yet the control keeps showing what was just picked.
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });

  it("retires the echo when the write is refused, so the control stops showing a choice that never took", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );

    // The host refused it. `useHostScopedMutation` toasts; the row's own
    // `onError` is what puts the control back in agreement with what is
    // actually stored.
    expect(setAutoJudgeMutateMock.mock.calls.length).toBe(1);
    act(() => {
      setAutoJudgeMutateMock.mock.calls[0][1].onError();
    });

    expect(screen.getByRole("combobox").textContent).toMatch("Traycer's judge");
  });

  it("disables the Select trigger while setAutoJudge is pending, so a click cannot change the value", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };
    setAutoJudgeMock.isPending = true;

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.getAttribute("data-disabled")).toBe("");
    expect(trigger.hasAttribute("disabled")).toBe(true);

    // Radix refuses to open a disabled trigger, so a click cannot reach an
    // option at all - the value must stay exactly where it started.
    fireEvent.click(trigger);
    expect(screen.queryByRole("option")).toBeNull();
    expect(trigger.textContent).toMatch("Traycer's judge");
    expect(setAutoJudgeMutateMock).not.toHaveBeenCalled();
  });

  // Control for the case above: without it, a Select that is ALWAYS disabled
  // (a typo, a stuck default) would pass the pending assertion for the wrong
  // reason.
  it("control: leaves the Select trigger enabled when setAutoJudge is not pending", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };
    setAutoJudgeMock.isPending = false;

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(trigger.getAttribute("data-disabled")).toBeNull();
  });

  it("clears the echo without flicker once the stored value agrees with it", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    const { rerender } = render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );

    // The host's `providers.list` echo lands: the stored value now agrees
    // with what the user picked, and the control must keep showing it (no
    // reversion to Traycer's judge in between).
    rerender(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: "provider" })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });

  // JOB 3: the masking case `seenAt` exists to close. Another window sets the
  // provider back to the exact value this echo was made AGAINST before our own
  // invalidated refetch lands - `stored` equals `echo.against` again, so a
  // value-only expiry would keep showing the stale echo forever. A completed
  // `providers.list` fetch (whether or not the value moved) is what must
  // retire it instead, and `dataUpdatedAt` advancing is that fetch's signal.
  it("expires the echo once providers.list refetches, even when the stored value round-trips back to what the echo was made against", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    const { rerender } = render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    // Pick "provider" - echo.against captures the stored value at pick time,
    // "undefined" (Traycer).
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );

    // A refetch lands - `dataUpdatedAt` advances - and the SAME `stored` as
    // before the pick comes back (another window set it back to Traycer,
    // matching `echo.against` again). Value-only expiry cannot see this: it
    // would still read as "the echo's target still matches stored" and keep
    // masking the host's real answer.
    providersUpdatedAt.current = 2_000;
    rerender(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch("Traycer's judge");
  });

  // CONTROL for the case above: without advancing `dataUpdatedAt`, the echo
  // still shows - that is the ordinary round-trip window it exists for, and
  // this is what proves the expiry above is keyed on the refetch landing,
  // not on time or a rerender alone.
  // JOB 4: the SECOND gate - a host that answers the catalog (so
  // `nativeAutoJudge: true`) but does not advertise the write, which the
  // registry itself contemplates via `providers.setAutoJudge`'s
  // `degrade: { kind: "unsupported" }`. This records a manifest that carries
  // some OTHER method and omits the write, which is what a real host that
  // predates the write looks like - `getNegotiatedHostMethods` then returns a
  // set not containing it, i.e. `false`, not `null`.
  it("renders the read-only 'can't change' panel (not the select) when the host answers the catalog but not the write, stored: Traycer's judge", () => {
    // The read half present, the WRITE half absent - which is what this case is
    // about. Without `providers.list@9.1` the section lands on the unreadable
    // panel instead, since it will not present a stored value it cannot read.
    recordNegotiatedHostManifest(HOST_ID, {
      "agent.gui.listHarnesses": { major: 9, minor: 1 },
      "providers.list": { major: 9, minor: 1 },
    });
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    expect(screen.getByText("Who reviews Claude Code's commands")).toBeTruthy();
    const unsupported = screen.getByTestId("provider-auto-judge-unsupported");
    expect(unsupported.textContent).toBe(
      "Traycer's judge. This machine's host can't change it; update it to choose.",
    );
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the provider's own classifier as the stored value on the same unsupported panel", () => {
    // The read half present, the WRITE half absent - which is what this case is
    // about. Without `providers.list@9.1` the section lands on the unreadable
    // panel instead, since it will not present a stored value it cannot read.
    recordNegotiatedHostManifest(HOST_ID, {
      "agent.gui.listHarnesses": { major: 9, minor: 1 },
      "providers.list": { major: 9, minor: 1 },
    });
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: "provider" })}
      />,
    );

    const unsupported = screen.getByTestId("provider-auto-judge-unsupported");
    expect(unsupported.textContent).toContain("Claude Code's classifier");
    expect(unsupported.textContent).toContain("can't change it");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  // JOB 4: the WRITE half present but the READ half stuck at `providers.list@9.0`
  // - the setter is registered, so `useHostMethodSupport` answers `true`, but
  // that line never carries `autoJudge` back. This is the "writable but
  // unreadable" state `providersListReportsAutoJudge` exists to name: showing
  // EITHER label here would be a fabricated echo of a value the section
  // cannot actually read (see `providerAutoJudgeFor`'s `?? "traycer"` guess).
  it("renders the unreadable panel, with no select and no stored-value guess, when the setter is supported but providers.list is stuck at 9.0", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "agent.gui.listHarnesses": { major: 9, minor: 1 },
      "providers.setAutoJudge": { major: 1, minor: 0 },
      "providers.list": { major: 9, minor: 0 },
    });
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: "provider" })}
      />,
    );

    const unreadable = screen.getByTestId("provider-auto-judge-unreadable");
    expect(unreadable.textContent).toBe(
      "This machine's host can't report who reviews Claude Code's commands. Update it to see and change this.",
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    // The important part: no fabricated echo of either possible value,
    // anywhere in the document - not just absent from this panel's own text.
    expect(screen.queryByText("Traycer's judge")).toBeNull();
    expect(screen.queryByText("Claude Code's classifier")).toBeNull();
  });

  // JOB 4: at 9.1 instead, the switch renders as before - existing coverage
  // ("renders the row when nativeAutoJudge is true" and the selected-value
  // cases above), restated here only to pin the boundary against the 9.0 case
  // right beside it.
  it("renders the select (not the unreadable panel) once providers.list reaches 9.1", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "agent.gui.listHarnesses": { major: 9, minor: 1 },
      "providers.setAutoJudge": { major: 1, minor: 0 },
      "providers.list": { major: 9, minor: 1 },
    });
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: "provider" })}
      />,
    );

    expect(screen.queryByTestId("provider-auto-judge-unreadable")).toBeNull();
    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });

  // JOB 4: the "no handshake yet" case must NOT fall back to the read-only
  // line - that line asserts a POSITIVE fact ("this machine's host can't
  // change who reviews..."), which is not known yet with no manifest at all
  // for this host. Falling back would tell the user something the section
  // has no evidence for; rendering nothing is the honest "not yet known" the
  // hook itself distinguishes (`useHostMethodSupport` returns `null`, not
  // `false`, while `false` is what the case above exercises).
  it("says nothing about the switch when there is no handshake at all for this host yet", () => {
    resetNegotiatedManifests();
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("provider-auto-judge-readonly")).toBeNull();
    expect(screen.queryByTestId("provider-auto-judge-unsupported")).toBeNull();
    expect(screen.queryByTestId("provider-auto-judge-unreadable")).toBeNull();
  });

  // JOB 4: the two read-only branches must not be confused with each other.
  // `nativeAutoJudge: false` takes the ORIGINAL "has no classifier of its
  // own" line even when the write is also unsupported - the missing write is
  // irrelevant when there is nothing native to switch to in the first place.
  it("keeps the read-only 'Reviewed by Traycer's judge' line for nativeAutoJudge: false, even when the write is also unsupported", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "agent.gui.listHarnesses": { major: 9, minor: 1 },
    });
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: false })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    const readonly = screen.getByTestId("provider-auto-judge-readonly");
    expect(readonly.textContent).toContain("Reviewed by Traycer's judge");
    expect(screen.queryByTestId("provider-auto-judge-unsupported")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  const CLASSIFIER_WARNING =
    "Faster and free, but your rules don't apply to it, and it replaces Traycer's judge for this provider's conversations.";

  it("shows the classifier-cost warning under the Select for a native provider", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    expect(screen.getByRole("combobox")).toBeTruthy();
    const warning = screen.getByTestId("provider-auto-judge-warning");
    expect(warning.textContent).toBe(CLASSIFIER_WARNING);
  });

  it("omits the classifier-cost warning on the read-only line for a non-native provider", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: false })],
    };

    render(<ProviderAutoJudgeSection state={providerState({})} />);

    expect(screen.getByTestId("provider-auto-judge-readonly")).toBeTruthy();
    expect(screen.queryByTestId("provider-auto-judge-warning")).toBeNull();
  });

  it("omits the classifier-cost warning on the unreadable panel", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "agent.gui.listHarnesses": { major: 9, minor: 1 },
      "providers.setAutoJudge": { major: 1, minor: 0 },
      "providers.list": { major: 9, minor: 0 },
    });
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: "provider" })}
      />,
    );

    expect(screen.getByTestId("provider-auto-judge-unreadable")).toBeTruthy();
    expect(screen.queryByTestId("provider-auto-judge-warning")).toBeNull();
  });

  it("omits the classifier-cost warning on the unsupported panel", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "agent.gui.listHarnesses": { major: 9, minor: 1 },
      "providers.list": { major: 9, minor: 1 },
    });
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    expect(screen.getByTestId("provider-auto-judge-unsupported")).toBeTruthy();
    expect(screen.queryByTestId("provider-auto-judge-warning")).toBeNull();
  });

  it("control: keeps showing the echo across a rerender when providers.list has not refetched", () => {
    guiHarnessesQueryMock.data = {
      harnesses: [harnessRow({ nativeAutoJudge: true })],
    };

    const { rerender } = render(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "Claude Code's classifier" }),
    );

    // Same `providersUpdatedAt.current` (1_000, unchanged) and the same
    // `stored` as before the pick - the ordinary in-flight window.
    rerender(
      <ProviderAutoJudgeSection
        state={providerState({ autoJudge: undefined })}
      />,
    );

    expect(screen.getByRole("combobox").textContent).toMatch(
      "Claude Code's classifier",
    );
  });
});
