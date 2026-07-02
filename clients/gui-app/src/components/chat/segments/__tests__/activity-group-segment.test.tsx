import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import {
  deriveActivityGroupCollapsibleKey,
  deriveActivityGroupRenderId,
} from "@/components/chat/chat-collapsible-key";
import { ActivityGroupSegment } from "@/components/chat/segments/activity-group-segment";
import type { ActivityGroupModel } from "@/components/chat/chat-activity-groups";
import type { CommandSegment } from "@/stores/composer/chat-store";
import {
  useChatCollapsibleTileInstanceId,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";

const COMMAND_SEGMENT: CommandSegment = {
  id: "command-1",
  kind: "command",
  command: "echo hi",
  cwd: null,
  exitCode: 0,
  isStreaming: false,
  endState: null,
  progress: null,
  startedAt: 0,
  parentId: null,
};

const GROUP_ID = deriveActivityGroupRenderId(COMMAND_SEGMENT.id);

const GROUP: ActivityGroupModel = {
  id: GROUP_ID,
  segments: [COMMAND_SEGMENT],
  isActive: false,
  isStreaming: false,
  label: "Ran 1 command",
  summary: "Ran 1 command",
  activeStartedAt: null,
};

interface ForceActivityGroupButtonProps {
  readonly label: string;
  readonly groupId: string;
}

function ForceActivityGroupButton(props: ForceActivityGroupButtonProps) {
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const key = deriveActivityGroupCollapsibleKey(tileInstanceId, props.groupId);
  return (
    <button type="button" onClick={() => setFindForcedOpen(key, true)}>
      {props.label}
    </button>
  );
}

function renderActivityGroup(group: ActivityGroupModel) {
  return render(
    <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
      <ActivityGroupSegment group={group} />
    </ChatExpansionTestProviders>,
  );
}

describe("<ActivityGroupSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps user open and close behavior unchanged", () => {
    renderActivityGroup(GROUP);

    expect(screen.queryByText("echo hi")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));

    expect(screen.getByText("echo hi")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));

    expect(screen.queryByText("echo hi")).toBeNull();
  });

  it("opens through find-force and releases on manual collapse", () => {
    render(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ForceActivityGroupButton
          label="Force activity group"
          groupId={GROUP_ID}
        />
        <ActivityGroupSegment group={GROUP} />
      </ChatExpansionTestProviders>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Force activity group" }),
    );

    expect(screen.getByText("echo hi")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));

    expect(screen.queryByText("echo hi")).toBeNull();
  });

  it("skips the active-group live elapsed timer from highlighting, keeping the label findable", () => {
    vi.useFakeTimers();
    try {
      // 10s now - 5s start = a stable floored "5s" elapsed label.
      vi.setSystemTime(10_000);
      renderActivityGroup({
        ...GROUP,
        label: "Ran 5 commands",
        summary: "Ran 5 commands",
        isActive: true,
        isStreaming: true,
        activeStartedAt: 5_000,
      });

      // The label is the only text the summary unit indexes, so it must stay
      // highlightable inside the find-anchor button (no data-find-skip ancestor).
      const label = screen.getByText("Ran 5 commands");
      expect(label.closest("[data-find-skip]")).toBeNull();
      expect(label.closest("button")).not.toBeNull();

      // The live elapsed timer is ephemeral chrome the summary projection never
      // indexes. Without the data-find-skip wrapper, a query on the elapsed
      // digits would paint inside the anchor (count 1, paint 2); the skip keeps
      // paint == count.
      expect(screen.getByText("5s").closest("[data-find-skip]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
