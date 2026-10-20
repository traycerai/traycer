/**
 * The refusal strings an agent-to-agent send ends with when the receiver's host
 * belongs to another principal.
 *
 * The host's refusal reaches the sender's transcript as the failed call's
 * error: `<tool> failed: not reachable from this host: <sentence>`. The sentence
 * is a statement a person can act on ("open a tab on it", "ask them to run it"),
 * so the send card shows it as a plain line and not as a raw "Error" dump. Only
 * a string that CARRIES the prefix at the start of what remains after the tool
 * wrapper is read that way: every other error keeps exactly today's panel, so a
 * `RESPONSE_ID_MISMATCH` is never dressed up as a reach statement.
 */
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
import {
  A2A_REFUSAL_PREFIX,
  a2aSendRefusalSentence,
} from "@/components/chat/segments/a2a-send-refusal";
import { ToolSegment } from "@/components/chat/segments/tool-segment";
import { useSetA2ASendOpen } from "@/stores/chats/a2a-open-store-context";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";

// The send card looks up its delivery's target host; these sends carry none.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
  useMaybeTabHostClient: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicLiveAgents: () => [],
  useEpicAgentReference: (referenceId: string) => {
    if (referenceId === "agent-receiver-1") {
      return {
        id: "agent-receiver-1",
        parentId: null,
        title: "Reviewer",
        hostId: "host-1",
      };
    }
    return null;
  },
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: vi.fn() }),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "active-host-1",
}));

const TEAM_SENTENCE =
  "not reachable from this host: Reviewer runs on a Acme sandbox. Open a tab on it to brief the agent there, or continue this chat on it.";
const OTHER_SENTENCE =
  "not reachable from this host: Reviewer runs on someone else's sandbox. Agents only work with hosts of their own owner; ask them to run it, or coordinate in this task's chats.";
const HOST_TEAM_SENTENCE =
  "not reachable from this host: host h-1 belongs to Acme";
const HOST_OTHER_SENTENCE =
  "not reachable from this host: host h-1 belongs to someone else";

const TEAM_ERROR = `traycer_send_message failed: ${TEAM_SENTENCE}`;
const OTHER_ERROR = `traycer_send_message failed: ${OTHER_SENTENCE}`;
const HOST_TEAM_ERROR = `traycer_send_message failed: ${HOST_TEAM_SENTENCE}`;
const HOST_OTHER_ERROR = `traycer_send_message failed: ${HOST_OTHER_SENTENCE}`;
const MISMATCH_ERROR =
  "traycer_send_message failed: agent.sendMessage: RESPONSE_ID_MISMATCH - 'r1' belongs to a different (sender, receiver) pair.";
const PREFIX_NOT_AT_START_ERROR =
  "traycer_send_message failed: X - not reachable from this host: Reviewer runs on someone else's sandbox.";

describe("a2aSendRefusalSentence", () => {
  it("carries the prefix the host's refusals start with", () => {
    expect(A2A_REFUSAL_PREFIX).toBe("not reachable from this host: ");
  });

  it.each([
    ["the team sandbox sentence", TEAM_ERROR, TEAM_SENTENCE],
    ["the someone-else sandbox sentence", OTHER_ERROR, OTHER_SENTENCE],
    ["the host-verb team shape", HOST_TEAM_ERROR, HOST_TEAM_SENTENCE],
    ["the host-verb someone-else shape", HOST_OTHER_ERROR, HOST_OTHER_SENTENCE],
  ])("returns %s without the tool wrapper", (_name, error, sentence) => {
    expect(a2aSendRefusalSentence(error)).toBe(sentence);
  });

  it("recognises a bare sentence that has no tool wrapper", () => {
    expect(a2aSendRefusalSentence(TEAM_SENTENCE)).toBe(TEAM_SENTENCE);
    expect(a2aSendRefusalSentence(HOST_OTHER_SENTENCE)).toBe(
      HOST_OTHER_SENTENCE,
    );
  });

  it("strips the wrapper of any tool whose name is lowercase letters, digits and underscores", () => {
    expect(a2aSendRefusalSentence(`tool_2 failed: ${HOST_TEAM_SENTENCE}`)).toBe(
      HOST_TEAM_SENTENCE,
    );
  });

  it("is null for an error that is not a refusal", () => {
    expect(a2aSendRefusalSentence(MISMATCH_ERROR)).toBeNull();
    expect(
      a2aSendRefusalSentence("traycer_send_message failed: receiver not found"),
    ).toBeNull();
  });

  it("is null when the prefix appears anywhere but the start of what remains", () => {
    expect(a2aSendRefusalSentence(PREFIX_NOT_AT_START_ERROR)).toBeNull();
    expect(
      a2aSendRefusalSentence(`The send was refused: ${TEAM_SENTENCE}`),
    ).toBeNull();
  });

  it("strips ONE wrapper only, so a doubled wrapper is not a refusal", () => {
    expect(
      a2aSendRefusalSentence(
        `traycer_send_message failed: traycer_send_message failed: ${TEAM_SENTENCE}`,
      ),
    ).toBeNull();
  });

  it("is null without the prefix's separator", () => {
    expect(
      a2aSendRefusalSentence(
        "traycer_send_message failed: not reachable from this host.",
      ),
    ).toBeNull();
  });

  it("is null for null and for the empty string", () => {
    expect(a2aSendRefusalSentence(null)).toBeNull();
    expect(a2aSendRefusalSentence("")).toBeNull();
  });
});

function render(ui: ReactNode) {
  return rtlRender(
    <ChatExpansionTestProviders tileInstanceId="a2a-send-refusal-test-tile">
      {ui}
    </ChatExpansionTestProviders>,
  );
}

const SEGMENT_ID = "a2a-send-refusal-1";
const TOOL_NAME = "traycer_a2a/traycer_send_message";

