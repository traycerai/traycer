import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { AutoModeSettingsSection } from "@/components/settings/panels/auto-mode-settings-section";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));

// Whether `autoJudge.get` / `autoPolicy.get` are advertised, toggled per test
// below. Defaults to neither, which is the negative-half suite's own state
// (a host that predates auto mode, or one this window has not handshaken
// with yet) and keeps that suite's assertions accurate without its own mock.
let supportsPolicy: boolean | null = false;
// TRI-STATE now, because the section reads `useHostMethodSupport`: `null` is
// "no handshake with this host yet", which the page must NOT render as
// "predates Auto mode" - it parks every RPC behind that verdict, including the
// one that would overturn it. `false` here keeps every pre-existing case
// meaning what it did: a host that HANDSHOOK and lacks the method.
let judgeSupport: boolean | null = false;
// The WRITE half. Each row is mounted on its `.get` and now gates its control
// on the matching `.set`, which is a separate optional method - per-method
// negotiation means a host can answer one and not the other. Defaults to
// `true` so every pre-existing case keeps meaning what it did (they are about
// the READ gate); the cases about the write set it false.
let supportsWrites = true;

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoPolicy.get" ? supportsPolicy : judgeSupport,
  // The real boolean form is `useHostMethodSupport(...) === true`, so a method
  // this fixture knows nothing about reads as absent here too.
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoJudge.set" || method === "autoPolicy.set"
      ? supportsWrites
      : false,
}));

// The probe exists to produce a handshake while the page is parked on `false`.
// Stubbed to a no-op: what this suite asserts is the SECTION's verdict, and a
// real `useHostQuery` here would need a host runtime it deliberately does not
// stand up.
const capabilityProbeMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  // The parameter RESTATES `useHostCapabilityProbe`'s real props rather than
  // taking `unknown`: this suite asserts on what the section passes, so the
  // shape is the thing under test and a field renamed on the hook should
  // surface here rather than sail through an `unknown`.
  //
  // Block body, not a concise one: `vi.fn()` returns `any`, and returning that
  // from the arrow trips `typescript(no-unsafe-return)` - which oxlint catches
  // and eslint does not. Returning nothing is also the honest shape: the
  // section mounts this hook for the handshake it produces, never for its
  // result.
  useHostCapabilityProbe: (args: {
    readonly client: unknown;
    readonly stale: boolean;
    readonly incarnation: ReadonlyArray<unknown>;
  }) => {
    capabilityProbeMock(args);
  },
}));

// The section re-provides `HostRuntimeContext` off this binding, but nothing
// downstream reads through it: the judge row never mounts (only
// `autoPolicy.get` is ever advertised below) and the policy row's own RPC
// hooks are stubbed outright. A fixed, minimally-typed object is enough to
// clear the section's `binding === null` gate without standing up a real
// `HostClient`.
const scopedHostBindingFixture: { hostId: string | null } = {
  hostId: "host-a",
};
vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => scopedHostBindingFixture,
}));

// The policy row's own read, set per test. `let` at module scope rather than
// inline in the mock factory: `vi.mock` factories are hoisted above imports,
// so this has to be a binding the returned function closes over and reads
// lazily, not a value it captures at declaration time.
let policy: AutoPolicyGetResponse | undefined;

