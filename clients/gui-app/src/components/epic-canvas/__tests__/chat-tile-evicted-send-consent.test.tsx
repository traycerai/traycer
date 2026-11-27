import "./chat-tile-evicted-send-stubs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { settleLegendList } from "@/components/chat/__tests__/legend-list-test-environment";
import { composerDraftIsEmpty } from "@/hooks/chats/use-initial-chat-handoff-driver";
import type { SentChatMessage } from "@/components/share-on-x/sent-messages";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  HOST_ID,
  TEAM_ENVIRONMENT_OWNER_ID,
} from "./chat-tile-evicted-send-mock-state";
import {
  ADMITTED_SAVED_CREATOR_ACCESS,
  CHAT_ARTIFACT,
  EPIC_ID,
  FIRST_TEXT,
  POOL_VIEWER_ACCESS,
  SECOND_TEXT,
  TEAM_CREATOR_CHAT_SOURCE,
  acceptMessage,
  answerHydrate,
  clickSend,
  draftOf,
  expectRetainedDraftToast,
  mountOnThePool,
  observeSentMessages,
  openStream,
  pendingRows,
  putInComposer,
  resetEvictedSendFixture,
  rowsWithText,
  runningShell,
  sendFramesOf,
  settleEvictedSendHostTier,
  stageRebind,
  streams,
  teardownEvictedSendFixture,
  textInContent,
} from "./chat-tile-evicted-send-support";

/**
 * A message to a chat its host dropped the records of, through the real tile:
 * the pool serves the transcript (a copy that cannot act), the message is
 * parked and drawn as a pending send, the host is asked for the chat
 * (`epic.hydrateChat`), and once the host answers the session moves there and
 * sends the message by the ordinary road. Faked: the chat streams, the
 * serving witness's stream and the `epic.hydrateChat` RPC. Everything between
 * the composer and the transcript is the real code.
 */

beforeAll(settleEvictedSendHostTier);

beforeEach(resetEvictedSendFixture);

afterEach(teardownEvictedSendFixture);

describe("a message sent to a chat the pool serves because its host dropped the records", () => {
  it("serializes consent for two parked sends and dispatches them in order", async () => {
    const reported: SentChatMessage[] = [];
    observeSentMessages(reported);
    stageRebind();
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    putInComposer(SECOND_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(2));
    await settleLegendList();
    await answerHydrate(0);
    await settleLegendList();
    await waitFor(() => expect(streams).toHaveLength(2));
    await settleLegendList();
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      [runningShell()],
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await settleLegendList();

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    expect(pendingRows()).toHaveLength(2);
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
    expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(reported).toEqual([]);

    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));
    await waitFor(() => expect(sendFramesOf(streams[1])).toHaveLength(2));
    await waitFor(() => expect(reported).toHaveLength(2));
    expect(
      sendFramesOf(streams[1]).map((frame) => textInContent(frame.content)),
    ).toEqual([FIRST_TEXT, SECOND_TEXT]);
    expect(reported).toEqual([
      { text: FIRST_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
      { text: SECOND_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
    ]);
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    const [first, second] = sendFramesOf(streams[1]);
    acceptMessage(streams[1], first);
    acceptMessage(streams[1], second);
    await waitFor(() => expect(pendingRows()).toHaveLength(0));
  });

  it("restores both parked sends when each consent is cancelled", async () => {
    const reported: SentChatMessage[] = [];
    observeSentMessages(reported);
    stageRebind();
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    putInComposer(SECOND_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(2));
    await settleLegendList();
    await answerHydrate(0);
    await settleLegendList();
    await waitFor(() => expect(streams).toHaveLength(2));
    await settleLegendList();
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      [runningShell()],
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await settleLegendList();

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    expect(pendingRows()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("teardown-commit-cancel"));
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(reported).toEqual([]);

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    fireEvent.click(screen.getByTestId("teardown-commit-cancel"));
    await waitFor(() => expect(pendingRows()).toHaveLength(0));
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(streams[0].sent).toEqual([]);
    expect(reported).toEqual([]);
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expectRetainedDraftToast(SECOND_TEXT);
  });
});