function OpenSendButton() {
  const setOpen = useSetA2ASendOpen();
  return (
    <button type="button" onClick={() => setOpen(SEGMENT_ID, true)}>
      Open sent A2A
    </button>
  );
}

function renderSend(error: string, variant: "card" | "row"): void {
  const input = {
    toAgentId: "agent-receiver-1",
    message: "Please inspect the failing test.",
    responseId: null,
    expectReply: false,
  };
  render(
    <>
      <OpenSendButton />
      <ToolSegment
        headerFindUnitId={null}
        id={SEGMENT_ID}
        toolName={TOOL_NAME}
        inputSummary={deriveToolInputSummary(TOOL_NAME, input)}
        inputDetail={deriveToolInputDetail(TOOL_NAME, input)}
        imageResults={[]}
        error={error}
        agentMessageSend={{
          receiverAgentId: "agent-receiver-1",
          message: "Please inspect the failing test.",
          responseId: null,
          expectReply: false,
        }}
        managedCommand={null}
        page={null}
        mcpApp={null}
        agentMessageReceipt={null}
        agentMessageDelivery={null}
        isStreaming={false}
        endState={null}
        stopped={false}
        progress={null}
        backgroundOutput={null}
        backgroundTask={false}
        startedAt={0}
        durationMs={null}
        variant={variant}
      />
    </>,
  );
}

function openSend(): void {
  fireEvent.click(screen.getByRole("button", { name: "Open sent A2A" }));
}

afterEach(() => {
  useToolOpenStore.getState().reset("default");
  cleanup();
});

describe("<ToolSegment /> A2A send refusals", () => {
  it.each([
    ["the team sandbox", TEAM_ERROR, TEAM_SENTENCE],
    ["the someone-else sandbox", OTHER_ERROR, OTHER_SENTENCE],
    ["the host-verb team shape", HOST_TEAM_ERROR, HOST_TEAM_SENTENCE],
    ["the host-verb someone-else shape", HOST_OTHER_ERROR, HOST_OTHER_SENTENCE],
  ])(
    "shows %s refusal in the card without opening it, and no Error panel",
    (_name, error, sentence) => {
      renderSend(error, "card");

      // The card is closed: its message body, and the copy button inside it,
      // are not mounted. The refusal is visible all the same.
      expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
      expect(screen.getByTestId("a2a-send-refusal").textContent).toBe(sentence);
      expect(screen.queryByText("Error")).toBeNull();
      // The tool badge reads "error" in the DOM (CSS uppercases it), so the
      // exact-case "Error" above cannot see it: a refusal is not a fault.
      expect(screen.queryByText(/^error$/i)).toBeNull();
    },
  );

  it("keeps the refusal, and no Error panel, once the card is opened", () => {
    renderSend(TEAM_ERROR, "card");

    openSend();

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByTestId("a2a-send-refusal").textContent).toBe(
      TEAM_SENTENCE,
    );
    expect(screen.queryByText("Error")).toBeNull();
    // The tool badge reads "error" in the DOM (CSS uppercases it), so the
    // exact-case "Error" above cannot see it: a refusal is not a fault.
    expect(screen.queryByText(/^error$/i)).toBeNull();
  });

  it.each([
    ["the team sandbox", TEAM_ERROR, TEAM_SENTENCE],
    ["the someone-else sandbox", OTHER_ERROR, OTHER_SENTENCE],
    ["the host-verb team shape", HOST_TEAM_ERROR, HOST_TEAM_SENTENCE],
    ["the host-verb someone-else shape", HOST_OTHER_ERROR, HOST_OTHER_SENTENCE],
  ])(
    "shows %s refusal in the row variant when open, and no Error panel",
    (_name, error, sentence) => {
      renderSend(error, "row");

      openSend();

      expect(screen.getByTestId("a2a-send-refusal").textContent).toBe(sentence);
      expect(screen.queryByText("Error")).toBeNull();
      // The tool badge reads "error" in the DOM (CSS uppercases it), so the
      // exact-case "Error" above cannot see it: a refusal is not a fault.
      expect(screen.queryByText(/^error$/i)).toBeNull();
    },
  );

  it("renders a bare refusal sentence the same way", () => {
    renderSend(TEAM_SENTENCE, "card");

    expect(screen.getByTestId("a2a-send-refusal").textContent).toBe(
      TEAM_SENTENCE,
    );
    expect(screen.queryByText("Error")).toBeNull();
    // The tool badge reads "error" in the DOM (CSS uppercases it), so the
    // exact-case "Error" above cannot see it: a refusal is not a fault.
    expect(screen.queryByText(/^error$/i)).toBeNull();
  });

  it.each([
    ["a response-id mismatch", MISMATCH_ERROR],
    ["a prefix that is not at the start", PREFIX_NOT_AT_START_ERROR],
  ])("keeps %s on today's Error panel, raw text and all", (_name, error) => {
    renderSend(error, "card");

    openSend();

    expect(screen.queryByTestId("a2a-send-refusal")).toBeNull();
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText(error)).toBeTruthy();
  });

  it("keeps a non-refusal error on the Error panel in the row variant", () => {
    renderSend(MISMATCH_ERROR, "row");

    openSend();

    expect(screen.queryByTestId("a2a-send-refusal")).toBeNull();
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText(MISMATCH_ERROR)).toBeTruthy();
  });

  it.each([["card" as const], ["row" as const]])(
    "keeps the error badge in the %s header for a non-refusal error, closed",
    (variant) => {
      renderSend(MISMATCH_ERROR, variant);

      // Closed: the body (and its "Error" panel) is not mounted, so the badge
      // is the only match.
      expect(screen.getByText(/^error$/i)).toBeTruthy();
    },
  );
});
