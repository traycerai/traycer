import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ReactNode } from "react";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { AssistantMessageBody } from "@/components/chat/chat-message-assistant-body";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatMessageTimeWithSeconds } from "@/lib/relative-time";
import type {
  AssistantTurnMeta,
  ChatMessageRunState,
  ChatMessageStoppedInfo,
  MessageSegment,
} from "@/stores/composer/chat-store";

function render(ui: ReactNode) {
  return rtlRender(
    <TooltipProvider delayDuration={0}>
      <ChatExpansionTestProviders tileInstanceId="assistant-body-test-tile">
        {ui}
      </ChatExpansionTestProviders>
    </TooltipProvider>,
  );
}

let restoreClipboardMock = () => undefined;

afterEach(() => {
  restoreClipboardMock();
  restoreClipboardMock = () => undefined;
  cleanup();
});

interface ClipboardMock {
  readonly writeText: Mock<(value: string) => Promise<void>>;
}

function installClipboardMock(): ClipboardMock {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn((_value: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { writeText },
  });
  restoreClipboardMock = () => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
      return;
    }
    Object.defineProperty(navigator, "clipboard", descriptor);
  };
  return { writeText };
}

const TEXT_SEGMENT: MessageSegment = {
  id: "seg-1",
  kind: "text",
  markdown: "Here is the answer.",
  isStreaming: false,
};

const AUTONOMOUS_RESUME_SEGMENT: MessageSegment = {
  id: "seg-resume",
  kind: "autonomous_resume",
  triggers: [
    {
      kind: "monitor",
      title: "build watch",
      status: "completed",
      live: false,
      summary: "Build completed.",
      blockId: "monitor-1",
      outputFile: null,
      mcp: null,
      managedCommand: null,
    },
  ],
};

const ERROR_SEGMENT: MessageSegment = {
  id: "seg-2",
  kind: "error",
  message: "The provider stream ended unexpectedly.",
  recoverable: true,
  code: "PROVIDER_STREAM_ERROR",
};

const STOPPED: ChatMessageStoppedInfo = {
  stoppedAt: 1_700_000_000_000,
  reason: "Stop requested by owner.",
  turnHadOutput: true,
  turnReplySegments: [
    {
      id: "seg-reply",
      kind: "text",
      markdown: "Here is the answer.",
      isStreaming: false,
    },
  ],
};

// A content-less boundary row whose turn genuinely never produced anything -
// the only shape that should render "Stopped before responding".
const STOPPED_NO_OUTPUT: ChatMessageStoppedInfo = {
  ...STOPPED,
  turnHadOutput: false,
  turnReplySegments: [],
};

const META: AssistantTurnMeta = {
  provider: "claude",
  providerLabel: "Claude Code",
  profileLabel: "Work",
  modelLabel: "Claude Sonnet 4",
  reasoningEffort: "high",
  reasoningEffortLabel: "High",
  serviceTier: null,
  envCredentialVar: null,
  costUsd: null,
};

interface BodyPropsOverrides {
  readonly segments?: ReadonlyArray<MessageSegment>;
  readonly runState?: ChatMessageRunState | null;
  readonly elapsedStartedAt?: number;
  readonly turnHasOnlyAutonomousResumeSegments?: boolean;
  readonly showCompletionFooter?: boolean;
  readonly completedAt?: number | null;
  readonly stopped?: ChatMessageStoppedInfo | null;
  readonly meta?: AssistantTurnMeta | null;
}

function bodyProps(overrides: BodyPropsOverrides) {
  return {
    segments: overrides.segments ?? [],
    backgroundToolBlockIds: new Set<string>(),
    runState: overrides.runState ?? null,
    messageId: "assistant:turn-1",
    elapsedStartedAt: overrides.elapsedStartedAt ?? 0,
    turnHasOnlyAutonomousResumeSegments:
      overrides.turnHasOnlyAutonomousResumeSegments ?? false,
    showCompletionFooter: overrides.showCompletionFooter ?? true,
    pausedDurationMs: 0,
    pausedSinceMs: null,
    completedAt: overrides.completedAt ?? null,
    stopped: overrides.stopped ?? null,
    meta: overrides.meta ?? null,
    nextStepActions: null,
    forkAction: null,
    interviewDeliveryRetry: null,
  };
}

