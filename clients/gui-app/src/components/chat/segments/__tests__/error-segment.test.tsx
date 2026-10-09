import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  knownField,
  setSupportContextSnapshot,
  __resetSupportContextRegistryForTests,
} from "@/lib/support-context-registry";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { ErrorSegment } from "../error-segment";

describe("<ErrorSegment />", () => {
  afterEach(() => {
    cleanup();
    useDesktopDialogStore.getState().close();
    useDesktopDialogStore.setState({ reportIssueAvailable: false });
    __resetSupportContextRegistryForTests();
  });

  // Every error - auth included - renders through this component as the
  // failure's durable transcript record. This is the static chrome shared by
  // all codes: the "Error" overline, the code badge, and the message.
  it("renders the error chrome with the code badge and message", () => {
    render(
      <ErrorSegment
        turnId={null}
        message="Boom went the host"
        code="RUNTIME_THROWN"
        recoverable={false}
        findUnitId={null}
        harnessId={null}
        failure={null}
        settledNotice={null}
        settledNoticeFindUnitId={null}
      />,
    );

    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("RUNTIME_THROWN")).toBeDefined();
    expect(screen.getByText("Boom went the host")).toBeDefined();
  });

  it("omits the code badge when there is no code", () => {
    render(
      <ErrorSegment
        turnId={null}
        message="Something failed"
        code={null}
        recoverable={false}
        findUnitId={null}
        harnessId={null}
        failure={null}
        settledNotice={null}
        settledNoticeFindUnitId={null}
      />,
    );

    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("Something failed")).toBeDefined();
  });

  it("does not copy a hostile transcript code into public report context", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const hostileCode = "/Users/alice/private.txt?token=sk-secret";

    render(
      <TooltipProvider>
        <ErrorSegment
          turnId={null}
          message="Something failed"
          code={hostileCode}
          recoverable={false}
          findUnitId={null}
          harnessId={null}
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText(hostileCode)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Agent error",
      message: null,
      code: null,
      source: "Chat",
    });
  });

  // The public prefill stays null-bodied (host/harness free text is not
  // redacted there); the transcript message/code reach only the private
  // diagnostics branch so support can still cluster the real failure.
  it("carries the transcript message and code in private diagnostics only", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const draftIdBefore = useDesktopDialogStore.getState().reportIssueDraftId;

    render(
      <TooltipProvider>
        <ErrorSegment
          turnId={null}
          message="Boom went the host"
          code="RUNTIME_THROWN"
          recoverable={false}
          findUnitId={null}
          harnessId={null}
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    const state = useDesktopDialogStore.getState();
    expect(state.reportIssueContext).toEqual({
      title: "Agent error",
      message: null,
      code: null,
      source: "Chat",
    });
    expect(state.reportIssueDraftId).toBe(draftIdBefore + 1);
    const cause = state.reportIssueDraftContext?.privateDiagnostics.cause;
    expect(cause).toEqual(
      expect.objectContaining({
        type: "AgentError",
        message: "Boom went the host",
        errorCode: "RUNTIME_THROWN",
        sourceAction: "agent-turn",
        stack: null,
        componentStack: null,
      }),
    );
    expect(
      state.reportIssueDraftContext?.privateDiagnostics.fingerprint,
    ).toMatch(/^fp:v1:/);
  });

  // The runtime accumulator can replace a same-blockId error's fields while
  // the row stays mounted (blockId is the React key), so the report draft
  // must follow the props, not freeze at mount.
  it("reports the updated cause after a mounted row's error is replaced", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    const { rerender } = render(
      <TooltipProvider>
        <ErrorSegment
          turnId={null}
          message="First failure"
          code="RUNTIME_THROWN"
          recoverable={false}
          findUnitId={null}
          harnessId={null}
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />
      </TooltipProvider>,
    );
    rerender(
      <TooltipProvider>
        <ErrorSegment
          turnId={null}
          message="Please re-authenticate"
          code="auth"
          recoverable
          findUnitId={null}
          harnessId={null}
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    const cause =
      useDesktopDialogStore.getState().reportIssueDraftContext
        ?.privateDiagnostics.cause;
    expect(cause).toEqual(
      expect.objectContaining({
        type: "AgentErrorRecoverable",
        message: "Please re-authenticate",
        errorCode: "auth",
      }),
    );
  });

  // This row is durable transcript, so it mounts on chat-open - BEFORE
  // `SupportContextRegistryBridge`'s effects publish the chat/harness it
  // belongs to. Building the draft at render froze the previously-open chat
  // into the private diagnostics, and (because the harness id is the
  // fingerprint's `causalProvider`) clustered the report under the wrong
  // provider too. The draft must be built from the click.
  it("captures support context at report time, not at row mount", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    // What the bridge had published when the row mounted: the chat the user
    // was looking at a moment ago.
    setSupportContextSnapshot({
      chatId: knownField("chat-previously-open"),
      harnessId: knownField("codex"),
    });

    render(
      <TooltipProvider>
        <ErrorSegment
          turnId={null}
          message="Boom went the host"
          code="RUNTIME_THROWN"
          recoverable={false}
          findUnitId={null}
          harnessId={null}
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />
      </TooltipProvider>,
    );

    // The bridge's effects land after that commit and name this row's chat.
    setSupportContextSnapshot({
      chatId: knownField("chat-this-row-belongs-to"),
      harnessId: knownField("claude"),
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    const diagnostics =
      useDesktopDialogStore.getState().reportIssueDraftContext
        ?.privateDiagnostics;
    expect(diagnostics?.registry.chatId).toEqual(
      knownField("chat-this-row-belongs-to"),
    );
    expect(diagnostics?.registry.harnessId).toEqual(knownField("claude"));
    // The fingerprint is derived from the same snapshot, so a stale read
    // misfiles the report's cluster as well as its labels: the two harnesses
    // must not produce the same fingerprint.
    expect(diagnostics?.fingerprint).toMatch(/^fp:v1:/);
    const fingerprintUnderStaleHarness = (() => {
      __resetSupportContextRegistryForTests();
      setSupportContextSnapshot({ harnessId: knownField("codex") });
      cleanup();
      render(
        <TooltipProvider>
          <ErrorSegment
            turnId={null}
            message="Boom went the host"
            code="RUNTIME_THROWN"
            recoverable={false}
            findUnitId={null}
            harnessId={null}
            failure={null}
            settledNotice={null}
            settledNoticeFindUnitId={null}
          />
        </TooltipProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
      return useDesktopDialogStore.getState().reportIssueDraftContext
        ?.privateDiagnostics.fingerprint;
    })();
    expect(diagnostics?.fingerprint).not.toBe(fingerprintUnderStaleHarness);
  });

  it("marks a recoverable agent error with the AgentErrorRecoverable type", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    render(
      <TooltipProvider>
        <ErrorSegment
          turnId={null}
          message="Please re-authenticate"
          code="auth"
          recoverable
          findUnitId={null}
          harnessId={null}
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    const cause =
      useDesktopDialogStore.getState().reportIssueDraftContext
        ?.privateDiagnostics.cause;
    expect(cause).toEqual(
      expect.objectContaining({
        type: "AgentErrorRecoverable",
        message: "Please re-authenticate",
        errorCode: "auth",
        sourceAction: "agent-turn",
      }),
    );
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Agent error",
      message: null,
      code: null,
      source: "Chat",
    });
  });
  describe("settled routing row report", () => {
    const settledNotice = {
      title: "Routing stopped",
      message: "Every account said no.",
      details: [{ label: "Tried", value: "2 accounts" }],
      receipt: {
        causeLabel: "Rate limit reached",
        steps: [
          {
            kind: "switch" as const,
            providerLabel: "Claude Code",
            modelLabel: "claude-sonnet-4",
            profileLabel: "Work",
            resumedAt: null,
            endedLabel: "rate limited",
          },
        ],
      },
    };

    it("appends the routing rows to the private cause message, never to the public prefill", () => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
      const hostileCode = "/Users/alice/private.txt?token=sk-secret";

      render(
        <TooltipProvider>
          <ErrorSegment
            turnId={null}
            message="Rate limited."
            code={hostileCode}
            recoverable={false}
            findUnitId={null}
            harnessId={null}
            failure={null}
            settledNotice={settledNotice}
            settledNoticeFindUnitId={null}
          />
        </TooltipProvider>,
      );

      expect(screen.getByTestId("routing-settled-card")).toBeDefined();
      expect(
        screen.queryByRole("button", { name: "Details for a bug report" }),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
      const state = useDesktopDialogStore.getState();
      expect(state.reportIssueContext).toEqual({
        title: "Agent error",
        message: null,
        code: null,
        source: "Chat",
      });
      const cause = state.reportIssueDraftContext?.privateDiagnostics.cause;
      expect(cause?.message).toBe(
        [
          "Rate limited.",
          "",
          "Routing: Routing stopped",
          "Every account said no.",
          "Cause: Rate limit reached",
          "Step 1: switch · Claude Code · claude-sonnet-4 · Work · ended: rate limited",
          "Tried: 2 accounts",
        ].join("\n"),
      );
      // Nothing of the notice reaches the public side.
      const publicSide = JSON.stringify(state.reportIssueContext);
      expect(publicSide).not.toContain("Routing stopped");
      expect(publicSide).not.toContain("2 accounts");
      expect(publicSide).not.toContain(hostileCode);
    });

    it("leaves a plain row's cause message exactly the error message", () => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });

      render(
        <TooltipProvider>
          <ErrorSegment
            turnId={null}
            message="Rate limited."
            code={null}
            recoverable={false}
            findUnitId={null}
            harnessId={null}
            failure={null}
            settledNotice={null}
            settledNoticeFindUnitId={null}
          />
        </TooltipProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
      const cause =
        useDesktopDialogStore.getState().reportIssueDraftContext
          ?.privateDiagnostics.cause;
      expect(cause?.message).toBe("Rate limited.");
    });
  });

  // The env-credential disclosure row's remedy. The message names the variable;
  // this is the affordance that gets the user to the place it can be unset.
  describe("env-credential auth failures", () => {
    const ENV_CREDENTIAL_MESSAGE =
      "This agent authenticated with `ANTHROPIC_API_KEY` from your shell " +
      'environment — your "Terminal account" sign-in was bypassed.';

    afterEach(() => {
      useProvidersFocusStore.getState().clearFocusHarnessId();
      useProvidersFocusStore.getState().clearFocusTab();
    });

    it("deep-links to the turn's own provider Env tab", () => {
      render(
        <ErrorSegment
          turnId={null}
          message={ENV_CREDENTIAL_MESSAGE}
          code="auth_env_credential"
          recoverable={false}
          findUnitId={null}
          harnessId="claude"
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Manage environment variables" }),
      );

      // Both halves matter: the provider that actually failed, and the tab that
      // holds the unset control. Landing on Providers alone would leave the user
      // hunting through ~16 providers for a tab they have never opened.
      const focus = useProvidersFocusStore.getState();
      expect(focus.focusHarnessId).toBe("claude");
      expect(focus.focusTab).toBe("env");
    });

    it("still offers the affordance when the turn's harness is unknown", () => {
      // A legacy row carries no turn metadata. The button must not vanish - the
      // Providers section root is still far closer than nothing - but it must
      // not name an arbitrary provider either.
      render(
        <ErrorSegment
          turnId={null}
          message={ENV_CREDENTIAL_MESSAGE}
          code="auth_env_credential"
          recoverable={false}
          findUnitId={null}
          harnessId={null}
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Manage environment variables" }),
      );

      expect(useProvidersFocusStore.getState().focusHarnessId).toBeNull();
      expect(useProvidersFocusStore.getState().focusTab).toBeNull();
    });

    it("does not offer it on an ordinary error", () => {
      render(
        <ErrorSegment
          turnId={null}
          message="Boom went the host"
          code="RUNTIME_THROWN"
          recoverable={false}
          findUnitId={null}
          harnessId="claude"
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Manage environment variables" }),
      ).toBeNull();
    });

    it("does not offer it on the recoverable auth row, whose remedy is signing in", () => {
      // `auth` and `auth_env_credential` are deliberately different codes: this
      // one IS fixed by reconnecting, and pointing at env settings would send
      // the user to a page with nothing to change.
      render(
        <ErrorSegment
          turnId={null}
          message="Please re-authenticate"
          code="auth"
          recoverable
          findUnitId={null}
          harnessId="claude"
          failure={null}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Manage environment variables" }),
      ).toBeNull();
    });
  });
});

