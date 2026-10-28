import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { BOT_THREAD_ANCHOR_ANSWER } from "@traycer/protocol/host/bot/conversation-schemas";

const LISTED = { threads: [], trunkCostUsd: 0.25 } as const;

describe("bot.thread.list@1.1 thread anchors", () => {
  const line = hostRpcRegistry["bot.thread.list"][1];
  const latest = line.versions[line.latestMinor].contract;
  const frozen = line.versions[0].contract;

  it("upgrades a 1.0 host's answer to one that names no anchor", () => {
    const upgrade = line.versions[line.latestMinor].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.0 to 1.1 upgrade path");
    expect(
      upgrade.upgradeResponse(frozen.responseSchema.parse(LISTED)),
    ).toEqual({ ...LISTED, threadAnchors: [] });
  });

  it("freezes 1.0 without the anchors, and keeps them on 1.1", () => {
    const named = { ...LISTED, threadAnchors: [BOT_THREAD_ANCHOR_ANSWER] };
    expect(frozen.responseSchema.parse(named)).toEqual(LISTED);
    expect(latest.responseSchema.parse(named)).toEqual(named);
  });

  it("keeps an anchor a client does not know, for the client to ignore", () => {
    const later = { ...LISTED, threadAnchors: ["answer", "later-kind"] };
    expect(latest.responseSchema.parse(later)).toEqual(later);
  });
});
