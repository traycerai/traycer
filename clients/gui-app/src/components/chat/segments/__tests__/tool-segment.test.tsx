import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { deriveA2ASendCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { ToolSegment } from "@/components/chat/segments/tool-segment";
import { useSetA2ASendOpen } from "@/stores/chats/a2a-open-store-context";
import {
  useChatCollapsibleTileInstanceId,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";

function render(ui: ReactNode) {
  return rtlRender(
    <ChatExpansionTestProviders tileInstanceId="tool-segment-test-tile">
      {ui}
    </ChatExpansionTestProviders>,
  );
}

// The host precomputes these from the raw harness input (no longer persisted)
// at the accumulator chokepoint; the component renders the precomputed fields.
// Compute them here so the tests exercise the real summary/detail behavior.
function inputProps(toolName: string, input: unknown) {
  return {
    inputSummary: deriveToolInputSummary(toolName, input),
    inputDetail: deriveToolInputDetail(toolName, input),
  };
}

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: (artifactId: string | null) => {
    if (artifactId === "agent-receiver-1") {
      return {
        id: "agent-receiver-1",
        parentId: null,
        title: "Receiver Agent",
        hostId: "host-1",
      };
    }
    if (artifactId === "agent-receiver-optimistic") {
      return {
        id: "agent-receiver-optimistic",
        parentId: null,
        title: "Optimistic Receiver",
        hostId: null,
      };
    }
    return null;
  },
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "active-host-1",
}));

interface OpenA2ASendButtonProps {
  readonly label: string;
  readonly segmentId: string;
}

function OpenA2ASendButton(props: OpenA2ASendButtonProps) {
  const setOpen = useSetA2ASendOpen();
  return (
    <button type="button" onClick={() => setOpen(props.segmentId, true)}>
      {props.label}
    </button>
  );
}

interface ForceA2ASendButtonProps {
  readonly label: string;
  readonly segmentId: string;
}

function ForceA2ASendButton(props: ForceA2ASendButtonProps) {
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const key = deriveA2ASendCollapsibleKey(tileInstanceId, props.segmentId);
  return (
    <button type="button" onClick={() => setFindForcedOpen(key, true)}>
      {props.label}
    </button>
  );
}

describe("<ToolSegment /> A2A send-message rendering", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a structured agentMessageSend as an expandable agent-message card", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="a2a-send-1"
        toolName="traycer_a2a/traycer_send_message"
        {...inputProps("traycer_a2a/traycer_send_message", {
          toAgentId: "agent-receiver-1",
          message: "Please inspect the failing test.",
          responseId: "response-1",
          expectReply: true,
        })}
        error={null}
        agentMessageSend={{
          receiverAgentId: "agent-receiver-1",
          message: "Please inspect the failing test.",
          responseId: "response-1",
          expectReply: true,
        }}
        isStreaming={false}
        endState={null}
        progress={null}
        startedAt={0}
        variant="card"
      />,
    );

    expect(screen.getByText("Sent message")).toBeTruthy();
    expect(screen.getByText("Receiver Agent")).toBeTruthy();
    expect(screen.getByText(/Please inspect the failing test/)).toBeTruthy();
    expect(screen.queryByText("reply expected")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Sent message/ }));

    expect(screen.getByText("Open receiving agent")).toBeTruthy();
    expect(screen.getByText("reply expected")).toBeTruthy();
    expect(screen.getByText("Please inspect the failing test.")).toBeTruthy();
    expect(screen.queryByText("Thread")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("opens sent A2A cards through the provider store", () => {
    const segmentId = "a2a-send-controlled";
    render(
      <>
        <OpenA2ASendButton label="Open sent A2A" segmentId={segmentId} />
        <ToolSegment
          headerFindUnitId={null}
          id={segmentId}
          toolName="traycer_a2a/traycer_send_message"
          {...inputProps("traycer_a2a/traycer_send_message", {})}
          error={null}
          agentMessageSend={{
            receiverAgentId: "agent-receiver-1",
            message: "Please inspect the controlled card.",
            responseId: "response-1",
            expectReply: true,
          }}
          isStreaming={false}
          endState={null}
          progress={null}
          startedAt={0}
          variant="card"
        />
      </>,
    );

    expect(screen.queryByText("Open receiving agent")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open sent A2A" }));

    expect(screen.getByText("Open receiving agent")).toBeTruthy();
    expect(screen.getByText("reply expected")).toBeTruthy();
  });

  it("opens sent A2A cards through find-force and releases on manual collapse", () => {
    const segmentId = "a2a-send-find-forced";
    render(
      <>
        <ForceA2ASendButton label="Force sent A2A" segmentId={segmentId} />
        <ToolSegment
          headerFindUnitId={null}
          id={segmentId}
          toolName="traycer_a2a/traycer_send_message"
          {...inputProps("traycer_a2a/traycer_send_message", {})}
          error={null}
          agentMessageSend={{
            receiverAgentId: "agent-receiver-1",
            message: "Please inspect the find-forced card.",
            responseId: "response-1",
            expectReply: true,
          }}
          isStreaming={false}
          endState={null}
          progress={null}
          startedAt={0}
          variant="card"
        />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Force sent A2A" }));

    expect(screen.getByText("Open receiving agent")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Sent message/ }));

    expect(screen.queryByText("Open receiving agent")).toBeNull();
  });

  it("keeps tools without an agentMessageSend payload on the generic tool surface", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="generic-tool-1"
        toolName="shell"
        {...inputProps("shell", { command: "echo hi" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        progress={null}
        startedAt={0}
        variant="card"
      />,
    );

    expect(screen.getByText("shell")).toBeTruthy();
    expect(screen.queryByText("Sent message")).toBeNull();
  });

  it("opens optimistic chat receivers with the active host fallback", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="a2a-send-optimistic"
        toolName="traycer_a2a/traycer_send_message"
        {...inputProps("traycer_a2a/traycer_send_message", {})}
        error={null}
        agentMessageSend={{
          receiverAgentId: "agent-receiver-optimistic",
          message: "Please continue this thread.",
          responseId: null,
          expectReply: false,
        }}
        isStreaming={false}
        endState={null}
        progress={null}
        startedAt={0}
        variant="card"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Sent message/ }));

    expect(screen.getByText("Open receiving agent")).toBeTruthy();
  });
});

