import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  matchMentionCandidates,
  mentionsToDisplay,
  mentionsToWire,
  shiftMentionPicks,
  spliceMentionPicks,
  type BotMentionCandidate,
  type BotMentionPick,
} from "@/lib/bots/bot-mentions";

const member = (userId: string, name: string): BotMentionCandidate => ({
  userId,
  name,
  avatarUrl: null,
});

const ANN = member("u-ann", "Ann");
const ANN_LEE = member("u-ann-lee", "Ann Lee");
const BOB = member("u-bob", "Bob");
const BOB_1 = member("u-bob-1", "Bob");
const BOB_2 = member("u-bob-2", "Bob");

const pick = (start: number, end: number, userId: string): BotMentionPick => ({
  start,
  end,
  userId,
});

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

  it("sends a shared name to the member whose pick still reads @Name there", () => {
    expect(
      mentionsToWire("@Bob hello", [BOB_1, BOB_2], [pick(0, 4, "u-bob-2")]),
    ).toBe("<@u-bob-2> hello");
    expect(
      mentionsToWire(
        "@Bob and @Bob",
        [BOB_1, BOB_2],
        [pick(0, 4, "u-bob-2"), pick(9, 13, "u-bob-1")],
      ),
    ).toBe("<@u-bob-2> and <@u-bob-1>");
  });

  it("leaves a shared name as typed where no pick reads it: the pick's range moved, or names someone else", () => {
    // The only pick sits on the first mention; the second has none.
    expect(
      mentionsToWire("@Bob and @Bob", [BOB_1, BOB_2], [pick(0, 4, "u-bob-1")]),
    ).toBe("<@u-bob-1> and @Bob");
    // A pick whose range no longer reads its member's @Name is not emitted.
    expect(
      mentionsToWire("hey @Bob", [BOB_1, BOB_2], [pick(0, 4, "u-bob-1")]),
    ).toBe("hey @Bob");
    expect(
      mentionsToWire("@Bobby", [BOB_1, BOB_2], [pick(0, 4, "u-bob-1")]),
    ).toBe("@Bobby");
    expect(mentionsToWire("@Bob", [BOB_1, BOB_2], [pick(0, 4, "u-ann")])).toBe(
      "@Bob",
    );
  });

  describe("a shared full name beside a shorter unique name", () => {
    const SHORT = member("u-short", "Ann");
    const LEE_1 = member("u-lee-1", "Ann Lee");
    const LEE_2 = member("u-lee-2", "Ann Lee");

    it("stays as typed with no pick, rather than reading as the shorter name and a word", () => {
      expect(mentionsToWire("hi @Ann Lee", [SHORT, LEE_1, LEE_2], [])).toBe(
        "hi @Ann Lee",
      );
    });

    it("still gives the token of a shared name's valid pick", () => {
      expect(
        mentionsToWire(
          "hi @Ann Lee",
          [SHORT, LEE_1, LEE_2],
          [pick(3, 11, "u-lee-2")],
        ),
      ).toBe("hi <@u-lee-2>");
    });

    it("still gives the unique shorter name its token", () => {
      expect(mentionsToWire("hi @Ann", [SHORT, LEE_1, LEE_2], [])).toBe(
        "hi <@u-short>",
      );
    });
  });

  it("writes a unique name typed plainly with no pick as that member's token", () => {
    expect(mentionsToWire("hi @Bob", [BOB, ANN], [])).toBe("hi <@u-bob>");
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
    expect(mentionsToDisplay("hi <@u-bob> and <@u-zed>", nameOf).text).toBe(
      "hi @Bob and <@u-zed>",
    );
  });

  it("holds each shown token as a pick of its member, over the text as shown", () => {
    const nameOf = (id: string): string | null =>
      id === "u-ann" || id === "u-ann-2" ? "Ann Lee" : null;
    const shown = mentionsToDisplay("hi <@u-ann> and <@u-ann-2>!", nameOf);

    expect(shown.text).toBe("hi @Ann Lee and @Ann Lee!");
    expect(shown.picks).toEqual([
      { start: 3, end: 11, userId: "u-ann" },
      { start: 16, end: 24, userId: "u-ann-2" },
    ]);
    // Read back, each pick goes to the member it named.
    expect(
      mentionsToWire(
        shown.text,
        [member("u-ann", "Ann Lee"), member("u-ann-2", "Ann Lee")],
        shown.picks,
      ),
    ).toBe("hi <@u-ann> and <@u-ann-2>!");
  });
});

