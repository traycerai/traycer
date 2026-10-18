import { describe, expect, it } from "vitest";
import type { OpenUserMessageSender } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import type { SenderDisplayContext } from "@/lib/chat/sender-display";
import {
  botUserSenderLabel,
  UNRESOLVED_BOT_MEMBER_NAMES,
} from "@/lib/bots/bot-member-names";

const VIEWER_ID = "user-viewer";

const context: SenderDisplayContext = {
  profile: { userId: VIEWER_ID, userName: "Viewer", email: "v@example.com" },
  collaborators: [],
  modelLabels: new Map(),
  modelReasoningLabels: new Map(),
  modelServiceTierLabels: new Map(),
};

const userSender = (userId: string): OpenUserMessageSender => ({
  type: "user",
  userId,
});

describe("botUserSenderLabel", () => {
  it("labels the viewer's own message You without asking the resolver", () => {
    const asked: string[] = [];
    const label = botUserSenderLabel(userSender(VIEWER_ID), context, (id) => {
      asked.push(id);
      return "Someone Else";
    });

    expect(label).toBe("You");
    expect(asked).toEqual([]);
  });

  it("labels another member with the name the resolver gives", () => {
    const label = botUserSenderLabel(
      userSender("user-teammate"),
      context,
      () => "Tess Teammate",
    );

    expect(label).toBe("Tess Teammate");
  });

  it("falls back to the member's user id when the resolver does not know them", () => {
    expect(
      botUserSenderLabel(
        userSender("user-teammate"),
        context,
        UNRESOLVED_BOT_MEMBER_NAMES,
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

    expect(botUserSenderLabel(sender, context, () => "Not Used")).toBe(
      "Planner",
    );
  });
});