// A turn ended because its sandbox froze for lack of credits is an
// interruption with the sandbox's own words, not a red error carrying the
// host's raw `SANDBOX_FROZEN: sandbox host '...'` message.
describe("<ErrorSegment /> sandbox refusals", () => {
  afterEach(cleanup);

  const RAW_MESSAGE =
    "SANDBOX_FROZEN: sandbox host 'build-box': frozen, out of credits";

  function renderRow(input: {
    readonly code: string | null;
    readonly message: string;
  }): HTMLElement {
    const { container } = render(
      <ErrorSegment
        turnId={null}
        message={input.message}
        code={input.code}
        recoverable={false}
        findUnitId={null}
        harnessId="traycer"
        failure={null}
        settledNotice={null}
        settledNoticeFindUnitId={null}
      />,
    );
    const root = container.querySelector("[data-failure-presentation]");
    if (!(root instanceof HTMLElement)) {
      throw new Error("the error row did not render");
    }
    return root;
  }

  it("renders SANDBOX_FROZEN in the interrupted presentation with the frozen copy", () => {
    const root = renderRow({ code: "SANDBOX_FROZEN", message: RAW_MESSAGE });

    expect(root.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(root.getAttribute("data-sandbox-refusal")).toBe("true");
    expect(screen.getByText("Paused: account out of credits")).toBeDefined();
    expect(screen.getByText(/froze when your credits ran out/)).toBeDefined();
    // The host's raw sentence is replaced, not shown beside the copy.
    expect(screen.queryByText(RAW_MESSAGE)).toBeNull();
    expect(screen.queryByText("Error")).toBeNull();
  });

  it("recognises the same turn from the message prefix when the block has no code", () => {
    const root = renderRow({ code: null, message: RAW_MESSAGE });

    expect(root.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(root.getAttribute("data-sandbox-refusal")).toBe("true");
    expect(screen.getByText("Paused: account out of credits")).toBeDefined();
  });

  it("leaves any other error as the red error row with its own message", () => {
    const root = renderRow({
      code: "RUNTIME_THROWN",
      message: "SANDBOX_FROZEN: quoted by an unrelated failure",
    });

    expect(root.getAttribute("data-failure-presentation")).toBe("error");
    expect(root.hasAttribute("data-sandbox-refusal")).toBe(false);
    expect(
      screen.getByText("SANDBOX_FROZEN: quoted by an unrelated failure"),
    ).toBeDefined();
    expect(screen.queryByText("Paused: account out of credits")).toBeNull();
  });

  it("renders SANDBOX_GUEST_NOT_CONFIGURED as an interruption with the setup copy and the host's last status under it", () => {
    const root = renderRow({
      code: "SANDBOX_GUEST_NOT_CONFIGURED",
      message:
        "SANDBOX_GUEST_NOT_CONFIGURED: sandbox host 'build-box': guest setup stopped at step 3 of 5",
    });

    expect(root.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(root.getAttribute("data-sandbox-refusal")).toBe("true");
    expect(
      screen.getByText("Waiting for this sandbox's setup to finish"),
    ).toBeDefined();
    expect(screen.getByText(/still being set up/)).toBeDefined();
    const detail = screen.getByTestId("sandbox-refusal-host-detail");
    expect(detail.textContent).toBe(
      "Last setup status: sandbox host 'build-box': guest setup stopped at step 3 of 5",
    );
    // The raw `CODE:` sentence is replaced, not shown beside the copy.
    expect(screen.queryByText(/^SANDBOX_GUEST_NOT_CONFIGURED/)).toBeNull();
    expect(screen.queryByText("Error")).toBeNull();
  });

  it("recognises SANDBOX_GUEST_NOT_CONFIGURED from the message prefix and still shows the detail", () => {
    const root = renderRow({
      code: null,
      message: "SANDBOX_GUEST_NOT_CONFIGURED: guest setup is queued",
    });

    expect(root.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(screen.getByTestId("sandbox-refusal-host-detail").textContent).toBe(
      "Last setup status: guest setup is queued",
    );
  });

  it("omits the detail line when the host sent nothing past the code", () => {
    const root = renderRow({
      code: "SANDBOX_GUEST_NOT_CONFIGURED",
      message: "SANDBOX_GUEST_NOT_CONFIGURED:",
    });

    expect(root.getAttribute("data-sandbox-refusal")).toBe("true");
    expect(
      screen.getByText("Waiting for this sandbox's setup to finish"),
    ).toBeDefined();
    expect(screen.queryByTestId("sandbox-refusal-host-detail")).toBeNull();
  });

  it("renders SANDBOX_HOST_REFUSES_CREDENTIALS as an interruption with no detail line", () => {
    const root = renderRow({
      code: "SANDBOX_HOST_REFUSES_CREDENTIALS",
      message:
        "SANDBOX_HOST_REFUSES_CREDENTIALS: sandbox host 'build-box': refuses a provider key",
    });

    expect(root.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(root.getAttribute("data-sandbox-refusal")).toBe("true");
    expect(screen.getByText("Sandboxes don't take sign-ins")).toBeDefined();
    expect(screen.getByText(/never holds your credentials/)).toBeDefined();
    expect(screen.queryByTestId("sandbox-refusal-host-detail")).toBeNull();
    expect(screen.queryByText(/refuses a provider key/)).toBeNull();
  });

  it("shows no detail line on the frozen copy", () => {
    renderRow({ code: "SANDBOX_FROZEN", message: RAW_MESSAGE });

    expect(screen.queryByTestId("sandbox-refusal-host-detail")).toBeNull();
  });
});