describe("moving picks with the text", () => {
  const PICKS = [pick(3, 11, "u-ann")];

  it("moves a pick when text is inserted before it", () => {
    expect(
      shiftMentionPicks("hi @Ann Lee", "oh, hi @Ann Lee", PICKS, null),
    ).toEqual([pick(7, 15, "u-ann")]);
    expect(spliceMentionPicks(PICKS, 0, 0, 4)).toEqual([pick(7, 15, "u-ann")]);
  });

  it("moves a pick back when text before it is deleted", () => {
    expect(
      shiftMentionPicks(
        "oh, hi @Ann Lee",
        "hi @Ann Lee",
        [pick(7, 15, "u-ann")],
        null,
      ),
    ).toEqual(PICKS);
  });

  it("drops a pick an edit inside it touches", () => {
    expect(shiftMentionPicks("hi @Ann Lee", "hi @Ann Le", PICKS, null)).toEqual(
      [],
    );
    expect(spliceMentionPicks(PICKS, 5, 6, 1)).toEqual([]);
    expect(shiftMentionPicks("hi @Ann Lee", "hi ", PICKS, null)).toEqual([]);
  });

  it("keeps a pick an edit after it leaves alone", () => {
    expect(
      shiftMentionPicks("hi @Ann Lee", "hi @Ann Lee, hello", PICKS, null),
    ).toEqual(PICKS);
  });

  it("moves, rather than touches, a pick when text is typed just before it", () => {
    expect(
      shiftMentionPicks("hi @Ann Lee", "hi x@Ann Lee", PICKS, null),
    ).toEqual([pick(4, 12, "u-ann")]);
  });

  describe("where the box's selection is known", () => {
    // Two picks of the same `@Name`: the texts alone cannot say which of the
    // two a deletion took.
    const TWO = [pick(0, 8, "u-ann"), pick(9, 17, "u-ann-2")];
    const BOTH = "@Ann Lee @Ann Lee ";
    const FIRST_ONLY = "@Ann Lee ";

    it("drops the second of two identical mentions when the selection deleted it", () => {
      expect(
        shiftMentionPicks(BOTH, FIRST_ONLY, TWO, {
          start: 9,
          end: 18,
          caretAfter: 9,
        }),
      ).toEqual([pick(0, 8, "u-ann")]);
      // Read from the texts alone, it is the first that goes.
      expect(shiftMentionPicks(BOTH, FIRST_ONLY, TWO, null)).toEqual([
        pick(0, 8, "u-ann-2"),
      ]);
    });

    // The same text results from Backspace and from Delete here, so only the
    // caret tells whether the pick's last letter was the one deleted.
    const PICKED = [pick(0, 8, "u-ann")];
    const BEFORE = "@Ann Leee";
    const AFTER = "@Ann Lee";

    it("takes a Backspace at a collapsed caret as a deletion behind it", () => {
      expect(
        shiftMentionPicks(BEFORE, AFTER, PICKED, {
          start: 8,
          end: 8,
          caretAfter: 7,
        }),
      ).toEqual([]);
    });

    it("takes a forward Delete at a collapsed caret as a deletion ahead of it", () => {
      expect(
        shiftMentionPicks(BEFORE, AFTER, PICKED, {
          start: 8,
          end: 8,
          caretAfter: 8,
        }),
      ).toEqual(PICKED);
    });

    it("takes text longer than before as an insertion at the caret", () => {
      expect(
        shiftMentionPicks("hi @Ann Lee", "oh, hi @Ann Lee", PICKS, {
          start: 0,
          end: 0,
          caretAfter: 4,
        }),
      ).toEqual([pick(7, 15, "u-ann")]);
    });

    it("reads the texts alone when the selection did not make the edit", () => {
      // The texts differ by a deletion at the front, but the selection says
      // the caret was at the end.
      expect(
        shiftMentionPicks(
          "oh, hi @Ann Lee",
          "hi @Ann Lee",
          [pick(7, 15, "u-ann")],
          { start: 15, end: 15, caretAfter: 15 },
        ),
      ).toEqual(PICKS);
    });
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
