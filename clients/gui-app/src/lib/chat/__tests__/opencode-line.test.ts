import { describe, expect, it } from "vitest";
import {
  chatOpencodeLine,
  chatRunsOpencodeLineOne,
  epicCreateChatCarriesOpencodeLine,
} from "@/lib/chat/opencode-line";

type ChainArg = Parameters<typeof chatOpencodeLine>[0]["activeSessionChain"];

function chain(harnessId: string): NonNullable<ChainArg> {
  return { harnessId } as NonNullable<ChainArg>;
}

describe("chatOpencodeLine", () => {
  it("returns the recorded line over everything else", () => {
    expect(
      chatOpencodeLine({
        opencodeLine: 2,
        activeSessionChain: chain("opencode"),
      }),
    ).toBe(2);
    expect(
      chatOpencodeLine({ opencodeLine: 1, activeSessionChain: null }),
    ).toBe(1);
  });

  it.each(["opencode", "traycer", "openrouter", "huggingface"])(
    "reads a pre-line %s session as line 1",
    (harnessId) => {
      expect(chatOpencodeLine({ activeSessionChain: chain(harnessId) })).toBe(
        1,
      );
    },
  );

  it("is null for a chat with no OpenCode-family session", () => {
    expect(chatOpencodeLine({ activeSessionChain: null })).toBeNull();
    expect(
      chatOpencodeLine({ activeSessionChain: chain("claude-code") }),
    ).toBeNull();
  });
});

describe("chatRunsOpencodeLineOne", () => {
  const settings = (harnessId: string) =>
    ({ harnessId }) as NonNullable<
      Parameters<typeof chatRunsOpencodeLineOne>[0]["settings"]
    >;

  it("is true for an opencode chat on line 1, recorded or pre-line", () => {
    expect(
      chatRunsOpencodeLineOne({
        settings: settings("opencode"),
        opencodeLine: 1,
        activeSessionChain: null,
      }),
    ).toBe(true);
    expect(
      chatRunsOpencodeLineOne({
        settings: settings("opencode"),
        activeSessionChain: chain("opencode"),
      }),
    ).toBe(true);
  });

  it("is false on line 2, for siblings, and with no settings or line", () => {
    expect(
      chatRunsOpencodeLineOne({
        settings: settings("opencode"),
        opencodeLine: 2,
        activeSessionChain: null,
      }),
    ).toBe(false);
    expect(
      chatRunsOpencodeLineOne({
        settings: settings("openrouter"),
        opencodeLine: 1,
        activeSessionChain: null,
      }),
    ).toBe(false);
    expect(
      chatRunsOpencodeLineOne({
        settings: settings("opencode"),
        activeSessionChain: null,
      }),
    ).toBe(false);
    expect(
      chatRunsOpencodeLineOne({
        settings: null,
        opencodeLine: 1,
        activeSessionChain: null,
      }),
    ).toBe(false);
  });
});

describe("epicCreateChatCarriesOpencodeLine", () => {
  it("needs epic.createChat 1.3 or newer", () => {
    expect(epicCreateChatCarriesOpencodeLine(null)).toBe(false);
    expect(epicCreateChatCarriesOpencodeLine({ major: 1, minor: 2 })).toBe(
      false,
    );
    expect(epicCreateChatCarriesOpencodeLine({ major: 1, minor: 3 })).toBe(
      true,
    );
    expect(epicCreateChatCarriesOpencodeLine({ major: 2, minor: 0 })).toBe(
      true,
    );
  });
});
