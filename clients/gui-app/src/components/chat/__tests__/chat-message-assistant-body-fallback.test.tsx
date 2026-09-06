import { cleanup, render, screen } from "@testing-library/react";
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

  // The two frames are rendered in SEPARATE bodies, one segment each, and the
  // divider count is taken over the whole document rather than over an ancestor
  // reached with `closest`. That is not fastidiousness: the marker's own
  // wrapper is `div.w-full.max-w-[…]` and not `div.flex.w-full.flex-col`, so a
  // `closest` from its title climbs PAST it into the container both notices
  // share - which is how the first version of this test read the divider-rule
  // notice's two hairlines as the marker's own. Isolating the render is the
  // only scoping that makes the negative mean what it says.
  it("renders fallback_wait_resumed as the resumed-turn marker, with no divider rule", () => {
    renderBody(<Body segments={[WAIT_RESUMED]} />);

    expect(screen.getByText("Resumed after waiting")).not.toBeNull();
    // Falsification: point the `fallback_wait_resumed` arm in
    // `chat-message-assistant-body.tsx` at `ProviderNoticeSegment` (drop the
    // `FallbackWaitResumedMarker` branch) and this assertion must go red - that
    // component renders exactly two `span.h-px` hairlines around its label.
    expect(document.querySelectorAll("span.h-px")).toHaveLength(0);
  });

  // The positive CONTROL for the assertion above: the same query, on the frame
  // that is supposed to have the rule. Without it, a marker that rendered
  // nothing at all would satisfy the negative.
  it("renders fallback_applied as the divider-rule notice", () => {
    renderBody(<Body segments={[FALLBACK_APPLIED]} />);

    expect(screen.getByText("Switched providers")).not.toBeNull();
    expect(document.querySelectorAll("span.h-px").length).toBeGreaterThan(0);
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
      backgroundToolBlockIds={new Set()}
      runState={null}
      messageId="assistant:turn-fallback"
      turnId="turn-fallback"
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
    />
  );
}
