import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { AssistantMessageBody } from "@/components/chat/chat-message-assistant-body";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MessageSegment } from "@/stores/composer/chat-store";

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

function renderBody(ui: ReactNode) {
  return render(
    <TooltipProvider delayDuration={0}>
      <TabHostProvider hostId="tab-host-b">
        <ChatExpansionTestProviders tileInstanceId="fallback-body-tile">
          {ui}
        </ChatExpansionTestProviders>
      </TabHostProvider>
    </TooltipProvider>,
  );
}

const WAIT_RESUMED: MessageSegment = {
  id: "seg-wait-resumed",
  kind: "provider_notice",
  receipt: null,
  status: "completed",
  noticeKind: "fallback_wait_resumed",
  tone: "info",
  title: "Resumed after waiting",
  message: "The limit reset.",
  details: [{ label: "via:", value: "Claude Code" }],
  parentId: null,
};

const FALLBACK_APPLIED: MessageSegment = {
  id: "seg-applied",
  kind: "provider_notice",
  receipt: null,
  status: "completed",
  noticeKind: "fallback_applied",
  tone: "info",
  title: "Switched providers",
  message: "Moved to Codex.",
  details: [{ label: "via:", value: "Claude Code → Codex" }],
  parentId: null,
};

describe("AssistantMessageBody fallback notice frames", () => {
  afterEach(() => {
    cleanup();
  });

  // Clutter cuts (2026-09-27): `fallback_wait_resumed` is the same one-line
  // hairline divider as `fallback_applied`, not the bordered SegmentCard marker
  // it used to be. Each is rendered in its own body so the rule count is read
  // over the whole document, not over an ancestor.
  it.each([
    ["fallback_wait_resumed", WAIT_RESUMED, "Resumed after waiting"],
    ["fallback_applied", FALLBACK_APPLIED, "Switched providers"],
  ] as const)(
    "renders %s as the hairline divider, with its details under a chevron",
    (_kind, segment, title) => {
      renderBody(<Body segments={[segment]} />);

      expect(screen.getByText(title)).not.toBeNull();
      // Two aria-hidden rule spans, one each side of the label.
      const rules = document.querySelectorAll("span.h-px");
      expect(rules).toHaveLength(2);
      for (const rule of rules) {
        expect(rule.getAttribute("aria-hidden")).toBe("true");
      }
      // The details make the label a chevron button.
      const chevron = screen.getByRole("button");
      expect(chevron.getAttribute("aria-expanded")).toBe("false");
      expect(chevron.textContent).toContain(title);
      fireEvent.click(chevron);
      expect(chevron.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("via:")).not.toBeNull();
      // Exactly one button: no "Model routing" action under the details.
      expect(screen.getAllByRole("button")).toHaveLength(1);
    },
  );

  it("renders a fallback_wait_resumed notice with no details as the divider without a button", () => {
    renderBody(<Body segments={[{ ...WAIT_RESUMED, details: [] }]} />);

    expect(screen.getByText(/Resumed after waiting/)).not.toBeNull();
    expect(document.querySelectorAll("span.h-px")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });

  // The old marker was a SegmentCard: a bordered, rounded, full-width box with
  // its own expander. None of that shape may come back for the resumed notice.
  it("does not render fallback_wait_resumed as the old bordered marker card", () => {
    const { container } = renderBody(<Body segments={[WAIT_RESUMED]} />);

    expect(container.querySelector("[class*='border-border']")).toBeNull();
    // The divider's label sits between the two rules in one flex row.
    const label = screen.getByText(/Resumed after waiting/);
    expect(label.closest("div.flex.items-center.gap-3")).not.toBeNull();
  });
});

/** The body under test, with everything but `segments` held fixed. */
function Body({
  segments,
}: {
  readonly segments: ReadonlyArray<MessageSegment>;
}) {
  return (
    <AssistantMessageBody
      segments={segments}
      hasLaterAssistantText={false}
      backgroundToolBlockIds={new Set()}
      runState={null}
      turnComplete
      messageId="assistant:turn-fallback"
      turnId="turn-fallback"
      // Both fixtures are `provider_notice` segments, so the anchor predicate
      // selects nothing on either - `null` is what the projection would hand
      // this row, not a convenience. The turn id stays real so these frames
      // are exercised on a row that HAS turn identity and still renders no
      // rung group, which is the combination that matters here.
      manualRungAnchorId={null}
      elapsedStartedAt={0}
      turnHasOnlyAutonomousResumeSegments={false}
      showCompletionFooter={false}
      pausedDurationMs={0}
      pausedSinceMs={null}
      completedAt={null}
      stopped={null}
      meta={null}
      nextStepActions={null}
      forkAction={null}
      interviewDeliveryRetry={null}
      routingSettledNoticeId={null}
    />
  );
}
