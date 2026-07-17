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
import { useToolOpenStore } from "@/stores/chats/tool-open-store";

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
    useToolOpenStore.getState().reset("default");
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
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
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
    expect(
      screen
        .getByText("Please inspect the failing test.")
        .closest(".md-prose")
        ?.hasAttribute("data-quotable"),
    ).toBe(false);
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
          stopped={false}
          progress={null}
          backgroundOutput={null}
          backgroundTask={false}
          startedAt={0}
          durationMs={null}
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
          stopped={false}
          progress={null}
          backgroundOutput={null}
          backgroundTask={false}
          startedAt={0}
          durationMs={null}
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
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
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
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
        variant="card"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Sent message/ }));

    expect(
      screen.getByRole("button", { name: /Open receiving agent/i }),
    ).toBeTruthy();
  });
});

describe("<ToolSegment /> input rendering", () => {
  afterEach(() => {
    useToolOpenStore.getState().reset("default");
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
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
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

  it("labels a backgrounded MCP call's output as Result and pretty-prints JSON", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="mcp-bg-tool-1"
        toolName="mcp__probe__slow_op"
        {...inputProps("mcp__probe__slow_op", {})}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        stopped={false}
        progress={null}
        backgroundOutput={{
          stdout: '{"answer":42,"items":[1,2]}',
          stderr: "",
          truncated: false,
        }}
        backgroundTask
        startedAt={0}
        durationMs={null}
        variant="card"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /slow_op/ }));
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.queryByText("Output")).toBeNull();
    // Re-indented JSON, not the single-line tail.
    expect(screen.getByText(/"answer": 42/)).toBeTruthy();
  });

  it("keeps non-JSON MCP background output verbatim under the Result label", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="mcp-bg-tool-2"
        toolName="mcp__probe__slow_op"
        {...inputProps("mcp__probe__slow_op", {})}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        stopped={false}
        progress={null}
        backgroundOutput={{
          stdout: "plain text result",
          stderr: "",
          truncated: false,
        }}
        backgroundTask
        startedAt={0}
        durationMs={null}
        variant="card"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /slow_op/ }));
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getByText("plain text result")).toBeTruthy();
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
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
        variant="card"
      />,
    );

    // Header is enough (just the pattern) → no expand affordance at all.
    expect(screen.getByText("glob")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /glob/ })).toBeNull();
  });

  it("renders capped background output in the expanded tool card", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="tool-background-output"
        toolName="Bash"
        {...inputProps("Bash", {
          command: "printf hello",
          run_in_background: true,
        })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        stopped={false}
        progress={null}
        backgroundOutput={{
          stdout: "hello\n",
          stderr: "warning\n",
          truncated: true,
        }}
        backgroundTask
        startedAt={0}
        durationMs={null}
        variant="card"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));

    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("Error output")).toBeTruthy();
    expect(screen.getByText("warning")).toBeTruthy();
    expect(screen.getByText("Output truncated")).toBeTruthy();
  });

  it("shows a completed badge for a background command with empty output", () => {
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="tool-background-empty"
        toolName="Bash"
        {...inputProps("Bash", {
          command: "true",
          run_in_background: true,
        })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        stopped={false}
        progress={null}
        backgroundOutput={{ stdout: "", stderr: "", truncated: false }}
        backgroundTask
        startedAt={0}
        durationMs={7_600}
        variant="card"
      />,
    );

    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("7s")).toBeTruthy();
  });

  it("shows a neutral stopped badge from the legacy 'stopped: ...' error-string convention", () => {
    // Back-compat: blocks persisted before the `stopped` boolean field existed
    // carry no signal except this string prefix on `error`.
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="tool-background-stopped-legacy"
        toolName="Bash"
        {...inputProps("Bash", {
          command: "sleep 60",
          run_in_background: true,
        })}
        error="stopped: user requested stop"
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask
        startedAt={0}
        durationMs={7_600}
        variant="card"
      />,
    );

    expect(screen.getByText("stopped")).toBeTruthy();
    expect(screen.getByText("7s")).toBeTruthy();
    expect(screen.queryByText("error")).toBeNull();
  });

  it("shows a neutral stopped badge from the authoritative `stopped` field, not the destructive error badge", () => {
    // `status: "errored"` with `stopped: true` is how the host now reports an
    // explicit stop (deadline-killed Monitor, user-stopped command) - no
    // reliance on sniffing the error string.
    render(
      <ToolSegment
        headerFindUnitId={null}
        id="tool-background-stopped-authoritative"
        toolName="Bash"
        {...inputProps("Bash", {
          command: "sleep 60",
          run_in_background: true,
        })}
        error="Monitor deadline exceeded"
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
        stopped
        progress={null}
        backgroundOutput={null}
        backgroundTask
        startedAt={0}
        durationMs={7_600}
        variant="card"
      />,
    );

    expect(screen.getByText("stopped")).toBeTruthy();
    expect(screen.getByText("7s")).toBeTruthy();
    expect(screen.queryByText("error")).toBeNull();
  });
});

describe("<ToolSegment /> streaming heartbeat", () => {
  afterEach(() => {
    useToolOpenStore.getState().reset("default");
    cleanup();
    vi.useRealTimers();
  });

  it("keeps a streaming background command timer in the card header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    render(
      <ToolSegment
        headerFindUnitId={null}
        id="tool-background-streaming"
        toolName="Bash"
        {...inputProps("Bash", {
          command: "sleep 60",
          run_in_background: true,
        })}
        error={null}
        agentMessageSend={null}
        isStreaming
        endState={null}
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask
        startedAt={5_000}
        durationMs={null}
        variant="card"
      />,
    );

    const header = screen.getByText("Bash").closest("div");

    expect(header?.textContent).toContain("5s");
    expect(header?.textContent).toContain("Running sleep 60");
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
        stopped={false}
        progress="Fetched 3/10 pages"
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={startedAt}
        durationMs={null}
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
        stopped={false}
        progress="Fetched 10/10 pages"
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={startedAt}
        durationMs={null}
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
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
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
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
        variant="row"
      />,
    );
    expect(screen.getByText("superseded")).toBeTruthy();
  });
});
