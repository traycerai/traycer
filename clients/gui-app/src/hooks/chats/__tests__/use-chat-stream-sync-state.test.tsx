import "../../../../__tests__/test-browser-apis";
import { renderHook, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useChatStreamSyncState } from "@/hooks/chats/use-chat-stream-sync-state";

afterEach(cleanup);

describe("useChatStreamSyncState", () => {
  it("reports a closed stream when no session is open for the pair", () => {
    // The registry is real here and holds nothing. `closed` rather than
    // `connecting` is the load-bearing part: a tile with no chat session is
    // not coming back, and reporting otherwise would put a syncing strip on a
    // surface that has no stream at all.
    const { result } = renderHook(() =>
      useChatStreamSyncState("epic-1", "chat-1", "host-A"),
    );
    expect(result.current.status).toBe("closed");
    expect(result.current.hasContent).toBe(false);
  });

  it("reports a closed stream for a surface that names no host", () => {
    // A chat id alone does not identify a session - it is host-minted - so a
    // caller with no host must resolve nothing rather than fall back to
    // whichever host happens to be active.
    const { result } = renderHook(() =>
      useChatStreamSyncState("epic-1", "chat-1", null),
    );
    expect(result.current.status).toBe("closed");
  });
});