describe("<ToolSegment /> input rendering", () => {
  afterEach(() => {
    cleanup();
  });

  it("expands a grep call into a reconstructed command, not JSON", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="grep-tool-1"
        toolName="Grep"
        {...inputProps("Grep", {
          pattern: "overflow-anchor",
          output_mode: "content",
          "-n": true,
          "-C": 3,
        })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        progress={null}
        startedAt={0}
        variant="card"
      />,
    );

    // Header summary is the bare pattern; the call is expandable because it
    // carries flags the header doesn't show.
    fireEvent.click(screen.getByRole("button", { name: /Grep/ }));
    // The `$ ` prefix is a sibling span, so match the reconstructed command text.
    expect(screen.getByText('grep -n -C 3 "overflow-anchor"')).toBeTruthy();
    // No raw JSON dump and no `json` language pill.
    expect(screen.queryByText("json")).toBeNull();
    expect(screen.queryByText(/"pattern":/)).toBeNull();
  });

  it("renders a self-describing call as a non-expandable header (no toggle)", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="glob-tool-1"
        toolName="glob"
        {...inputProps("glob", { pattern: "**/*.tsx" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        progress={null}
        startedAt={0}
        variant="card"
      />,
    );

    // Header is enough (just the pattern) → no expand affordance at all.
    expect(screen.getByText("glob")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /glob/ })).toBeNull();
  });
});

describe("<ToolSegment /> streaming heartbeat", () => {
  afterEach(() => {
    cleanup();
  });

  // The row variant is the path generic tools actually render on (they group
  // into the activity timeline); the footer renders beneath the row.
  it("shows the latest progress line and an elapsed counter while streaming", () => {
    const startedAt = Date.now();
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="streaming-tool-1"
        toolName="mcp__fetch"
        {...inputProps("mcp__fetch", { url: "https://example.com" })}
        error={null}
        agentMessageSend={null}
        isStreaming
        endState={null}
        progress="Fetched 3/10 pages"
        startedAt={startedAt}
        variant="row"
      />,
    );

    // Streaming row surfaces the progress line + a 0s elapsed tick beneath it.
    expect(screen.getByText("Fetched 3/10 pages")).toBeTruthy();
    expect(screen.getByText("0s")).toBeTruthy();
  });

  it("omits the heartbeat once the call completes", () => {
    const startedAt = Date.now();
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="completed-tool-1"
        toolName="mcp__fetch"
        {...inputProps("mcp__fetch", { url: "https://example.com" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        progress="Fetched 10/10 pages"
        startedAt={startedAt}
        variant="row"
      />,
    );

    // No footer once streaming ends - progress is a streaming-only affordance.
    expect(screen.queryByText("Fetched 10/10 pages")).toBeNull();
    expect(screen.queryByText("0s")).toBeNull();
  });

  it("shows a 'stopped' badge for an interrupted call and 'superseded' for a steered one", () => {
    const { rerender } = render(
      <ToolSegment
        headerFindUnitId={null}
        id="end-state-tool-1"
        toolName="shell"
        {...inputProps("shell", { command: "sleep 30" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState="interrupted"
        progress={null}
        startedAt={0}
        variant="row"
      />,
    );
    expect(screen.getByText("stopped")).toBeTruthy();

    rerender(
      <ToolSegment
        headerFindUnitId={null}
        id="end-state-tool-1"
        toolName="shell"
        {...inputProps("shell", { command: "sleep 30" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState="superseded"
        progress={null}
        startedAt={0}
        variant="row"
      />,
    );
    expect(screen.getByText("superseded")).toBeTruthy();
  });
});
