import { describe, expect, it } from "vitest";
import {
  chatPublicationDefinitiveReason,
  definitiveInvalidatesPublishedHead,
  type ChatPublicationDefinitiveReason,
} from "../chat-publication-definitive";

describe("chatPublicationDefinitiveReason", () => {
  it("reads null as the ordinary reading - the answer may still move", () => {
    expect(chatPublicationDefinitiveReason(null)).toBeNull();
  });

  it("reads an absent (undefined) field as the ordinary reading too, NOT as a reason", () => {
    // A host built before `definitive` was added negotiates the same method
    // version, so its response takes the un-parsed same-version path in
    // ws-rpc-client.ts and the field genuinely arrives missing at runtime,
    // despite the static type saying it cannot be. Reading that absence as a
    // reason would mark every pre-field host permanently halted and retire
    // its wait lane - the very hang this field exists to fix, inverted.
    expect(chatPublicationDefinitiveReason(undefined)).toBeNull();
  });

  it("recognises each of the three named wire reasons", () => {
    expect(chatPublicationDefinitiveReason("chat-deleted")).toBe(
      "chat-deleted",
    );
    expect(chatPublicationDefinitiveReason("lineage-superseded")).toBe(
      "lineage-superseded",
    );
    expect(chatPublicationDefinitiveReason("backup-halted")).toBe(
      "backup-halted",
    );
  });

  it("maps an unrecognised reason to the client's own terminal-but-unexplained arm, not to null", () => {
    // Forward compatibility: a host ahead of this build can name a reason
    // that is not in the enum this build was compiled against. The only safe
    // reading is terminal - mapping it to `null` would reintroduce the
    // infinite wait for exactly the fleet that had something new to say.
    expect(
      chatPublicationDefinitiveReason("a-reason-this-build-does-not-know"),
    ).toBe("unexplained");
  });
});

describe("definitiveInvalidatesPublishedHead", () => {
  // All four reasons, pinned individually: the two identity reasons hold
  // however far the published head reached, and the two progress reasons
  // must NOT contradict a coverage fact this client actually read.
  it.each<{ reason: ChatPublicationDefinitiveReason; invalidates: boolean }>([
    { reason: "chat-deleted", invalidates: true },
    { reason: "lineage-superseded", invalidates: true },
    { reason: "backup-halted", invalidates: false },
    { reason: "unexplained", invalidates: false },
  ])("$reason invalidates=$invalidates", ({ reason, invalidates }) => {
    expect(definitiveInvalidatesPublishedHead(reason)).toBe(invalidates);
  });
});