// The row's own regression guard for the stale-edit warning: `openEditor`
// calls `query.refetch()` (never awaited) after capturing `loadedUpdatedAt`,
// so a test that wants to prove the warning can actually fire needs a
// `refetch` it controls - the previous fixture had none, and any test that
// clicked "Edit policy" against it would have thrown. Not resolving a real
// promise here: the component does not await it, so flipping the module-level
// `policy` binding and re-rendering is what stands in for "the refetch
// landed", matching this suite's existing rerender-by-flipping-state style.
const autoPolicyRefetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/auto-mode/use-auto-policy-query", () => ({
  useAutoPolicyQuery: () => ({
    data: policy,
    isError: false,
    refetch: autoPolicyRefetchMock,
  }),
}));
vi.mock("@/hooks/auto-mode/use-auto-policy-set-mutation", () => ({
  useAutoPolicySetMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

// JOB 5: the judge row's own gate. Faked at the query/mutation boundary, same
// shape as the policy hooks above, and `AutoJudgePicker` is faked outright -
// it needs a host client and a harness catalog neither this suite stands up,
// and the fact under test here is the `disabled` prop `AutoJudgeRow` passes
// it, not the picker's own rendering.
vi.mock("@/hooks/auto-mode/use-auto-judge-query", () => ({
  useAutoJudgeQuery: () => ({
    data: { selection: null, effective: undefined, blocked: undefined },
    isError: false,
  }),
}));
vi.mock("@/hooks/auto-mode/use-auto-judge-set-mutation", () => ({
  useAutoJudgeSetMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/settings/panels/auto-judge-picker", () => ({
  AutoJudgePicker: (props: { readonly disabled: boolean }) => (
    <div
      data-testid="auto-judge-picker"
      data-disabled={props.disabled ? "true" : "false"}
    />
  ),
}));

beforeEach(() => {
  supportsPolicy = false;
  judgeSupport = false;
  supportsWrites = true;
  capabilityProbeMock.mockClear();
  policy = undefined;
  autoPolicyRefetchMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("<AutoModeSettingsSection />", () => {
  it("renders nothing when the host advertises neither autoJudge.get nor autoPolicy.get", () => {
    // `supportsPolicy` is false here, which is the state a host that predates
    // auto mode leaves the window in: both methods are optional capabilities
    // with an `unsupported` degrade, so neither is advertised.
    //
    // One thing this case no longer covers, and the loss is deliberate: before
    // `readState`, `useHostSupportsMethod` was left as the REAL hook reading an
    // empty negotiated-manifest registry, so this test incidentally pinned that
    // hook failing closed too. The positive half below needs the answer to vary
    // PER METHOD, so the hook is faked now and what is left here is the
    // SECTION's behaviour alone. The hook's own fail-closed default belongs in
    // its own suite.
    render(<AutoModeSettingsSection />);

    // Not nothing: the section is the whole Permissions page, and an empty
    // page reads as a broken one. One sentence, and no control that would
    // silently do nothing on a host with no notion of auto mode.
    expect(screen.getByTestId("auto-mode-unsupported").textContent).toContain(
      "predates Auto mode",
    );
    expect(screen.queryByTestId("auto-judge-picker")).toBeNull();
    expect(screen.queryByText("Auto mode policy")).toBeNull();
    // The judge row's label as SHIPPED. It was "Auto mode judge" until the
    // Providers panel gained a row of the same name; left at the old string
    // this line kept passing while guarding nothing, since no rendered row
    // could ever have produced it.
    expect(screen.queryByText("Traycer's auto mode judge")).toBeNull();
    expect(screen.queryByText("Auto mode")).toBeNull();
  });

  // JOB 4 (Codex ivFev, P2): the defect. Before this line, "no handshake yet"
  // collapsed into the same false-y read as "handshook and lacks the
  // method", so a scoped host nobody had contacted yet showed "predates Auto
  // mode" - a claim about a host this window has never actually asked.
  it("renders nothing while support for both methods is still unknown (no handshake yet) - not 'predates Auto mode'", () => {
    judgeSupport = null;
    supportsPolicy = null;
    const { container } = render(<AutoModeSettingsSection />);

    expect(screen.queryByTestId("auto-mode-unsupported")).toBeNull();
    expect(screen.queryByTestId("auto-judge-picker")).toBeNull();
    expect(screen.queryByText("Auto mode policy")).toBeNull();
    expect(container.textContent).toBe("");
  });

  // Control for the case above already exists: the suite's very first test
  // renders against the default `judgeSupport = false` / `supportsPolicy =
  // false` (handshook, lacks both methods) and asserts the banner IS shown -
  // proving the section can render a verdict at all, so the null case above
  // is not passing because nothing here ever renders it.

  // The probe is what keeps "renders nothing" refutable rather than a verdict
  // this section could assert with no way to ever overturn it: it is mounted
  // on the SCOPED client (`scope.client`, not some ambient one) and marked
  // `stale` for exactly as long as the page is parked on a `false` verdict for
  // both methods - the incarnation tuple is what re-asks it when the host's
  // reported version or dialability changes.
  it("mounts the capability probe on the scoped client, staled while parked on false", () => {
    judgeSupport = false;
    supportsPolicy = false;
    render(<AutoModeSettingsSection />);

    expect(capabilityProbeMock).toHaveBeenCalledWith({
      client: null,
      stale: true,
      incarnation: ["1.4.2", true],
    });
  });

  describe("when the host advertises autoPolicy.get", () => {
    beforeEach(() => {
      supportsPolicy = true;
    });

    it("on an unreadable read: never claims the policy is unset, disables editing without inviting a write, and names the state", () => {
      policy = {
        body: null,
        updatedAt: null,
        source: "account",
        readState: "unreadable",
        shippedDefaults: "## Allow exceptions\n\n- Something allowed.\n",
      };
      render(<AutoModeSettingsSection />);

      // `body: null` here means "could not look", not "never saved" - the row
      // must not say "Not set", which would assert the opposite.
      expect(screen.queryByText("Not set")).toBeNull();

      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      // Not "Write a policy": that label invites writing over a record this
      // window has not seen. It IS "Edit policy" - what makes Save actually
      // unreachable is the button being disabled, not its label.
      expect(editButton.textContent).not.toBe("Write a policy");
      expect(editButton.textContent).toBe("Edit policy");
      expect(editButton.disabled).toBe(true);

      expect(screen.getByText("Couldn't read your policy")).toBeTruthy();
    });

    // A stale read is the host serving a copy it could not refresh - the
    // body may already be behind another device AND `updatedAt` is
    // withheld, so `autoPolicyChangedSinceLoad` has nothing to compare and
    // the stale warning is structurally unable to fire. Editing from there
    // is a last-write-wins save over a policy this window cannot see, so the
    // button must be disabled here too, not just on `unreadable`.
    it("on a stale read: disables Edit policy even though the body is readable", () => {
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: null,
        source: "account",
        readState: "stale",
      };
      render(<AutoModeSettingsSection />);

      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      expect(editButton.disabled).toBe(true);
    });

    it("on a fresh read with a saved body: shows the saved summary and an enabled Edit policy button", () => {
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "2026-09-10T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      };
      render(<AutoModeSettingsSection />);

      expect(screen.getByText(/^Saved /)).toBeTruthy();

      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      expect(editButton.textContent).toBe("Edit policy");
      expect(editButton.disabled).toBe(false);
    });

    it("shows the shipped-rules row when the response carries a parseable shippedDefaults", () => {
      policy = {
        body: null,
        updatedAt: null,
        source: "account",
        readState: "fresh",
        shippedDefaults:
          "## Allow exceptions\n\n- Read files in the workspace.\n",
      };
      render(<AutoModeSettingsSection />);

      expect(screen.getByTestId("auto-policy-shipped-open")).toBeTruthy();
    });

    it("hides the shipped-rules row when the response carries no shippedDefaults (the older-host case)", () => {
      // Not an empty string - genuinely ABSENT, exactly what an older host's
      // response looks like on the wire (the field rode into `1.0` in place,
      // so nothing else distinguishes that host from this one).
      policy = {
        body: null,
        updatedAt: null,
        source: "account",
      };
      render(<AutoModeSettingsSection />);

      expect(screen.queryByTestId("auto-policy-shipped-open")).toBeNull();
      // And the row above still reads the pre-`readState` behaviour: absent
      // `readState` falls back to `fresh`, and an empty body reads "Not set".
      expect(screen.getByText("Not set")).toBeTruthy();
      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      expect(editButton.textContent).toBe("Write a policy");
      expect(editButton.disabled).toBe(false);
    });

    // Regression guard for `AutoPolicyRow.openEditor` calling
    // `void refetchPolicy()`. Before that line existed, `loadedUpdatedAt`
    // and `currentUpdatedAt` were both read off the same `data` at open, so
    // they were equal by construction and the warning below was
    // unreachable - a window left open while another device saved showed no
    // warning and a save from here silently replaced that version.
    //
    // The `updatedAt` flip lives INSIDE the mocked `refetch`'s own
    // implementation, deliberately - not applied unconditionally after the
    // click. That is what makes this assertion depend on `openEditor` actually
    // calling `refetchPolicy()`: if the line were removed, `refetch` would
    // never run, the flip would never happen, and the rerender below would
    // still show "A" instead of surfacing the warning. A flip applied straight
    // in the test body, independent of the mock being invoked, would pass this
    // assertion even with the production line deleted.
    it("shows the stale-edit warning once a refetch behind the open editor reveals a newer updatedAt", () => {
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "A",
        source: "account",
        readState: "fresh",
      };
      autoPolicyRefetchMock.mockImplementation(() => {
        policy =
          policy === undefined ? undefined : { ...policy, updatedAt: "B" };
        return Promise.resolve();
      });
      const { rerender } = render(<AutoModeSettingsSection />);

      // `openEditor` calls the mocked `refetchPolicy()` synchronously, which
      // is what flips `policy` above - so the warning must not be reachable
      // at all without this click. The component itself never awaits the
      // refetch, so nothing else could have moved `currentUpdatedAt`; the
      // rerender below is what observes the flip the click already made.
      fireEvent.click(screen.getByTestId("auto-policy-edit"));
      rerender(<AutoModeSettingsSection />);

      expect(screen.getByTestId("auto-policy-stale-warning")).toBeTruthy();
    });

    // CONTROL for the case above: without it, a warning that is simply
    // ALWAYS on after a refetch would pass the assertion above for the wrong
    // reason.
    it("control: shows no stale-edit warning when the refetch behind the editor returns the SAME updatedAt", () => {
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "A",
        source: "account",
        readState: "fresh",
      };
      autoPolicyRefetchMock.mockResolvedValue(undefined);
      const { rerender } = render(<AutoModeSettingsSection />);

      fireEvent.click(screen.getByTestId("auto-policy-edit"));

      // Same `policy` reference, so `updatedAt` reads "A" again - the
      // refetch confirmed nothing moved.
      rerender(<AutoModeSettingsSection />);

      expect(screen.queryByTestId("auto-policy-stale-warning")).toBeNull();
    });

    // Regression guard for the `loadedAt === null` side of
    // `autoPolicyChangedSinceLoad`: the editor opened when the account had no
    // saved policy at all, and the refetch behind the click reveals another
    // device has since CREATED one. Saving from here would destroy a record
    // this window never saw, so the warning must fire even though there was
    // no PRIOR `updatedAt` to compare against - the symmetric `null` check
    // this production change replaced treated `null -> timestamp` the same
    // as `null -> null` and let exactly this overwrite through silently.
    it("shows the stale-edit warning when a refetch behind the open editor reveals a policy was CREATED while it was open (loadedAt: null -> a real updatedAt)", () => {
      policy = {
        body: null,
        updatedAt: null,
        source: "account",
        readState: "fresh",
      };
      autoPolicyRefetchMock.mockImplementation(() => {
        policy =
          policy === undefined
            ? undefined
            : {
                ...policy,
                body: "## Environment\nCreated elsewhere.",
                updatedAt: "B",
              };
        return Promise.resolve();
      });
      const { rerender } = render(<AutoModeSettingsSection />);

      fireEvent.click(screen.getByTestId("auto-policy-edit"));
      rerender(<AutoModeSettingsSection />);

      expect(screen.getByTestId("auto-policy-stale-warning")).toBeTruthy();
    });

    // Direct regression guard for the line itself: without
    // `void refetchPolicy();` in `openEditor`, this assertion is the one that
    // catches its removal even in a fixture where the response value never
    // changes.
    it("calls refetch when the editor opens", () => {
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "A",
        source: "account",
        readState: "fresh",
      };
      render(<AutoModeSettingsSection />);

      expect(autoPolicyRefetchMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("auto-policy-edit"));

      expect(autoPolicyRefetchMock).toHaveBeenCalledTimes(1);
    });

    // JOB 3 (Codex, P1): the SAVE-side half of the same defect the two cases
    // above already guard the WARNING side of. `openEditor` opens the dialog
    // on the click and only THEN fires `refetchPolicy()` - so for the one
    // round trip between the click and that read settling, `currentUpdatedAt`
    // still equals the cached `loadedUpdatedAt` and a save would last-write-
    // win over a newer policy from another device. Left unresolved
    // deliberately (`new Promise(() => {})`), so the opening read never
    // settles during this test - the window this case exists to close.
    it("leaves Save disabled while the opening-editor refetch is still in flight", () => {
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "A",
        source: "account",
        readState: "fresh",
      };
      autoPolicyRefetchMock.mockImplementation(() => new Promise(() => {}));
      render(<AutoModeSettingsSection />);

      fireEvent.click(screen.getByTestId("auto-policy-edit"));
      // A typed edit, so `!dirty` alone cannot be what is holding Save down -
      // the opening-read gate has to be doing the work this test is about.
      fireEvent.change(screen.getByTestId("auto-policy-input"), {
        target: { value: "## Environment\nEdited while the read was pending." },
      });

      const saveButton = screen.getByTestId(
        "auto-policy-save",
      ) as HTMLButtonElement;
      expect(saveButton.disabled).toBe(true);
    });

    // The case that proves the gate and the stale-edit warning are the SAME
    // mechanism: once the opening-editor refetch settles with a NEWER
    // `updatedAt`, the dialog both lifts the opening-read gate and reveals
    // the "saved somewhere else" warning - both downstream of the one read
    // `openEditor` fires.
    it("shows the stale warning once the opening-editor refetch resolves with a newer updatedAt", async () => {
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "A",
        source: "account",
        readState: "fresh",
      };
      autoPolicyRefetchMock.mockImplementation(() => {
        policy =
          policy === undefined ? undefined : { ...policy, updatedAt: "B" };
        return Promise.resolve({ isError: false });
      });
      const { rerender } = render(<AutoModeSettingsSection />);

      fireEvent.click(screen.getByTestId("auto-policy-edit"));
      // Let the mocked refetch's promise settle before observing its effect -
      // `openEditor` never awaits it either, so this only flushes the
      // microtask the click already scheduled.
      await waitFor(() => {
        expect(autoPolicyRefetchMock).toHaveBeenCalledTimes(1);
      });
      rerender(<AutoModeSettingsSection />);

      expect(screen.getByTestId("auto-policy-stale-warning")).toBeTruthy();
    });
  });

  // JOB 5: the sibling sweep. Each row is mounted on its `.get` and now gates
  // its CONTROL on the matching `.set` too - a separate optional method, per
  // the same `degrade: { kind: "unsupported" }` shape as every other optional
  // auto-mode RPC.
  describe("the write gate (autoJudge.set / autoPolicy.set)", () => {
    it("disables the judge picker and shows the 'can't change the judge' hint when autoJudge.set is absent", () => {
      judgeSupport = true;
      supportsWrites = false;
      render(<AutoModeSettingsSection />);

      expect(
        screen.getByTestId("auto-judge-picker").getAttribute("data-disabled"),
      ).toBe("true");
      expect(
        screen.getByText(
          "This machine's host can't change the judge. Update it to pick a different one.",
        ),
      ).toBeTruthy();
    });

    it("disables Edit policy and shows the 'can't save a policy' hint when autoPolicy.set is absent", () => {
      supportsPolicy = true;
      supportsWrites = false;
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "2026-09-10T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      };
      render(<AutoModeSettingsSection />);

      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      // A fresh, readable, saved policy would otherwise leave this enabled
      // (see the "on a fresh read with a saved body" case above) - what pins
      // it disabled here is the missing write, not the read state.
      expect(editButton.disabled).toBe(true);
      expect(
        screen.getByText(
          "This machine's host can't save a policy. Update it to write one.",
        ),
      ).toBeTruthy();
    });

    // The control case: with both writes present, neither gate fires. Without
    // this, a `!canWrite` slipped in backwards (always true) would pass the
    // two cases above for the wrong reason.
    it("control: enables both the judge picker and Edit policy when both writes are supported", () => {
      judgeSupport = true;
      supportsPolicy = true;
      supportsWrites = true;
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "2026-09-10T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      };
      render(<AutoModeSettingsSection />);

      expect(
        screen.getByTestId("auto-judge-picker").getAttribute("data-disabled"),
      ).toBe("false");
      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      expect(editButton.disabled).toBe(false);
    });

    // The shipped-rules dialog is a SECOND door into the same editor, gated
    // by `onEditPolicy` on `AutoPolicyShippedDialog`. Before this edit, that
    // gate only checked `unreadable` - not `!canWrite` and not `staleRead` -
    // so either hole let a save-that-cannot-save through the dialog's own
    // "Edit policy" button even though the row's own button correctly
    // refused it.
    it("disables the shipped-rules dialog's Edit policy when autoPolicy.set is absent", () => {
      supportsPolicy = true;
      supportsWrites = false;
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "2026-09-10T00:00:00.000Z",
        source: "account",
        readState: "fresh",
        shippedDefaults: "## Allow exceptions\n\n- Something allowed.\n",
      };
      render(<AutoModeSettingsSection />);

      fireEvent.click(screen.getByTestId("auto-policy-shipped-open"));

      const shippedEditButton = screen.getByTestId(
        "auto-policy-shipped-edit",
      ) as HTMLButtonElement;
      expect(shippedEditButton.disabled).toBe(true);
    });

    // The pre-existing hole this edit closed: the row's OWN button already
    // refused a stale read (see "on a stale read: disables Edit policy"
    // above), but the shipped dialog's second door did not check `staleRead`
    // at all before this change - so a stale read was editable through it.
    it("disables the shipped-rules dialog's Edit policy on a stale read too, even with the write supported", () => {
      supportsPolicy = true;
      supportsWrites = true;
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: null,
        source: "account",
        readState: "stale",
        shippedDefaults: "## Allow exceptions\n\n- Something allowed.\n",
      };
      render(<AutoModeSettingsSection />);

      fireEvent.click(screen.getByTestId("auto-policy-shipped-open"));

      const shippedEditButton = screen.getByTestId(
        "auto-policy-shipped-edit",
      ) as HTMLButtonElement;
      expect(shippedEditButton.disabled).toBe(true);
    });
  });
});
