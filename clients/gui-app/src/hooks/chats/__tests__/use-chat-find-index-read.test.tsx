import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatLocateRowResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatFindIndexRead } from "@/components/chat/chat-find-index";
import { TRANSCRIPT_JUMP_TTL_MS } from "@/components/epic-canvas/renderers/chat-tile-jump-logic";
import { useChatFindIndexRead } from "@/hooks/chats/use-chat-find-index-read";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * F14-9: chat find's index READ - the row an index hit names, hydrated without
 * moving the viewport so the client scan can confirm the hit.
 *
 * The host is faked at `useHostQuery`, the same seam `use-chat-locate-row`'s
 * own test uses: `chat.locateRow` answers whatever `locateAnswer` holds, and
 * every call is recorded so a cell can say whether the host was asked at all.
 * `requestFindReadOrdinal` and `onReadFailed` are spies standing in for the
 * session store and the find adapter.
 */
interface CapturedHostQuery {
  readonly method: string;
  readonly params: { readonly target: unknown };
  readonly cacheKeyIdentity: ReadonlyArray<unknown> | undefined;
  readonly options: { readonly enabled: boolean | undefined } | null;
}

const host = vi.hoisted<{
  answer: ChatLocateRowResponse | undefined;
  isError: boolean;
  queries: CapturedHostQuery[];
}>(() => ({ answer: undefined, isError: false, queries: [] }));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: CapturedHostQuery) => {
    host.queries.push(args);
    const enabled = args.options?.enabled === true;
    return {
      data: enabled ? host.answer : undefined,
      isFetching: false,
      isError: enabled && host.isError,
    };
  },
}));

const EPOCH = 4;
const USER_ROW_ID = "user-message-1";
const HELD_ROW_ID = "assistant:turn-9:slice:2";
const COLD_ASSISTANT_ID = "assistant-record-7";

function entry(rowId: string, ordinal: number): RowSkeletonEntry {
  return {
    rowId,
    createdAt: ordinal,
    role: "user",
    byteLength: 64,
    bodyDigest: `d-${rowId}`,
  };
}

/** A window whose skeleton names a user row at 3 and a turn slice at 6. */
function windowAt(epoch: number): TranscriptWindow {
  const skeleton: (RowSkeletonEntry | undefined)[] = Array.from(
    { length: 10 },
    () => undefined,
  );
  skeleton[3] = entry(USER_ROW_ID, 3);
  skeleton[6] = entry(HELD_ROW_ID, 6);
  return { ...emptyTranscriptWindow(), epoch, rowCount: 10, skeleton };
}

interface Props {
  readonly read: ChatFindIndexRead | null;
  readonly transcriptWindow: TranscriptWindow;
}

function mountRead(initial: Props) {
  // One log across both spies, so a cell can assert their relative order.
  const log: string[] = [];
  const requestFindReadOrdinal = vi.fn((ordinal: number | null): void => {
    log.push(`ordinal:${String(ordinal)}`);
  });
  const onReadFailed = vi.fn((messageId: string): void => {
    log.push(`failed:${messageId}`);
  });
  const rendered = renderHook(
    (props: Props) =>
      useChatFindIndexRead({
        client: null,
        epicId: "epic-find-read",
        chatId: "chat-find-read",
        transcriptWindow: props.transcriptWindow,
        read: props.read,
        requestFindReadOrdinal,
        onReadFailed,
      }),
    { initialProps: initial },
  );
  return { ...rendered, log, requestFindReadOrdinal, onReadFailed };
}

/** The locate queries the hook actually enabled - i.e. sent to the host. */
function sentLocates(): ReadonlyArray<CapturedHostQuery> {
  return host.queries.filter((query) => query.options?.enabled === true);
}

