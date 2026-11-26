import { expect } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { CommandFn } from "../../runner/runner";
import { buildBotCheckinsCommand } from "../bot-checkins";
import { buildBotListCommand } from "../bot-list";
import { buildBotPostCommand } from "../bot-post";
import { buildWorktreeDeleteCommand } from "../worktree-delete";
import {
  BOT_ID_A,
  CONVERSATION_ID,
  REPLY_MESSAGE_ID,
  REQUEST_ID,
  THREAD_ID,
  assistantRow,
  botRecord,
  botSnapshotFrame,
  chatSnapshotFrame,
  conversationRecord,
  userRow,
} from "./bot-test-support";
import { answerUnaryReads } from "./expired-host-token-seams";
import {
  type Member,
  type Outcome,
  type World,
} from "./expired-host-token-harness";

const WORKTREE = "/work/feature";
const BATCH = "worktree.deleteBatchByPath";

function completedWith(
  outcome: Outcome,
): Extract<Outcome, { kind: "completed" }> {
  if (outcome.kind !== "completed")
    expect.fail(`the command failed: ${outcome.message}`);
  return outcome;
}

function deleteServes(method: string): readonly unknown[] {
  if (method === BATCH)
    return [
      {
        kind: "target.complete",
        worktreePath: WORKTREE,
        deleted: true,
        hasBinaryPayload: false,
      },
    ];
  if (method === "worktree.deleteByPath")
    return [{ kind: "complete", deleted: true, hasBinaryPayload: false }];
  return [];
}

function deleteMember(title: string, lacksBatch: boolean): Member {
  return {
    title,
    faultedOpen: 0,
    prepare: (world) => {
      if (lacksBatch) world.host.lacks = [BATCH];
      world.host.serve = deleteServes;
    },
    start: (world) =>
      buildWorktreeDeleteCommand({ worktreePath: WORKTREE })(world.ctx),
    expectNormalResult: (outcome) => {
      expect(completedWith(outcome).result).toMatchObject({
        data: { worktreePath: WORKTREE, deleted: true },
        exitCode: 0,
      });
    },
  };
}

function thisHostsBot(world: World): BotRecord {
  return botRecord({ boundHostId: world.hostId });
}

function botMember(
  title: string,
  build: () => CommandFn,
  normal: (outcome: Outcome) => void,
): Member {
  return {
    title,
    faultedOpen: 0,
    prepare: (world) => {
      answerUnaryReads({
        "bot.list": () => ({ bots: [thisHostsBot(world)], mainBotIds: null }),
      });
      world.host.serve = (method) =>
        method === "bot.subscribe"
          ? [botSnapshotFrame(thisHostsBot(world), [], 0)]
          : [];
    },
    start: (world) => build()(world.ctx),
    expectNormalResult: normal,
  };
}

export const WORKTREE_DELETE_BATCH = deleteMember(
  "worktree delete, batch flow",
  false,
);
export const WORKTREE_DELETE_LEGACY = deleteMember(
  "worktree delete, legacy flow",
  true,
);

export const BOT_LIST = botMember(
  "bot list",
  () => buildBotListCommand(),
  (outcome) => {
    const { result } = completedWith(outcome);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      environments: [
        { bots: [{ botId: BOT_ID_A, readFailed: false, openRequestCount: 0 }] },
      ],
    });
  },
);

export const BOT_CHECKINS = botMember(
  "bot checkins",
  () => buildBotCheckinsCommand({ bot: BOT_ID_A, taskId: null }),
  (outcome) => {
    expect(completedWith(outcome).result).toMatchObject({
      data: { botId: BOT_ID_A, tasks: [] },
      exitCode: 0,
    });
  },
);

/** The channel resolves the post and names the reply; the thread holds it. */
function chatServes(params: unknown): readonly unknown[] {
  const chatId = (params as { readonly chatId: string }).chatId;
  const onChannel = chatId === CONVERSATION_ID;
  return [
    chatSnapshotFrame({
      botId: BOT_ID_A,
      conversationId: chatId,
      epoch: 1,
      rowCount: 1,
      indexRevision: null,
      tailFromOrdinal: 0,
      messages: [
        onChannel
          ? userRow({
              messageId: "msg-sent",
              requestId: REQUEST_ID,
              resolvedAt: 5_000,
              resolvedByMessageId: REPLY_MESSAGE_ID,
            })
          : assistantRow({
              messageId: REPLY_MESSAGE_ID,
              texts: ["All shipped."],
            }),
      ],
    }),
  ];
}

function postMember(title: string, faultedOpen: number): Member {
  return {
    title,
    faultedOpen,
    prepare: (world) => {
      answerUnaryReads({
        "bot.list": () => ({ bots: [thisHostsBot(world)], mainBotIds: null }),
        "bot.conversation.list": () => ({
          conversations: [
            conversationRecord({ conversationId: CONVERSATION_ID }),
          ],
        }),
        "bot.conversation.send": () => ({
          messageId: "msg-sent",
          requestId: REQUEST_ID,
          threadId: THREAD_ID,
          delivery: "written",
        }),
      });
      world.host.serve = (method, params) =>
        method === "chat.subscribe" ? chatServes(params) : [];
    },
    start: (world) =>
      buildBotPostCommand({ bot: BOT_ID_A, text: "ship it", wait: "30s" })(
        world.ctx,
      ),
    expectNormalResult: (outcome) => {
      expect(completedWith(outcome).result).toMatchObject({
        data: {
          outcome: {
            kind: "replied",
            replyMessageId: REPLY_MESSAGE_ID,
            text: "All shipped.",
          },
        },
        exitCode: 0,
      });
    },
  };
}

/**
 * The first follow of `bot post --wait` (the channel) is the open the expired
 * token is refused on: the realistic case, where nothing was admitted yet.
 */
export const BOT_POST_LISTENER = postMember("bot post's listener", 0);
/**
 * The thread follow, after the channel follow was admitted: the open the
 * dial-wide fence leaves unrecovered (the head's limit L1).
 */
export const BOT_POST_THREAD_FOLLOW = postMember("bot post's thread follow", 1);
