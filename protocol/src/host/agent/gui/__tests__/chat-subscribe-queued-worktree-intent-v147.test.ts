import { describe, expect, it } from "vitest";
import {
  chatSubscribeV143,
  chatSubscribeV144,
  chatSubscribeV145,
  chatSubscribeV146,
  chatSubscribeV147,
  chatSubscribeClientFrameSchema,
  chatSubscribeWindowedClientFrameSchema,
  type ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  CHAT_SUBSCRIBE_QUEUED_WORKTREE_INTENT_MINOR,
  projectChatClientFrameForVersion,
  projectChatServerFrameForVersion,
} from "../chat-frame-compat";
import {
  CARRIERS,
  firstItem,
  line,
  parseOn,
  parsesOn,
  projected,
  promptItem,
  queueChangedFrame,
  schemaDigest,
  version,
  WORKTREE_INTENT,
  versionsBelow,
  versionsFrom,
} from "./chat-subscribe-queue-item-support";

const BOUNDARY = CHAT_SUBSCRIBE_QUEUED_WORKTREE_INTENT_MINOR;
const BELOW_BOUNDARY = versionsBelow(BOUNDARY);
const AT_OR_ABOVE_BOUNDARY = versionsFrom(BOUNDARY);

describe("chat.subscribe@1.47 queued worktree intent", () => {
  it("registers 1.47 below the 1.48 head with the 1.46 open request", () => {
    expect(line.latestMinor).toBe(48);
    expect(line.versions[47].contract).toBe(chatSubscribeV147);
    expect(chatSubscribeV147.openRequestSchema).toBe(
      chatSubscribeV146.openRequestSchema,
    );
    expect(chatSubscribeV147.schemaVersion).toEqual(version(47));
    expect(BOUNDARY).toBe(chatSubscribeV147.schemaVersion.minor);
  });

  it("keeps the 1.46 and 1.43 server-frame schema fingerprints from before 1.47", () => {
    expect(schemaDigest(chatSubscribeV146.serverFrameSchema, "input")).toBe(
      "6fc4f0a3f628227b3c3558447ffab71ebafb351c1e24f2d323ecbf97d0f7df9f",
    );
    expect(schemaDigest(chatSubscribeV146.serverFrameSchema, "output")).toBe(
      "ae0c7394d4d79e1dfafd55496c5e128e928cc94fd6bfb7852c541fdb578e2883",
    );
    expect(schemaDigest(chatSubscribeV143.serverFrameSchema, "input")).toBe(
      "6cef34bf0641052bde91afb96fb03ff7fb9d8a591cd108d6becb755b69704a7f",
    );
    expect(schemaDigest(chatSubscribeV143.serverFrameSchema, "output")).toBe(
      "27cf12456152bf59ea08edd8a3a71b96b87f137bad4459590120f04d533843a6",
    );
  });

  it("keeps the 1.44 and 1.43 client-frame schema fingerprints from before 1.47", () => {
    expect(schemaDigest(chatSubscribeV144.clientFrameSchema, "input")).toBe(
      "1cc213ddcdc32f49b5a58cba7d8ebaef867abb0e4483bddcf0bafc023a5dbd5c",
    );
    expect(schemaDigest(chatSubscribeV144.clientFrameSchema, "output")).toBe(
      "12f4b65d7d474fa380901ff8f3e9f7ab91f081ae237f1b165ccb37a5e87d3d00",
    );
    expect(schemaDigest(chatSubscribeV143.clientFrameSchema, "input")).toBe(
      "99ec02470d71bcedbc1309bc8e664845a072d257016e0d4b3434fdfb81492e5c",
    );
    expect(schemaDigest(chatSubscribeV143.clientFrameSchema, "output")).toBe(
      "c3843d4deb3bf971d153f8a69faf1efa352c4fed2599d11ffb8c162bae6d8ca0",
    );
  });

  it("binds 1.44, 1.45 and 1.46 to one client-frame schema and 1.47 to its own", () => {
    expect(chatSubscribeV145.clientFrameSchema).toBe(
      chatSubscribeV144.clientFrameSchema,
    );
    expect(chatSubscribeV146.clientFrameSchema).toBe(
      chatSubscribeV144.clientFrameSchema,
    );
    expect(chatSubscribeV147.clientFrameSchema).not.toBe(
      chatSubscribeV146.clientFrameSchema,
    );
  });

  describe.each(CARRIERS)("%s on the server", (_name, frameOf) => {
    it.each([
      ["a real intent", WORKTREE_INTENT],
      ["null", null],
    ])("1.47 keeps %s on the prompt item", (_label, value) => {
      const parsed = parseOn(
        47,
        frameOf(promptItem({ worktreeIntent: value })),
      );
      expect(firstItem(parsed).worktreeIntent).toEqual(value);
    });

    it("1.47 leaves an absent key absent", () => {
      const parsed = parseOn(47, frameOf(promptItem({})));
      expect("worktreeIntent" in firstItem(parsed)).toBe(false);
    });

    it("1.46 drops the key through its own schema and keeps the rest of the item", () => {
      const parsed = parseOn(
        46,
        frameOf(promptItem({ worktreeIntent: WORKTREE_INTENT })),
      );
      expect(firstItem(parsed)).toEqual(
        firstItem(parseOn(46, frameOf(promptItem({})))),
      );
    });

    it("projects the key away below 1.47 and changes nothing else", () => {
      const original = projected(
        frameOf(promptItem({ worktreeIntent: WORKTREE_INTENT })),
      );
      const keyless = projected(frameOf(promptItem({})));
      for (const negotiated of BELOW_BOUNDARY) {
        const result = projectChatServerFrameForVersion(original, negotiated);
        expect("worktreeIntent" in firstItem(result)).toBe(false);
        expect(result).toEqual(
          projectChatServerFrameForVersion(keyless, negotiated),
        );
      }
    });

    it("returns the same frame object from 1.47 up", () => {
      const original = projected(
        parseOn(47, frameOf(promptItem({ worktreeIntent: WORKTREE_INTENT }))),
      );
      for (const negotiated of AT_OR_ABOVE_BOUNDARY) {
        expect(projectChatServerFrameForVersion(original, negotiated)).toBe(
          original,
        );
      }
    });

    it("leaves a frame without the key unchanged for every version", () => {
      const original = projected(frameOf(promptItem({})));
      for (const negotiated of [...BELOW_BOUNDARY, ...AT_OR_ABOVE_BOUNDARY]) {
        expect(projectChatServerFrameForVersion(original, negotiated)).toEqual(
          original,
        );
      }
    });
  });

  describe("queueEdit on the client", () => {
    const edit = {
      kind: "queueEdit",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      queueItemId: "queue-1",
      content: { type: "doc", content: [] },
    };

    function liveEdit(worktreeIntent: unknown): ChatSubscribeClientFrame {
      return chatSubscribeClientFrameSchema.parse({ ...edit, worktreeIntent });
    }

    it("1.47 parses worktreeIntent entries and null", () => {
      for (const value of [WORKTREE_INTENT, null]) {
        expect(
          chatSubscribeV147.clientFrameSchema.parse({
            ...edit,
            worktreeIntent: value,
          }),
        ).toEqual({ ...edit, worktreeIntent: value });
      }
    });

    it("upgrades an older client's frame with no key to null, through its own line and then the live one", () => {
      const own = chatSubscribeV146.clientFrameSchema.parse(edit);
      expect("worktreeIntent" in own).toBe(false);
      expect(chatSubscribeWindowedClientFrameSchema.parse(own)).toEqual({
        ...edit,
        worktreeIntent: null,
      });
    });

    it("1.46 drops the key through its own schema", () => {
      const parsed = chatSubscribeV146.clientFrameSchema.parse({
        ...edit,
        worktreeIntent: WORKTREE_INTENT,
      });
      expect("worktreeIntent" in parsed).toBe(false);
    });

    it("loses a null key below 1.47 and keeps it from 1.47", () => {
      for (const negotiated of BELOW_BOUNDARY) {
        expect(
          projectChatClientFrameForVersion(liveEdit(null), negotiated),
        ).toEqual(edit);
      }
      for (const negotiated of AT_OR_ABOVE_BOUNDARY) {
        expect(
          projectChatClientFrameForVersion(liveEdit(null), negotiated),
        ).toEqual({ ...edit, worktreeIntent: null });
      }
    });

    it("refuses a real intent below 1.47 and passes it from 1.47", () => {
      for (const negotiated of BELOW_BOUNDARY) {
        expect(() =>
          projectChatClientFrameForVersion(
            liveEdit(WORKTREE_INTENT),
            negotiated,
          ),
        ).toThrow(
          `queueEdit.worktreeIntent requires chat.subscribe@1.${BOUNDARY} or newer`,
        );
      }
      for (const negotiated of AT_OR_ABOVE_BOUNDARY) {
        expect(
          projectChatClientFrameForVersion(
            liveEdit(WORKTREE_INTENT),
            negotiated,
          ),
        ).toEqual({ ...edit, worktreeIntent: WORKTREE_INTENT });
      }
    });

    it("leaves other frame kinds untouched", () => {
      const resume = {
        kind: "resumeQueue",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
      };
      const frame = chatSubscribeClientFrameSchema.parse(resume);
      for (const negotiated of [...BELOW_BOUNDARY, version(BOUNDARY)]) {
        expect(projectChatClientFrameForVersion(frame, negotiated)).toEqual(
          resume,
        );
      }
    });
  });
});

