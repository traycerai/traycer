/**
 * What a bot's message box does with images (`useBotImageReach`): the host
 * serving the tab must negotiate `bot.conversation.send@1.4`, and the bot's
 * bound host must be that host or have said it takes images. Only the
 * negotiated-version read is faked.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  useBotImageReach,
  type BotImageReach,
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

function reachWith(
  negotiated: SchemaVersion | null,
  bound: {
    readonly boundHostId: string | null;
    readonly boundHostTakes: readonly string[];
  },
): BotImageReach {
  mocks.negotiated = negotiated;
  mocks.reads.length = 0;
  return renderHook(() => useBotImageReach({ hostId: TAB_HOST, ...bound }))
    .result.current;
}

describe("useBotImageReach", () => {
  it("asks the host serving the tab for its negotiated bot.conversation.send", () => {
    reachWith(
      { major: 1, minor: 4 },
      {
        boundHostId: TAB_HOST,
        boundHostTakes: [],
      },
    );

    expect(mocks.reads).toContainEqual([TAB_HOST, "bot.conversation.send"]);
  });

  it("offers nothing against a host below 1.4, whatever the bound host takes", () => {
    expect(
      reachWith(
        { major: 1, minor: 3 },
        { boundHostId: TAB_HOST, boundHostTakes: ["images"] },
      ),
    ).toBe("none");
  });

  it("offers nothing while the host has negotiated no version", () => {
    expect(
      reachWith(null, { boundHostId: TAB_HOST, boundHostTakes: ["images"] }),
    ).toBe("none");
  });

  it("delivers where the bot runs on the host serving the tab, with no word from it", () => {
    expect(
      reachWith(
        { major: 1, minor: 4 },
        { boundHostId: TAB_HOST, boundHostTakes: [] },
      ),
    ).toBe("delivered");
  });

  it("delivers to another host that lists images among what it takes", () => {
    expect(
      reachWith(
        { major: 1, minor: 4 },
        { boundHostId: OTHER_HOST, boundHostTakes: ["answer", "images"] },
      ),
    ).toBe("delivered");
  });

  it("holds the images back from another host that has not said it takes them", () => {
    expect(
      reachWith(
        { major: 1, minor: 4 },
        { boundHostId: OTHER_HOST, boundHostTakes: ["answer", "message"] },
      ),
    ).toBe("held-back");
  });

  it("holds the images back while no host runs the bot", () => {
    expect(
      reachWith(
        { major: 1, minor: 4 },
        { boundHostId: null, boundHostTakes: [] },
      ),
    ).toBe("held-back");
  });
});
