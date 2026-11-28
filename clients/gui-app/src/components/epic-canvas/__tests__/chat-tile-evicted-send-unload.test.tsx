import "./chat-tile-evicted-send-stubs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { settleLegendList } from "@/components/chat/__tests__/legend-list-test-environment";
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
  answerHydrate,
  clickSend,
  draftOf,
  expectRetainedDraftToast,
  hydrates,
  imageRootHeld,
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
  it.each(["unmount", "pagehide", "confirm-close"] as const)(
    "settles consent correctly during %s",
    async (lifecycle) => {
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
      expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
      expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
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
      expect(
        await screen.findByTestId("teardown-commit-dialog"),
      ).not.toBeNull();
      expect(pendingRows()).toHaveLength(2);
      expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
      expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
      expect(reported).toEqual([]);

      if (lifecycle === "confirm-close") {
        const confirm = screen.getByTestId("teardown-commit-immediate");
        act(() => {
          fireEvent.click(confirm);
          cleanup();
        });
        await waitFor(() => {
          expect(sendFramesOf(streams[1])).toHaveLength(1);
        });
        await waitFor(() => {
          expect(reported).toEqual([
            { text: FIRST_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
          ]);
        });
        expect(sendFramesOf(streams[0])).toEqual([]);
        expect(textInContent(sendFramesOf(streams[1])[0].content)).toBe(
          FIRST_TEXT,
        );
        expect(
          useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
        ).toEqual(draftOf(SECOND_TEXT));
        expect(
          toast
            .getToasts()
            .filter(
              (entry) =>
                "duration" in entry &&
                entry.duration === Number.POSITIVE_INFINITY,
            ),
        ).toEqual([]);
        expect(pendingRows()).toHaveLength(0);
        expect(imageRootHeld()).toBe(false);
      } else if (lifecycle === "pagehide") {
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
      } else {
        cleanup();
      }

      if (lifecycle !== "confirm-close") {
        expect(
          useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
        ).toEqual(draftOf(FIRST_TEXT));
        expectRetainedDraftToast(SECOND_TEXT);
        expect(imageRootHeld()).toBe(false);
        expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
        expect(pendingRows()).toHaveLength(0);
        expect(streams.flatMap(sendFramesOf)).toEqual([]);
        expect(hydrates).toHaveLength(1);
        expect(reported).toEqual([]);
      }
    },
  );
});
