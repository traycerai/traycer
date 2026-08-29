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
        message="Boom went the host"
        code="RUNTIME_THROWN"
        recoverable={false}
        findUnitId={null}
        harnessId={null}
      />,
    );

    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("RUNTIME_THROWN")).toBeDefined();
    expect(screen.getByText("Boom went the host")).toBeDefined();
  });

  it("omits the code badge when there is no code", () => {
    render(
      <ErrorSegment
        message="Something failed"
        code={null}
        recoverable={false}
        findUnitId={null}
        harnessId={null}
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
          message="Something failed"
          code={hostileCode}
          recoverable={false}
          findUnitId={null}
          harnessId={null}
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
          message="Boom went the host"
          code="RUNTIME_THROWN"
          recoverable={false}
          findUnitId={null}
          harnessId={null}
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
          message="First failure"
          code="RUNTIME_THROWN"
          recoverable={false}
          findUnitId={null}
          harnessId={null}
        />
      </TooltipProvider>,
    );
    rerender(
      <TooltipProvider>
        <ErrorSegment
          message="Please re-authenticate"
          code="auth"
          recoverable
          findUnitId={null}
          harnessId={null}
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
          message="Boom went the host"
          code="RUNTIME_THROWN"
          recoverable={false}
          findUnitId={null}
          harnessId={null}
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
            message="Boom went the host"
            code="RUNTIME_THROWN"
            recoverable={false}
            findUnitId={null}
            harnessId={null}
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
          message="Please re-authenticate"
          code="auth"
          recoverable
          findUnitId={null}
          harnessId={null}
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
          message={ENV_CREDENTIAL_MESSAGE}
          code="auth_env_credential"
          recoverable={false}
          findUnitId={null}
          harnessId="claude"
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
          message={ENV_CREDENTIAL_MESSAGE}
          code="auth_env_credential"
          recoverable={false}
          findUnitId={null}
          harnessId={null}
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
          message="Boom went the host"
          code="RUNTIME_THROWN"
          recoverable={false}
          findUnitId={null}
          harnessId="claude"
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
          message="Please re-authenticate"
          code="auth"
          recoverable
          findUnitId={null}
          harnessId="claude"
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Manage environment variables" }),
      ).toBeNull();
    });
  });
});
