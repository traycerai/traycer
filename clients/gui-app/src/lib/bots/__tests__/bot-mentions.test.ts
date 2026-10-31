import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  matchMentionCandidates,
  mentionsToDisplay,
  mentionsToWire,
  type BotMentionCandidate,
} from "@/lib/bots/bot-mentions";

const member = (userId: string, name: string): BotMentionCandidate => ({
  userId,
  name,
  avatarUrl: null,
});

const ANN = member("u-ann", "Ann");
const ANN_LEE = member("u-ann-lee", "Ann Lee");
const BOB = member("u-bob", "Bob");

describe("mentionsToWire", () => {
  it("writes a member's token for their @Name", () => {
    expect(mentionsToWire("hi @Bob, look", [BOB], [])).toBe(
      "hi <@u-bob>, look",
    );
  });

  it("matches the longest name first, so @Ann Lee is not read as @Ann", () => {
    expect(mentionsToWire("@Ann Lee and @Ann", [ANN, ANN_LEE], [])).toBe(
      "<@u-ann-lee> and <@u-ann>",
    );
  });

  it("leaves a name two members share alone", () => {
    expect(
      mentionsToWire("@Bob hello", [BOB, member("u-bob-2", "Bob")], []),
    ).toBe("@Bob hello");
  });

  it("sends a name two members share to the one picked, and each later one to the next pick", () => {
    const first = member("u-bob-1", "Bob");
    const second = member("u-bob-2", "Bob");
    expect(mentionsToWire("@Bob hello", [first, second], ["u-bob-2"])).toBe(
      "<@u-bob-2> hello",
    );
    expect(
      mentionsToWire("@Bob and @Bob", [first, second], ["u-bob-2", "u-bob-1"]),
    ).toBe("<@u-bob-2> and <@u-bob-1>");
  });

  it("leaves a shared name as typed once its picks are spent, and ignores a pick that names no one with it", () => {
    const first = member("u-bob-1", "Bob");
    const second = member("u-bob-2", "Bob");
    expect(mentionsToWire("@Bob and @Bob", [first, second], ["u-bob-1"])).toBe(
      "<@u-bob-1> and @Bob",
    );
    expect(mentionsToWire("@Bob", [first, second], ["u-ann"])).toBe("@Bob");
  });

  it("leaves an @ inside a word, and a name that runs on into more letters", () => {
    expect(mentionsToWire("mail a@Bob.com and @Bobby", [BOB], [])).toBe(
      "mail a@Bob.com and @Bobby",
    );
  });

  it("takes a name at the start and end of the text and before punctuation", () => {
    expect(mentionsToWire("@Bob", [BOB], [])).toBe("<@u-bob>");
    expect(mentionsToWire("ask @Bob?", [BOB], [])).toBe("ask <@u-bob>?");
    expect(mentionsToWire("(@Bob)", [BOB], [])).toBe("(<@u-bob>)");
  });

  it("leaves a name nobody has, and a member with a blank name, alone", () => {
    expect(mentionsToWire("@Zed @", [BOB, member("u-x", "  ")], [])).toBe(
      "@Zed @",
    );
  });
});

describe("mentionsToDisplay", () => {
  it("shows a known member's token as @Name and leaves any other token as it is", () => {
    const nameOf = (id: string): string | null =>
      id === "u-bob" ? "Bob" : null;
    expect(mentionsToDisplay("hi <@u-bob> and <@u-zed>", nameOf)).toBe(
      "hi @Bob and <@u-zed>",
    );
  });
});

describe("activeMentionQuery", () => {
  it("finds the @ being typed at the caret, at the start or after a space", () => {
    expect(activeMentionQuery("@an", 3)).toEqual({ start: 0, query: "an" });
    expect(activeMentionQuery("hi @an", 6)).toEqual({ start: 3, query: "an" });
    expect(activeMentionQuery("hi @", 4)).toEqual({ start: 3, query: "" });
  });

  it("finds none inside a word, past a space, or when the caret is before it", () => {
    expect(activeMentionQuery("a@b", 3)).toBeNull();
    expect(activeMentionQuery("@an bob", 7)).toBeNull();
    expect(activeMentionQuery("hi @an", 2)).toBeNull();
  });
});

describe("matchMentionCandidates", () => {
  it("matches the start of any word of a name, case-insensitively", () => {
    const lee = member("u-lee", "Mary Lee");
    expect(matchMentionCandidates([ANN, BOB, lee], "le")).toEqual([lee]);
    expect(matchMentionCandidates([ANN, BOB, lee], "AN")).toEqual([ANN]);
    expect(matchMentionCandidates([lee], "mary l")).toEqual([lee]);
  });

  it("lists everyone for an empty query", () => {
    expect(matchMentionCandidates([ANN, BOB], "")).toEqual([ANN, BOB]);
  });
});
