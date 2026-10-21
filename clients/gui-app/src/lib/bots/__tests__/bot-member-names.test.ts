import { describe, expect, it } from "vitest";
import type { OpenUserMessageSender } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import type { SenderDisplayContext } from "@/lib/chat/sender-display";
import {
  botCreatedByLabel,
  botUserSenderAvatarUrl,
  botUserSenderLabel,
  UNRESOLVED_BOT_MEMBERS,
  type BotMember,
} from "@/lib/bots/bot-member-names";

const VIEWER_ID = "user-viewer";

const context: SenderDisplayContext = {
  profile: { userId: VIEWER_ID, userName: "Viewer", email: "v@example.com" },
  collaborators: [],
  modelLabels: new Map(),
  modelReasoningLabels: new Map(),
  modelServiceTierLabels: new Map(),
};

const member = (displayName: string | null): BotMember => ({
  displayName,
  avatarUrl: null,
});

const userSender = (userId: string): OpenUserMessageSender => ({
  type: "user",
  userId,
});

describe("botUserSenderLabel", () => {
  it("labels the viewer's own message You without asking the resolver", () => {
    const asked: string[] = [];
    const label = botUserSenderLabel(userSender(VIEWER_ID), context, (id) => {
      asked.push(id);
      return member("Someone Else");
    });

    expect(label).toBe("You");
    expect(asked).toEqual([]);
  });

  it("labels another member with the name the resolver gives", () => {
    const label = botUserSenderLabel(userSender("user-teammate"), context, () =>
      member("Tess Teammate"),
    );

    expect(label).toBe("Tess Teammate");
  });

  it("falls back to the member's user id when the directory knows them without a name", () => {
    expect(
      botUserSenderLabel(userSender("user-teammate"), context, () =>
        member(null),
      ),
    ).toBe("user-teammate");
  });

  it("falls back to the member's user id when the resolver does not know them", () => {
    expect(
      botUserSenderLabel(
        userSender("user-teammate"),
        context,
        UNRESOLVED_BOT_MEMBERS,
      ),
    ).toBe("user-teammate");
  });

  it("labels an agent sender by its display name, as any other chat does", () => {
    const sender: OpenUserMessageSender = {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Planner",
      reply: { expectsReply: false },
      inReplyTo: null,
    };

    expect(botUserSenderLabel(sender, context, () => member("Not Used"))).toBe(
      "Planner",
    );
  });
});

describe("botUserSenderAvatarUrl", () => {
  it("answers a member's picture, the viewer's included, and none for an agent or an unknown member", () => {
    const resolve = (userId: string): BotMember | null =>
      userId === "user-unknown"
        ? null
        : { displayName: null, avatarUrl: `https://avatars/${userId}.png` };
    const agent: OpenUserMessageSender = {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Planner",
      reply: { expectsReply: false },
      inReplyTo: null,
    };

    expect(botUserSenderAvatarUrl(userSender(VIEWER_ID), resolve)).toBe(
      "https://avatars/user-viewer.png",
    );
    expect(botUserSenderAvatarUrl(userSender("user-teammate"), resolve)).toBe(
      "https://avatars/user-teammate.png",
    );
    expect(botUserSenderAvatarUrl(userSender("user-unknown"), resolve)).toBe(
      null,
    );
    expect(botUserSenderAvatarUrl(agent, resolve)).toBe(null);
  });
});

describe("botCreatedByLabel", () => {
  const resolveTeammate = (userId: string): BotMember | null =>
    userId === "user-teammate" ? member("Tess Teammate") : member(null);

  it("says nothing, never an id, for a personal bot, an erased creator, or a member without a name or unknown", () => {
    const base = {
      viewerUserId: VIEWER_ID,
      isTeamBot: true,
      resolveMember: resolveTeammate,
    };

    expect(
      botCreatedByLabel({
        ...base,
        createdByUserId: "user-teammate",
        isTeamBot: false,
      }),
    ).toBe(null);
    expect(botCreatedByLabel({ ...base, createdByUserId: null })).toBe(null);
    expect(
      botCreatedByLabel({ ...base, createdByUserId: "user-nameless" }),
    ).toBe(null);
    expect(
      botCreatedByLabel({
        ...base,
        createdByUserId: "user-teammate",
        resolveMember: UNRESOLVED_BOT_MEMBERS,
      }),
    ).toBe(null);
  });
});