describe("useChatFindIndexRead (F14-9)", () => {
  beforeEach(() => {
    host.answer = undefined;
    host.isError = false;
    host.queries = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("places a user row from the skeleton, without asking the host", () => {
    const { requestFindReadOrdinal } = mountRead({
      read: { messageId: USER_ROW_ID, target: USER_ROW_ID },
      transcriptWindow: windowAt(EPOCH),
    });

    expect(requestFindReadOrdinal).toHaveBeenCalledWith(3);
    expect(sentLocates()).toEqual([]);
  });

  it("places a held record's row id from the skeleton, without asking the host", () => {
    const { requestFindReadOrdinal } = mountRead({
      read: { messageId: COLD_ASSISTANT_ID, target: HELD_ROW_ID },
      transcriptWindow: windowAt(EPOCH),
    });

    expect(requestFindReadOrdinal).toHaveBeenCalledWith(6);
    expect(sentLocates()).toEqual([]);
  });

  it("asks chat.locateRow for a cold assistant record by message id, and takes a same-epoch answer", () => {
    host.answer = { found: true, ordinal: 8, epoch: EPOCH };
    const { requestFindReadOrdinal } = mountRead({
      read: { messageId: COLD_ASSISTANT_ID, target: COLD_ASSISTANT_ID },
      transcriptWindow: windowAt(EPOCH),
    });

    const sent = sentLocates();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].method).toBe("chat.locateRow");
    expect(sent[0].params.target).toEqual({
      kind: "message",
      messageId: COLD_ASSISTANT_ID,
    });
    expect(sent[0].cacheKeyIdentity).toEqual([EPOCH]);
    expect(requestFindReadOrdinal).toHaveBeenCalledWith(8);
  });

  it("never passes on an ordinal numbered in another epoch", () => {
    host.answer = { found: true, ordinal: 8, epoch: EPOCH - 1 };
    const { onReadFailed, requestFindReadOrdinal } = mountRead({
      read: { messageId: COLD_ASSISTANT_ID, target: COLD_ASSISTANT_ID },
      transcriptWindow: windowAt(EPOCH),
    });

    expect(sentLocates().length).toBeGreaterThan(0);
    expect(requestFindReadOrdinal).not.toHaveBeenCalledWith(8);
    // Another epoch's answer is "not answered yet", not a refusal.
    expect(onReadFailed).not.toHaveBeenCalled();
  });

  it("fails the read on found:false, then releases the ordinal", () => {
    host.answer = { found: false };
    const { log, onReadFailed } = mountRead({
      read: { messageId: COLD_ASSISTANT_ID, target: COLD_ASSISTANT_ID },
      transcriptWindow: windowAt(EPOCH),
    });

    expect(onReadFailed).toHaveBeenCalledTimes(1);
    // Failure first, release second - and no ordinal was ever named.
    expect(log).toEqual([`failed:${COLD_ASSISTANT_ID}`, "ordinal:null"]);
  });

  it("fails the read when the locate RPC rejects", () => {
    host.isError = true;
    const { onReadFailed } = mountRead({
      read: { messageId: COLD_ASSISTANT_ID, target: COLD_ASSISTANT_ID },
      transcriptWindow: windowAt(EPOCH),
    });

    expect(onReadFailed).toHaveBeenCalledWith(COLD_ASSISTANT_ID);
  });

  it("fails a placed read that never ends once the TTL passes", () => {
    vi.useFakeTimers();
    const { onReadFailed, requestFindReadOrdinal } = mountRead({
      read: { messageId: USER_ROW_ID, target: USER_ROW_ID },
      transcriptWindow: windowAt(EPOCH),
    });
    expect(requestFindReadOrdinal).toHaveBeenCalledWith(3);

    vi.advanceTimersByTime(TRANSCRIPT_JUMP_TTL_MS - 1);
    expect(onReadFailed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onReadFailed).toHaveBeenCalledTimes(1);
    expect(onReadFailed).toHaveBeenCalledWith(USER_ROW_ID);
    expect(requestFindReadOrdinal).toHaveBeenLastCalledWith(null);
  });

  it("releases the ordinal when the read ends", () => {
    const transcript = windowAt(EPOCH);
    const { onReadFailed, requestFindReadOrdinal, rerender } = mountRead({
      read: { messageId: USER_ROW_ID, target: USER_ROW_ID },
      transcriptWindow: transcript,
    });
    expect(requestFindReadOrdinal).toHaveBeenLastCalledWith(3);

    rerender({ read: null, transcriptWindow: transcript });

    expect(requestFindReadOrdinal).toHaveBeenLastCalledWith(null);
    expect(onReadFailed).not.toHaveBeenCalled();
  });

  it("releases the ordinal on unmount", () => {
    const { requestFindReadOrdinal, unmount } = mountRead({
      read: { messageId: USER_ROW_ID, target: USER_ROW_ID },
      transcriptWindow: windowAt(EPOCH),
    });
    expect(requestFindReadOrdinal).toHaveBeenLastCalledWith(3);

    unmount();

    expect(requestFindReadOrdinal).toHaveBeenLastCalledWith(null);
  });
});
