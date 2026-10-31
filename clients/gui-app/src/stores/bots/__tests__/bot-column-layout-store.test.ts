import { beforeEach, describe, expect, it } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import {
  buildHomeBotsModel,
  type HomeBotsModel,
} from "@/lib/home-bots/bots-model";
import { useBotColumnLayoutStore } from "@/stores/bots/bot-column-layout-store";

function environment(environmentId: string): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label: environmentId,
  };
}

function bot(botId: string, environmentId: string): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: "user-1",
    title: botId,
    harness: "claude",
    model: "opus",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: "host-record",
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
  };
}

function modelOf(
  environmentIds: ReadonlyArray<string>,
  bots: ReadonlyArray<BotRecord>,
): HomeBotsModel {
  return buildHomeBotsModel({
    environments: environmentIds.map(environment),
    bots,
    mainBotIds: null,
  });
}

const FULL = modelOf(
  ["env-a", "env-b", "env-c"],
  [bot("a1", "env-a"), bot("a2", "env-a"), bot("b1", "env-b")],
);

beforeEach(() => {
  localStorage.clear();
  useBotColumnLayoutStore.setState({
    sectionOrder: [],
    channelOrder: {},
    collapsed: [],
  });
});

describe("useBotColumnLayoutStore", () => {
  it("prunes an environment the model lost from the order, the channel orders and the collapsed set on the next write", () => {
    const { setSectionOrder, setChannelOrder, setCollapsed } =
      useBotColumnLayoutStore.getState();
    setSectionOrder(["env-b", "env-a"], FULL);
    setChannelOrder("env-a", ["a2", "a1"], FULL);
    setChannelOrder("env-b", ["b1"], FULL);
    setCollapsed("env-b", true, FULL);

    // The person left env-b; the next write, to another section, is made
    // against a model that no longer carries it.
    const withoutB = modelOf(
      ["env-a", "env-c"],
      [bot("a1", "env-a"), bot("a2", "env-a")],
    );
    setCollapsed("env-c", true, withoutB);

    const state = useBotColumnLayoutStore.getState();
    expect(state.sectionOrder).toEqual(["env-a"]);
    expect(state.channelOrder).toEqual({ "env-a": ["a2", "a1"] });
    expect(state.collapsed).toEqual(["env-c"]);
  });

  it("prunes a bot the model lost from every section's channel order, and drops an order left empty", () => {
    const { setChannelOrder, setCollapsed } =
      useBotColumnLayoutStore.getState();
    setChannelOrder("env-a", ["a2", "a1"], FULL);
    setChannelOrder("env-b", ["b1"], FULL);

    // a2 and b1 were archived; the next write is to a third section.
    const afterArchive = modelOf(
      ["env-a", "env-b", "env-c"],
      [bot("a1", "env-a"), bot("b2", "env-b")],
    );
    setCollapsed("env-c", true, afterArchive);

    expect(useBotColumnLayoutStore.getState().channelOrder).toEqual({
      "env-a": ["a1"],
    });
  });

  it("drops a bot named under an environment it does not belong to", () => {
    useBotColumnLayoutStore
      .getState()
      .setChannelOrder("env-a", ["b1", "a1"], FULL);

    expect(useBotColumnLayoutStore.getState().channelOrder).toEqual({
      "env-a": ["a1"],
    });
  });

  it("expands a collapsed section again", () => {
    const { setCollapsed } = useBotColumnLayoutStore.getState();
    setCollapsed("env-a", true, FULL);
    setCollapsed("env-b", true, FULL);
    setCollapsed("env-a", false, FULL);

    expect(useBotColumnLayoutStore.getState().collapsed).toEqual(["env-b"]);
  });
});
