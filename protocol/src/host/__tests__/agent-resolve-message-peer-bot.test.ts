import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

const TASK_PEER = {
  epicId: "epic-1",
  agentId: "agent-1",
  hostId: "host-1",
  title: "Researcher",
  surface: "gui",
} as const;
const BOT = { botId: "bot-1", title: "Release bot" } as const;

describe("agent.resolveMessagePeer@1.1 bot peer", () => {
  const line = hostRpcRegistry["agent.resolveMessagePeer"][1];
  const latest = line.versions[line.latestMinor].contract;
  const frozen = line.versions[0].contract;

  it("upgrades a 1.0 host's peer to one that names no bot, and keeps an unresolved peer null", () => {
    const upgrade = line.versions[line.latestMinor].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.0 to 1.1 upgrade path");
    expect(
      upgrade.upgradeResponse(frozen.responseSchema.parse({ peer: TASK_PEER })),
    ).toEqual({ peer: { ...TASK_PEER, bot: null } });
    expect(
      upgrade.upgradeResponse(frozen.responseSchema.parse({ peer: null })),
    ).toEqual({ peer: null });
  });

  it("freezes 1.0 without the bot, and keeps it on 1.1", () => {
    const named = { peer: { ...TASK_PEER, bot: BOT } };
    expect(frozen.responseSchema.parse(named)).toEqual({ peer: TASK_PEER });
    expect(latest.responseSchema.parse(named)).toEqual(named);
  });

  it("requires 1.1 to say whether the peer is a bot", () => {
    expect(latest.responseSchema.safeParse({ peer: TASK_PEER }).success).toBe(
      false,
    );
    expect(
      latest.responseSchema.safeParse({ peer: { ...TASK_PEER, bot: null } })
        .success,
    ).toBe(true);
  });
});