describe("AssistantMessageBody autonomous resume rendering", () => {
  it("does not render an elapsed footer for an autonomous-resume notification without completion", () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [AUTONOMOUS_RESUME_SEGMENT],
          turnHasOnlyAutonomousResumeSegments: true,
          showCompletionFooter: false,
          completedAt: 8_000,
        })}
      />,
    );

    expect(screen.queryByTestId("assistant-elapsed-footer")).toBeNull();
  });

  it('renders "Resumed · no response · {elapsed}" for a completed silent autonomous resume', () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [AUTONOMOUS_RESUME_SEGMENT],
          elapsedStartedAt: 3_000,
          turnHasOnlyAutonomousResumeSegments: true,
          completedAt: 8_000,
        })}
      />,
    );

    expect(screen.getByTestId("assistant-elapsed-footer").textContent).toBe(
      "Resumed · no response · 5s",
    );
  });

  it("does not infer a silent resume from one autonomous-resume-only slice", () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [AUTONOMOUS_RESUME_SEGMENT],
          elapsedStartedAt: 3_000,
          turnHasOnlyAutonomousResumeSegments: false,
          completedAt: 8_000,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    expect(footer.textContent).toMatch(/ for 5s$/);
    expect(footer.textContent).not.toContain("Resumed · no response");
  });
});

describe("AssistantMessageBody stopped turn rendering", () => {
  it('renders "Stopped · {elapsed}" with the stop glyph, not the natural-completion verb', () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          stopped: STOPPED,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    expect(footer.textContent).toBe("Stopped · 5s");
    expect(
      footer.querySelector('[data-testid="assistant-stop-badge"]'),
    ).not.toBeNull();
    expect(footer.querySelector("svg.lucide-sparkles")).toBeNull();
    expect(footer.querySelector("span.text-destructive")?.textContent).toBe(
      "Stopped",
    );
  });

  it('renders the natural "worked for" copy with no stop glyph when the turn was not stopped', () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          stopped: null,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    expect(footer.textContent).toMatch(/ for 5s$/);
    expect(footer.textContent).not.toMatch(/^Stopped/);
    expect(
      footer.querySelector('[data-testid="assistant-stop-badge"]'),
    ).toBeNull();
    expect(footer.querySelector("span.text-destructive")).toBeNull();
  });

  it("keeps the reply copy control alongside the stopped footer", () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          stopped: STOPPED,
        })}
      />,
    );

    expect(screen.getByTestId("assistant-elapsed-footer")).not.toBeNull();
    expect(screen.getByTestId("assistant-reply-copy")).not.toBeNull();
  });

  it('renders "Stopped before responding" instead of nothing for a turn that never produced output', () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [],
          runState: null,
          stopped: STOPPED_NO_OUTPUT,
        })}
      />,
    );

    const note = screen.getByTestId("assistant-stopped-before-responding");
    expect(note.textContent).toBe("Stopped before responding");
    expect(
      note.querySelector('[data-testid="assistant-stop-badge"]'),
    ).not.toBeNull();
    expect(note.classList.contains("text-destructive")).toBe(true);
  });

  it("retains the resume notification alongside an unstarted stop boundary", () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [AUTONOMOUS_RESUME_SEGMENT],
          turnHasOnlyAutonomousResumeSegments: true,
          completedAt: 5_000,
          stopped: STOPPED_NO_OUTPUT,
        })}
      />,
    );

    expect(
      screen.getByTestId("assistant-stopped-before-responding").textContent,
    ).toBe("Stopped before responding");
    expect(screen.getByText("Monitor completed")).not.toBeNull();
    expect(screen.getByText("Build completed.")).not.toBeNull();
    expect(screen.queryByTestId("assistant-elapsed-footer")).toBeNull();
  });

  it('renders the full "Stopped · {elapsed}" footer, not "Stopped before responding", on a content-less boundary row whose turn DID produce output elsewhere', () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [],
          runState: null,
          elapsedStartedAt: 0,
          completedAt: 5_000,
          stopped: STOPPED,
        })}
      />,
    );

    expect(
      screen.queryByTestId("assistant-stopped-before-responding"),
    ).toBeNull();
    const footer = screen.getByTestId("assistant-elapsed-footer");
    expect(footer.textContent).toBe("Stopped · 5s");
  });

  it("restores the copy control on a content-less boundary row, copying the turn's reply text even though this row's own segments are empty", () => {
    const clipboard = installClipboardMock();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [],
          runState: null,
          elapsedStartedAt: 0,
          completedAt: 5_000,
          stopped: STOPPED,
        })}
      />,
    );

    const copyButton = screen.getByTestId("assistant-reply-copy");
    fireEvent.click(copyButton);
    expect(clipboard.writeText).toHaveBeenCalledWith("Here is the answer.");
  });

  it("renders nothing for an empty, non-stopped, ended turn (unchanged baseline)", () => {
    const { container } = render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [],
          runState: null,
          stopped: null,
        })}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("shows the elapsed footer even when the turn's last segment is an error, once the turn is marked stopped", () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT, ERROR_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          stopped: STOPPED,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    expect(footer.textContent).toBe("Stopped · 5s");
  });

  it("keeps the error-ending footer suppressed when the same turn was not stopped (override does not leak)", () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT, ERROR_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          stopped: null,
        })}
      />,
    );

    expect(screen.queryByTestId("assistant-elapsed-footer")).toBeNull();
  });

  it("surfaces the stop reason and time in the elapsed footer's tooltip", async () => {
    const user = userEvent.setup();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          stopped: STOPPED,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    await user.tab();
    expect(document.activeElement).toBe(footer);

    // Radix renders the open tooltip's content twice - once positioned via
    // the popper portal, once as a visually-hidden accessibility clone - so
    // assert presence via `getAllByText` rather than the single-match query.
    await waitFor(() => {
      expect(
        screen.getAllByText("Stop requested by owner.").length,
      ).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
  });

  it("shows the turn's profile snapshot in the elapsed footer tooltip", async () => {
    const user = userEvent.setup();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          meta: META,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    await user.tab();
    expect(document.activeElement).toBe(footer);

    await waitFor(() => {
      expect(screen.getAllByText("Profile").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
  });

  // Ground truth for "what actually ran this turn". The profile label alone
  // answers that WRONG when a shell env credential outranked the sign-in, which
  // is exactly the state that made the original incident unreadable.
  it("annotates the profile row when an env credential bypassed the sign-in", async () => {
    const user = userEvent.setup();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          meta: {
            ...META,
            profileLabel: "Terminal account",
            envCredentialVar: "ANTHROPIC_API_KEY",
          },
        })}
      />,
    );

    const footer = screen.getByRole("button", { name: /for 5s/ });
    await user.tab();
    expect(document.activeElement).toBe(footer);

    await waitFor(() => {
      expect(screen.getAllByText("Profile").length).toBeGreaterThan(0);
    });
    // Annotated IN PLACE, not as a separate row: a reader who skims one line
    // still gets the true answer rather than the label's wrong one.
    expect(
      screen.getAllByText(
        "Terminal account (bypassed — env: ANTHROPIC_API_KEY)",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Terminal account")).toBeNull();
  });

  it("leaves the profile row bare when the sign-in was used", async () => {
    // Absence of the bracket is itself a claim - "the profile sign-in ran this"
    // - so a normal turn must not grow a badge, or the annotation above stops
    // meaning anything.
    const user = userEvent.setup();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          meta: { ...META, envCredentialVar: null },
        })}
      />,
    );

    const footer = screen.getByRole("button", { name: /for 5s/ });
    await user.tab();
    expect(document.activeElement).toBe(footer);

    await waitFor(() => {
      expect(screen.getAllByText("Profile").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
    expect(screen.queryByText(/bypassed/)).toBeNull();
  });

  // Regression: the Profile row used to be gated on `profileLabel` alone, so a
  // turn with no resolvable anchor label dropped the row entirely - taking the
  // credential disclosure with it, on exactly the turns least able to explain
  // themselves.
  it("still discloses the credential when the turn has no profile label", async () => {
    const user = userEvent.setup();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: 0,
          completedAt: 5_000,
          meta: {
            ...META,
            profileLabel: null,
            envCredentialVar: "ANTHROPIC_API_KEY",
          },
        })}
      />,
    );

    const footer = screen.getByRole("button", { name: /for 5s/ });
    await user.tab();
    expect(document.activeElement).toBe(footer);

    await waitFor(() => {
      expect(screen.getAllByText("Profile").length).toBeGreaterThan(0);
    });
    // States the credential directly rather than prefixing an empty label.
    expect(
      screen.getAllByText("env: ANTHROPIC_API_KEY (sign-in bypassed)").length,
    ).toBeGreaterThan(0);
  });
});

