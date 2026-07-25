import "../../../../__tests__/test-browser-apis";
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
  turnReplyText: "Here is the answer.",
};

// A content-less boundary row whose turn genuinely never produced anything -
// the only shape that should render "Stopped before responding".
const STOPPED_NO_OUTPUT: ChatMessageStoppedInfo = {
  ...STOPPED,
  turnHadOutput: false,
  turnReplyText: "",
};

const META: AssistantTurnMeta = {
  provider: "claude",
  providerLabel: "Claude Code",
  profileLabel: "Work",
  modelLabel: "Claude Sonnet 4",
  reasoningEffort: "high",
  reasoningEffortLabel: "High",
  serviceTier: null,
  costUsd: null,
};

interface BodyPropsOverrides {
  readonly segments?: ReadonlyArray<MessageSegment>;
  readonly runState?: ChatMessageRunState | null;
  readonly createdAt?: number;
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
    createdAt: overrides.createdAt ?? 0,
    pausedDurationMs: 0,
    pausedSinceMs: null,
    completedAt: overrides.completedAt ?? null,
    stopped: overrides.stopped ?? null,
    meta: overrides.meta ?? null,
    nextStepActions: null,
    forkAction: null,
  };
}

describe("AssistantMessageBody stopped turn rendering", () => {
  it('renders "Stopped · {elapsed}" with the stop glyph, not the natural-completion verb', () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [TEXT_SEGMENT],
          createdAt: 0,
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
          createdAt: 0,
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
          createdAt: 0,
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

  it('renders the full "Stopped · {elapsed}" footer, not "Stopped before responding", on a content-less boundary row whose turn DID produce output elsewhere', () => {
    render(
      <AssistantMessageBody
        {...bodyProps({
          segments: [],
          runState: null,
          createdAt: 0,
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
          createdAt: 0,
          completedAt: 5_000,
          stopped: STOPPED,
        })}
      />,
    );

    const copyButton = screen.getByTestId("assistant-reply-copy");
    fireEvent.click(copyButton);
    expect(clipboard.writeText).toHaveBeenCalledWith(STOPPED.turnReplyText);
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
          createdAt: 0,
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
          createdAt: 0,
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
          createdAt: 0,
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
          createdAt: 0,
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
});
