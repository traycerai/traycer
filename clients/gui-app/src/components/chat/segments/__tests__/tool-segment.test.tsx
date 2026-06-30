import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import { ToolSegment } from "@/components/chat/segments/tool-segment";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";

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

describe("<ToolSegment /> A2A send-message rendering", () => {
  afterEach(() => {
    useToolOpenStore.getState().reset("default");
    cleanup();
  });

  it("renders a structured agentMessageSend as an expandable agent-message card", () => {
    render(
      <ToolSegment
        id="tool-a2a-structured"
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
    expect(screen.queryByText("Thread")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("keeps tools without an agentMessageSend payload on the generic tool surface", () => {
    render(
      <ToolSegment
        id="tool-shell-generic"
        toolName="shell"
        {...inputProps("shell", { command: "echo hi" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
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
        id="tool-a2a-optimistic"
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

  it("opens sent-message cards from the shared tool open store", () => {
    useToolOpenStore.getState().setOpen("default", "tool-a2a-store", true);

    render(
      <ToolSegment
        id="tool-a2a-store"
        toolName="traycer_a2a/traycer_send_message"
        {...inputProps("traycer_a2a/traycer_send_message", {})}
        error={null}
        agentMessageSend={{
          receiverAgentId: "agent-receiver-1",
          message: "Open through the shared store.",
          responseId: null,
          expectReply: false,
        }}
        isStreaming={false}
        endState={null}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
        variant="card"
      />,
    );

    expect(screen.getByText("Open receiving agent")).toBeTruthy();
    expect(screen.getByText("Open through the shared store.")).toBeTruthy();
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
        id="tool-grep"
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

  it("renders a self-describing call as a non-expandable header (no toggle)", () => {
    render(
      <ToolSegment
        id="tool-glob"
        toolName="glob"
        {...inputProps("glob", { pattern: "**/*.tsx" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
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

  it("shows a neutral stopped badge for a stopped background command", () => {
    render(
      <ToolSegment
        id="tool-background-stopped"
        toolName="Bash"
        {...inputProps("Bash", {
          command: "sleep 60",
          run_in_background: true,
        })}
        error="stopped: user requested stop"
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
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
        id="tool-streaming"
        toolName="mcp__fetch"
        {...inputProps("mcp__fetch", { url: "https://example.com" })}
        error={null}
        agentMessageSend={null}
        isStreaming
        endState={null}
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
        id="tool-completed"
        toolName="mcp__fetch"
        {...inputProps("mcp__fetch", { url: "https://example.com" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState={null}
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
        id="tool-stopped"
        toolName="shell"
        {...inputProps("shell", { command: "sleep 30" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState="interrupted"
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
        id="tool-stopped"
        toolName="shell"
        {...inputProps("shell", { command: "sleep 30" })}
        error={null}
        agentMessageSend={null}
        isStreaming={false}
        endState="superseded"
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