describe("AssistantMessageBody Timing tooltip section", () => {
  // Started/completed timestamps are taken relative to `Date.now()` at test
  // time (not a fixed epoch) so the day-scoping rule always resolves to "same
  // day" regardless of when this suite runs, and the expected string is
  // derived with `formatMessageTimeWithSeconds` (the exact function the
  // source calls) rather than a hard-coded literal - per the "no pinned
  // TZ/locale" trap.

  it("shows Started and Finished rows on a naturally completed turn's tooltip, and no Stopped section", async () => {
    const user = userEvent.setup();
    const startedAt = Date.now() - 130_000;
    const completedAt = Date.now();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: startedAt,
          completedAt,
          meta: META,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    await user.tab();
    expect(document.activeElement).toBe(footer);

    await waitFor(() => {
      expect(screen.getAllByText("Started").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Finished").length).toBeGreaterThan(0);

    const now = Date.now();
    const expectedStarted = formatMessageTimeWithSeconds(startedAt, now);
    const expectedFinished = formatMessageTimeWithSeconds(completedAt, now);
    expect(screen.getAllByText(expectedStarted).length).toBeGreaterThan(0);
    expect(screen.getAllByText(expectedFinished).length).toBeGreaterThan(0);

    // Positive/negative pairing for the stopped-turn test below: a naturally
    // finished turn carries no "Stopped" section at all.
    expect(screen.queryByText("Stopped at")).toBeNull();
  });

  // The live pre-turn run indicator's `createdAt` is a synthetic sort anchor,
  // not a real send time (it can be epoch+1 on an empty transcript), so its
  // tooltip is wired with `startedAt={null}` and the whole Timing section is
  // gated on `startedAt !== null`. Paired with the test above: same
  // `meta: META`, reached through `AssistantRunIndicator` instead of the
  // elapsed footer. The Agent section is the positive arm proving the
  // tooltip really did mount - Timing's absence is a deliberate gate, not a
  // failure to open.
  it("shows no Timing section at all on the live pre-turn run indicator's hover card", async () => {
    const user = userEvent.setup();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [],
          runState: "running",
          elapsedStartedAt: Date.now() - 45_000,
          meta: META,
        })}
      />,
    );

    const indicator = screen.getByTestId("assistant-run-indicator");
    await user.hover(indicator);

    await waitFor(() => {
      expect(screen.getAllByText("Agent").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Timing")).toBeNull();
    expect(screen.queryByText("Started")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  // A stopped turn's `completedAt` is resolved to the stop instant itself
  // (`assistantTurnTiming`'s `stoppedAt ?? persisted`), so the tooltip prints
  // "Stopped at" INSTEAD OF "Finished" - not both - or the reader would see
  // one instant twice under two labels. Positive arm for "Finished" is the
  // naturally-completed test above; this one, with `stopped` flipped on,
  // must not show it.
  it('shows "Stopped at" in place of "Finished" on a stopped turn\'s tooltip, never the old "Time" label', async () => {
    const user = userEvent.setup();
    const startedAt = Date.now() - 60_000;
    const completedAt = Date.now();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: startedAt,
          completedAt,
          stopped: STOPPED,
          meta: META,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    await user.tab();
    expect(document.activeElement).toBe(footer);

    await waitFor(() => {
      expect(screen.getAllByText("Stopped at").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Time")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();

    const now = Date.now();
    const expectedStoppedAt = formatMessageTimeWithSeconds(
      STOPPED.stoppedAt,
      now,
    );
    expect(screen.getAllByText(expectedStoppedAt).length).toBeGreaterThan(0);
  });

  // Paired with the test above: same stopped turn, one field flipped
  // (`reason: null`). The dedicated "Stopped" section header exists only to
  // carry the reason, so with no reason to show it must not render at all -
  // "Stopped at" already said everything the stop knows, up in Timing.
  it("omits the dedicated Stopped section header when a stopped turn carries no reason", async () => {
    const user = userEvent.setup();
    const stoppedNoReason: ChatMessageStoppedInfo = {
      ...STOPPED,
      reason: null,
    };
    const startedAt = Date.now() - 60_000;
    const completedAt = Date.now();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: startedAt,
          completedAt,
          stopped: stoppedNoReason,
          meta: META,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    await user.tab();
    expect(document.activeElement).toBe(footer);

    await waitFor(() => {
      expect(screen.getAllByText("Stopped at").length).toBeGreaterThan(0);
    });
    // The footer's own visible "Stopped · Ns" label is a <span>, always
    // present once `stopped !== null`; the section header this test is about
    // is the tooltip's own `<div>`, so scope the query to that tag to avoid a
    // false negative from the unrelated footer text.
    expect(screen.queryByText("Stopped", { selector: "div" })).toBeNull();
    expect(screen.queryByText("Reason")).toBeNull();
  });

  // Regression coverage for the row-state-matrix change: a footer with no
  // agent metadata and no stop record used to render as a plain,
  // un-hoverable `<div>` with no card at all. It must now be a real tooltip
  // trigger whose card discloses Timing - the only section such a footer has.
  it("is hoverable and discloses Timing even with no agent metadata and no stop record", async () => {
    const user = userEvent.setup();
    const startedAt = Date.now() - 10_000;
    const completedAt = Date.now();
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          elapsedStartedAt: startedAt,
          completedAt,
          meta: null,
          stopped: null,
        })}
      />,
    );

    const footer = screen.getByTestId("assistant-elapsed-footer");
    await user.tab();
    expect(document.activeElement).toBe(footer);

    await waitFor(() => {
      expect(screen.getAllByText("Timing").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Started").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Finished").length).toBeGreaterThan(0);
    // No agent metadata, so no Agent section - Timing is the only content.
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.queryByText("Provider")).toBeNull();
  });
});