/**
 * Every line binds its queued prompt item through its own schema, so the key has
 * to be absent below the boundary by that schema, not only by the projection a
 * host could skip. The fingerprints above reach back to 1.43; this walks every
 * line the fixture parses on, which reaches the older ones. The lines come from
 * the registry, so a line added later is covered without an edit here.
 */
const MINORS = Object.keys(line.versions)
  .map(Number)
  .sort((a, b) => a - b);

const withoutKey = queueChangedFrame(promptItem({}));
const withKey = queueChangedFrame(
  promptItem({ worktreeIntent: WORKTREE_INTENT }),
);
const FIRST_MINOR = MINORS.find((minor) => parsesOn(minor, withoutKey));
const WALKED = MINORS.filter(
  (minor) => FIRST_MINOR !== undefined && minor >= FIRST_MINOR,
);

describe("the lines the sweep walks", () => {
  it("start where the fixture first parses and run through the head, boundary among them", () => {
    expect(FIRST_MINOR).toBeDefined();
    expect(WALKED.every((minor) => parsesOn(minor, withoutKey))).toBe(true);
    expect(WALKED.at(-1)).toBe(line.latestMinor);
    expect(WALKED).toContain(BOUNDARY);
    expect(WALKED).toContain(BOUNDARY - 1);
  });
});

describe.each(WALKED)("chat.subscribe@1.%i queued prompt", (minor) => {
  it("its own schema decides whether a queued prompt keeps worktreeIntent", () => {
    const item = firstItem(parseOn(minor, withKey));
    if (minor >= BOUNDARY) {
      expect(item.worktreeIntent).toEqual(WORKTREE_INTENT);
    } else {
      expect("worktreeIntent" in item).toBe(false);
    }
    expect(item).toMatchObject({
      queueItemId: "queue-1",
      messageId: "message-1",
    });
  });
});
