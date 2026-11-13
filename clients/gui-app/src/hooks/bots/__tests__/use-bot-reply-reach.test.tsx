/**
 * What a member's Reply does (`useBotReplyReach`, Tracy Bots T166): the host
 * serving the tab must negotiate `bot.conversation.send@1.6`, and the bot's
 * bound host must be that host or have said it takes replies. Only the
 * negotiated-version read is faked.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  useBotReplyReach,
  type BotReplyReach,
} from "@/hooks/bots/use-bot-send-version";

const mocks = vi.hoisted(() => ({
  negotiated: null as SchemaVersion | null,
  reads: [] as Array<readonly [string | null, string]>,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: (hostId: string | null, method: string) => {
    mocks.reads.push([hostId, method]);
    return mocks.negotiated;
  },
}));

const TAB_HOST = "host-tab";
const OTHER_HOST = "host-elsewhere";
const REPLIES: SchemaVersion = { major: 1, minor: 6 };

function reachWith(
  negotiated: SchemaVersion | null,
  bound: {
    readonly boundHostId: string | null;
    readonly boundHostTakes: readonly string[];
  },
): BotReplyReach {
  mocks.negotiated = negotiated;
  mocks.reads.length = 0;
  return renderHook(() => useBotReplyReach({ hostId: TAB_HOST, ...bound }))
    .result.current;
}

describe("useBotReplyReach", () => {
  it("asks the host serving the tab for its negotiated bot.conversation.send", () => {
    reachWith(REPLIES, { boundHostId: TAB_HOST, boundHostTakes: [] });

    expect(mocks.reads).toContainEqual([TAB_HOST, "bot.conversation.send"]);
  });

  it("offers nothing against a host below 1.6, whatever the bound host takes", () => {
    expect(
      reachWith(
        { major: 1, minor: 5 },
        { boundHostId: TAB_HOST, boundHostTakes: ["replies"] },
      ),
    ).toBe("none");
  });

  it("offers nothing while the host has negotiated no version", () => {
    expect(
      reachWith(null, { boundHostId: TAB_HOST, boundHostTakes: ["replies"] }),
    ).toBe("none");
  });

  it("delivers where the bot runs on the host serving the tab, with no word from it", () => {
    expect(
      reachWith(REPLIES, { boundHostId: TAB_HOST, boundHostTakes: [] }),
    ).toBe("delivered");
  });

  it("delivers to another host that lists replies among what it takes", () => {
    expect(
      reachWith(REPLIES, {
        boundHostId: OTHER_HOST,
        boundHostTakes: ["images", "replies"],
      }),
    ).toBe("delivered");
  });

  it("holds replies back from another host that has not said it takes them", () => {
    expect(
      reachWith(REPLIES, {
        boundHostId: OTHER_HOST,
        boundHostTakes: ["images", "answers"],
      }),
    ).toBe("held-back");
  });

  it("holds replies back while no host runs the bot", () => {
    expect(reachWith(REPLIES, { boundHostId: null, boundHostTakes: [] })).toBe(
      "held-back",
    );
  });
});
