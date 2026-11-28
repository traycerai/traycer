import { describe, expect, it } from "vitest";
import {
  QUEUE_ITEM_EDIT_HELD_CODE,
  chatSubscribeV147,
  chatSubscribeV148,
  chatSubscribeClientFrameSchema,
  type ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  CHAT_SUBSCRIBE_QUEUE_EDIT_HOLD_MINOR,
  projectChatClientFrameForVersion,
  projectChatServerFrameForVersion,
} from "../chat-frame-compat";
import {
  CARRIERS,
  envelope,
  firstItem,
  itemWithout,
  itemsOf,
  line,
  parseOn,
  parsesOn,
  projected,
  promptItem,
  queueChangedFrame,
  schemaDigest,
  version,
  withQueueItems,
  WORKTREE_INTENT,
  versionsBelow,
  versionsFrom,
} from "./chat-subscribe-queue-item-support";

const BOUNDARY = CHAT_SUBSCRIBE_QUEUE_EDIT_HOLD_MINOR;
const BELOW_BOUNDARY = versionsBelow(BOUNDARY);
const AT_OR_ABOVE_BOUNDARY = versionsFrom(BOUNDARY);
const MINORS = Object.keys(line.versions)
  .map(Number)
  .sort((a, b) => a - b);

describe("chat.subscribe@1.48 queue edit hold", () => {
  it("registers 1.48 as the head with the 1.47 open request", () => {
    expect(line.latestMinor).toBe(48);
    expect(line.versions[48].contract).toBe(chatSubscribeV148);
    expect(chatSubscribeV148.openRequestSchema).toBe(
      chatSubscribeV147.openRequestSchema,
    );
    expect(BOUNDARY).toBe(chatSubscribeV148.schemaVersion.minor);
  });

  it("keeps the 1.47 schema fingerprints from before 1.48", () => {
    expect(schemaDigest(chatSubscribeV147.serverFrameSchema, "input")).toBe(
      "560a6b5bafc6d2f45e8dabed3b461466e0f04021d630bd715c6889a1e9b10a20",
    );
    expect(schemaDigest(chatSubscribeV147.serverFrameSchema, "output")).toBe(
      "3b009cf0ffe69636e4802beef0f581a57d71dcee41356d7827cef26be1c7fe50",
    );
    expect(schemaDigest(chatSubscribeV147.clientFrameSchema, "input")).toBe(
      "6f9e413ed803d18a77cd24effdfaae3e9f589cae242e127fbec5ba55da07b097",
    );
    expect(schemaDigest(chatSubscribeV147.clientFrameSchema, "output")).toBe(
      "a07b944c1d95e374616894fd1d749bde62ade29c7b862ba4593657e234aa24fa",
    );
  });

  describe.each(CARRIERS)("%s on the server", (_name, frameOf) => {
    it.each([true, false])(
      "1.48 keeps editHeld %s on the prompt item",
      (held) => {
        const parsed = parseOn(48, frameOf(promptItem({ editHeld: held })));
        expect(firstItem(parsed).editHeld).toBe(held);
      },
    );

    it("1.48 leaves an absent key absent", () => {
      const parsed = parseOn(48, frameOf(promptItem({})));
      expect("editHeld" in firstItem(parsed)).toBe(false);
    });

    it("1.47 drops the key through its own schema and keeps the rest of the item", () => {
      const parsed = parseOn(47, frameOf(promptItem({ editHeld: true })));
      expect(firstItem(parsed)).toEqual(
        firstItem(parseOn(47, frameOf(promptItem({})))),
      );
    });

    it("projects the key away below 1.48 and changes nothing else", () => {
      const original = projected(frameOf(promptItem({ editHeld: true })));
      const keyless = projected(frameOf(promptItem({})));
      for (const negotiated of BELOW_BOUNDARY) {
        const result = projectChatServerFrameForVersion(original, negotiated);
        expect("editHeld" in firstItem(result)).toBe(false);
        expect(result).toEqual(
          projectChatServerFrameForVersion(keyless, negotiated),
        );
      }
    });

    it("returns the same frame object from 1.48 up", () => {
      const original = projected(
        parseOn(48, frameOf(promptItem({ editHeld: true }))),
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

    it("strips editHeld from every item of the queue and leaves the rest as sent", () => {
      const sent = [
        promptItem({ queueItemId: "queue-1", editHeld: true }),
        promptItem({ queueItemId: "queue-2" }),
        promptItem({
          queueItemId: "queue-3",
          editHeld: false,
          worktreeIntent: WORKTREE_INTENT,
        }),
      ];
      const original = projected(withQueueItems(frameOf(sent[0]), sent));
      for (const negotiated of BELOW_BOUNDARY) {
        const dropsIntent = negotiated === null || negotiated.minor < 47;
        expect(
          itemsOf(projectChatServerFrameForVersion(original, negotiated)),
        ).toEqual(
          sent.map((item) =>
            itemWithout(
              item,
              dropsIntent ? ["editHeld", "worktreeIntent"] : ["editHeld"],
            ),
          ),
        );
      }
      for (const negotiated of AT_OR_ABOVE_BOUNDARY) {
        expect(
          itemsOf(projectChatServerFrameForVersion(original, negotiated)),
        ).toEqual(sent);
      }
    });

    it("strips editHeld and worktreeIntent each at its own boundary", () => {
      const original = projected(
        frameOf(
          promptItem({ worktreeIntent: WORKTREE_INTENT, editHeld: true }),
        ),
      );
      const at147 = firstItem(
        projectChatServerFrameForVersion(original, version(47)),
      );
      expect(at147.worktreeIntent).toEqual(WORKTREE_INTENT);
      expect("editHeld" in at147).toBe(false);
      const at146 = firstItem(
        projectChatServerFrameForVersion(original, version(46)),
      );
      expect("worktreeIntent" in at146).toBe(false);
      expect("editHeld" in at146).toBe(false);
    });
  });

  describe("client frames", () => {
    const hold = {
      kind: "queueEditHold",
      ...envelope,
      clientActionId: "action-1",
      queueItemId: "queue-1",
    };
    const release = { ...hold, kind: "queueEditRelease" };
    const FRAMES = [
      ["queueEditHold", hold],
      ["queueEditRelease", release],
    ] as const;

    describe.each(FRAMES)("%s", (kind, input) => {
      it("parses at 1.48 to exactly the input", () => {
        expect(chatSubscribeV148.clientFrameSchema.parse(input)).toEqual(input);
        expect(chatSubscribeClientFrameSchema.parse(input)).toEqual(input);
      });

      it("is refused by every registered line below 1.48 through its own schema", () => {
        for (let minor = 0; minor < BOUNDARY; minor += 1) {
          expect(
            line.versions[minor].contract.clientFrameSchema.safeParse(input)
              .success,
          ).toBe(false);
        }
      });

      it("is refused by the projection below 1.48 and passed from 1.48", () => {
        const frame: ChatSubscribeClientFrame =
          chatSubscribeClientFrameSchema.parse(input);
        for (const negotiated of BELOW_BOUNDARY) {
          expect(() =>
            projectChatClientFrameForVersion(frame, negotiated),
          ).toThrow(`${kind} requires chat.subscribe@1.48 or newer`);
        }
        for (const negotiated of AT_OR_ABOVE_BOUNDARY) {
          expect(projectChatClientFrameForVersion(frame, negotiated)).toEqual(
            input,
          );
        }
      });
    });
  });

  describe("actionAck", () => {
    const REASON = "Another window is editing this message.";
    function ack(action: string, status: "accepted" | "rejected") {
      return {
        kind: "actionAck",
        ...envelope,
        clientActionId: "action-1",
        action,
        status,
        reason: status === "rejected" ? REASON : null,
        code: status === "rejected" ? QUEUE_ITEM_EDIT_HELD_CODE : null,
      };
    }
    const MINORS_BELOW = Array.from({ length: BOUNDARY }, (_, minor) => minor);

    it.each([
      ["queueEditHold", "rejected"],
      ["queueEditRelease", "rejected"],
      ["queueEditHold", "accepted"],
      ["queueEditRelease", "accepted"],
    ] as const)("1.48 parses an ack echoing %s as %s", (action, status) => {
      const sent = ack(action, status);
      expect(parseOn(48, sent)).toMatchObject({
        action,
        status,
        code: sent.code,
        reason: sent.reason,
      });
    });

    it.each(MINORS_BELOW)("1.%i refuses what 1.48 parses", (minor) => {
      expect(parsesOn(minor, ack("stop", "rejected"))).toBe(true);
      for (const action of ["queueEditHold", "queueEditRelease"]) {
        expect(parsesOn(minor, ack(action, "rejected"))).toBe(false);
      }
    });

    const refusedEdit = ack("queueEdit", "rejected");
    const refusedEditFields = {
      action: "queueEdit",
      status: "rejected",
      code: QUEUE_ITEM_EDIT_HELD_CODE,
      reason: REASON,
    };

    describe.each(MINORS)("a refused queueEdit on 1.%i", (minor) => {
      it("parses through the line's own schema with the reason as sent", () => {
        expect(parseOn(minor, refusedEdit)).toMatchObject(refusedEditFields);
      });

      it("keeps the code and the reason through the host's projection", () => {
        expect(
          projectChatServerFrameForVersion(
            projected(refusedEdit),
            version(minor),
          ),
        ).toMatchObject(refusedEditFields);
      });
    });

    it("keeps a refused queueEdit's code and reason for a peer that has not negotiated", () => {
      expect(
        projectChatServerFrameForVersion(projected(refusedEdit), null),
      ).toMatchObject(refusedEditFields);
    });
  });
});

/**
 * Every line binds its queued prompt item through its own schema, so the key has
 * to be absent below the boundary by that schema, not only by the projection a
 * host could skip. The lines come from the registry, so a line added later is
 * covered without an edit here.
 */
const withoutKey = queueChangedFrame(promptItem({}));
const withKey = queueChangedFrame(promptItem({ editHeld: true }));
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
  it("its own schema decides whether a queued prompt keeps editHeld", () => {
    const item = firstItem(parseOn(minor, withKey));
    if (minor >= BOUNDARY) {
      expect(item.editHeld).toBe(true);
    } else {
      expect("editHeld" in item).toBe(false);
    }
    expect(item).toMatchObject({
      queueItemId: "queue-1",
      messageId: "message-1",
    });
  });
});
