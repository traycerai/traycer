import { describe, expect, it } from "vitest";
import {
  BOUNDARY_SYNCING_NOTICE,
  CHAT_BACKUP_HALTED_NOTICE,
  CHAT_BACKUP_UNAVAILABLE_NOTICE,
  CHAT_DELETED_NOTICE,
  CHAT_FORK_NEEDS_UPDATE_WORD,
  CHAT_LINEAGE_SUPERSEDED_NOTICE,
  CHAT_NOT_BACKED_UP_NOTICE,
  chatForkHostRefusals,
  chatForkTargetSupport,
  chatForkTargetVerdict,
  chatForkRemoteClassState,
  publicationStateFromResponse,
  remoteClassIsUnreachable,
  verdictAllowsSubmit,
  verdictNotice,
  type ChatForkPublicationState,
  type ChatForkTargetVerdict,
} from "../chat-fork-target";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

describe("chatForkTargetSupport", () => {
  it("treats 1.1 and a later same-major minor as supported", () => {
    expect(chatForkTargetSupport({ major: 1, minor: 1 })).toEqual({
      kind: "supported",
    });
    expect(chatForkTargetSupport({ major: 1, minor: 2 })).toEqual({
      kind: "supported",
    });
  });

  it("refuses a completed handshake that omitted the method as needs-update", () => {
    expect(chatForkTargetSupport(false)).toEqual({
      kind: "refused",
      word: CHAT_FORK_NEEDS_UPDATE_WORD,
      detail: "This host can't create agents yet - update it to fork here.",
    });
  });

  // `1.0` is the ONLY same-major minor below the gate: the owner hint arrived on
  // an unreleased `1.2` that the release collapsed into `1.1`, so the boundary
  // this asserts is 1.0-refused / 1.1-supported, one minor lower than it was.
  it("refuses a same-major build below 1.1 as needs-update", () => {
    expect(chatForkTargetSupport({ major: 1, minor: 0 })).toEqual({
      kind: "refused",
      word: CHAT_FORK_NEEDS_UPDATE_WORD,
      detail:
        "This host's build can't receive a fork from another machine. Update it and try again.",
    });
  });

  it("refuses an unrecognized major as incompatible, not as needs-update", () => {
    expect(chatForkTargetSupport({ major: 2, minor: 0 })).toEqual({
      kind: "refused",
      word: "incompatible",
      detail:
        "This host speaks a different version of the agent-create contract, so this app can't fork onto it.",
    });
    expect(chatForkTargetSupport({ major: 0, minor: 9 })).toEqual({
      kind: "refused",
      word: "incompatible",
      detail:
        "This host speaks a different version of the agent-create contract, so this app can't fork onto it.",
    });
  });

  it("treats a missing handshake as unknown, not refused", () => {
    // `null` is "we have not spoken to this host yet". Rendering "needs update"
    // here would assert a build fact this client does not have.
    expect(chatForkTargetSupport(null)).toEqual({ kind: "unknown" });
  });
});

describe("chatForkHostRefusals", () => {
  // `source-host` and `old-host` deliberately sit on the SAME refused minor:
  // the source exemption is keyed on host identity, not on version, and
  // pairing them here is what proves that rather than assuming it.
  const versionByHostId = new Map<string, NegotiatedMethodVersion>([
    ["source-host", { major: 1, minor: 0 }],
    ["old-host", { major: 1, minor: 0 }],
    ["absent-host", false],
    ["unknown-host", null],
    ["ready-host", { major: 1, minor: 1 }],
    ["ahead-host", { major: 2, minor: 0 }],
  ]);

  it("exempts the source host even when its build would otherwise be refused", () => {
    const refusals = chatForkHostRefusals({
      versionByHostId,
      sourceHostId: "source-host",
    });
    expect(refusals.has("source-host")).toBe(false);
    expect(refusals.get("old-host")).toBe(CHAT_FORK_NEEDS_UPDATE_WORD);
    expect(refusals.get("absent-host")).toBe(CHAT_FORK_NEEDS_UPDATE_WORD);
    expect(refusals.get("ahead-host")).toBe("incompatible");
    expect(refusals.has("unknown-host")).toBe(false);
    expect(refusals.has("ready-host")).toBe(false);
  });

  it("does not invent a source exemption when sourceHostId is null", () => {
    const refusals = chatForkHostRefusals({
      versionByHostId,
      sourceHostId: null,
    });
    expect(refusals.get("source-host")).toBe(CHAT_FORK_NEEDS_UPDATE_WORD);
  });
});

const SUPPORTED: NegotiatedMethodVersion = { major: 1, minor: 1 };
const REFUSED: NegotiatedMethodVersion = { major: 1, minor: 0 };
const UNKNOWN: NegotiatedMethodVersion = null;

const COVERED: ChatForkPublicationState = { kind: "covered" };
const PUB_UNKNOWN: ChatForkPublicationState = { kind: "unknown" };
const UNPUBLISHED: ChatForkPublicationState = { kind: "unpublished" };
const BOUNDARY_UNCOVERED: ChatForkPublicationState = {
  kind: "boundaryUncovered",
};

const ALLOWED: ChatForkTargetVerdict = { kind: "allowed" };
const UNPUBLISHED_VERDICT: ChatForkTargetVerdict = {
  kind: "chatUnpublished",
  notice: CHAT_NOT_BACKED_UP_NOTICE,
};
const SYNCING_VERDICT: ChatForkTargetVerdict = {
  kind: "boundarySyncing",
  notice: BOUNDARY_SYNCING_NOTICE,
};

function refusedVerdict(): ChatForkTargetVerdict {
  const support = chatForkTargetSupport(REFUSED);
  if (support.kind !== "refused") {
    throw new Error("fixture: 1.0 must be a host refusal");
  }
  return {
    kind: "hostRefused",
    word: support.word,
    detail: support.detail,
  };
}

describe("chatForkTargetVerdict", () => {
  it.each([
    {
      name: "supported × covered",
      version: SUPPORTED,
      publication: COVERED,
      expected: ALLOWED,
    },
    {
      name: "supported × unknown",
      version: SUPPORTED,
      publication: PUB_UNKNOWN,
      expected: ALLOWED,
    },
    {
      name: "supported × unpublished",
      version: SUPPORTED,
      publication: UNPUBLISHED,
      expected: UNPUBLISHED_VERDICT,
    },
    {
      name: "supported × boundaryUncovered",
      version: SUPPORTED,
      publication: BOUNDARY_UNCOVERED,
      expected: SYNCING_VERDICT,
    },
    {
      name: "unknown × covered",
      version: UNKNOWN,
      publication: COVERED,
      expected: ALLOWED,
    },
    {
      name: "unknown × unknown",
      version: UNKNOWN,
      publication: PUB_UNKNOWN,
      expected: ALLOWED,
    },
    {
      name: "unknown × unpublished",
      version: UNKNOWN,
      publication: UNPUBLISHED,
      expected: UNPUBLISHED_VERDICT,
    },
    {
      name: "unknown × boundaryUncovered",
      version: UNKNOWN,
      publication: BOUNDARY_UNCOVERED,
      expected: SYNCING_VERDICT,
    },
    {
      name: "refused × covered",
      version: REFUSED,
      publication: COVERED,
      expected: refusedVerdict(),
    },
    {
      name: "refused × unknown",
      version: REFUSED,
      publication: PUB_UNKNOWN,
      expected: refusedVerdict(),
    },
    {
      name: "refused × unpublished",
      version: REFUSED,
      publication: UNPUBLISHED,
      expected: UNPUBLISHED_VERDICT,
    },
    {
      name: "refused × boundaryUncovered",
      version: REFUSED,
      publication: BOUNDARY_UNCOVERED,
      expected: refusedVerdict(),
    },
  ])("$name", ({ version, publication, expected }) => {
    expect(
      chatForkTargetVerdict({
        isCrossHost: true,
        version,
        publication,
      }),
    ).toEqual(expected);
  });

  it("unknown-build × known-unpublished is chatUnpublished, not allowed", () => {
    // Precedence: a known source-chat fact outranks an unknown build. An
    // unknown version must never paper over "this chat is not backed up".
    expect(
      chatForkTargetVerdict({
        isCrossHost: true,
        version: UNKNOWN,
        publication: UNPUBLISHED,
      }),
    ).toEqual(UNPUBLISHED_VERDICT);
  });

  it("unknown × unknown stays allowed", () => {
    expect(
      chatForkTargetVerdict({
        isCrossHost: true,
        version: UNKNOWN,
        publication: PUB_UNKNOWN,
      }),
    ).toEqual(ALLOWED);
  });

  it("same-host short-circuits to allowed even when both gates would refuse", () => {
    // Ablation: unpublished + a 1.0 build would be chatUnpublished cross-host.
    // If this is allowed, only the isCrossHost short-circuit can be why.
    expect(
      chatForkTargetVerdict({
        isCrossHost: false,
        version: REFUSED,
        publication: UNPUBLISHED,
      }),
    ).toEqual(ALLOWED);
  });
});

describe("publication gate treatment follows how long the condition lasts", () => {
  it("unpublished vs boundarySyncing vs hostRefused differ in both row and submit", () => {
    const unpublished = chatForkTargetVerdict({
      isCrossHost: true,
      version: SUPPORTED,
      publication: UNPUBLISHED,
    });
    const syncing = chatForkTargetVerdict({
      isCrossHost: true,
      version: SUPPORTED,
      publication: BOUNDARY_UNCOVERED,
    });
    const refused = chatForkTargetVerdict({
      isCrossHost: true,
      version: REFUSED,
      publication: COVERED,
    });

    expect(unpublished.kind).toBe("chatUnpublished");
    expect(
      remoteClassIsUnreachable(chatForkRemoteClassState(UNPUBLISHED)),
    ).toBe(true);
    expect(verdictAllowsSubmit(unpublished)).toBe(false);
    expect(verdictNotice(unpublished)).toBe(CHAT_NOT_BACKED_UP_NOTICE);

    // Blocks submit while leaving the row selectable - the two halves are
    // independent, deliberately. Production INVERTED this: the host's old
    // coverage check is presence-only (`containsMessageId`), so a boundary
    // turn published mid-stream and since finalized locally reads as covered
    // at its partial version. Leaving submit enabled here would let a fork
    // sail through Layer 2 and seed a silently TRUNCATED turn - the poll
    // lane this method carries is what makes the row worth keeping
    // selectable instead of a dead end (see `boundarySyncing`'s own note in
    // chat-fork-target.ts). A future reader must not "fix" this back to
    // `true`.
    expect(syncing.kind).toBe("boundarySyncing");
    expect(
      remoteClassIsUnreachable(chatForkRemoteClassState(BOUNDARY_UNCOVERED)),
    ).toBe(false);
    expect(verdictAllowsSubmit(syncing)).toBe(false);
    expect(verdictNotice(syncing)).toBe(BOUNDARY_SYNCING_NOTICE);

    expect(refused.kind).toBe("hostRefused");
    expect(remoteClassIsUnreachable(chatForkRemoteClassState(COVERED))).toBe(
      false,
    );
    expect(verdictAllowsSubmit(refused)).toBe(false);
    expect(verdictNotice(refused)).toBeNull();
  });
});

describe("publicationStateFromResponse", () => {
  it("maps published: false to unpublished regardless of boundaryCovered", () => {
    expect(
      publicationStateFromResponse({
        published: false,
        boundaryCovered: true,
      }),
    ).toEqual(UNPUBLISHED);
    expect(
      publicationStateFromResponse({
        published: false,
        boundaryCovered: null,
      }),
    ).toEqual(UNPUBLISHED);
  });

  it("maps boundaryCovered: false to boundaryUncovered only when published", () => {
    expect(
      publicationStateFromResponse({
        published: true,
        boundaryCovered: false,
      }),
    ).toEqual(BOUNDARY_UNCOVERED);
  });

  it("reads boundaryCovered: null as not asked, never as not covered", () => {
    expect(
      publicationStateFromResponse({
        published: true,
        boundaryCovered: null,
      }),
    ).toEqual(COVERED);
  });

  it("maps a covered published head to covered", () => {
    expect(
      publicationStateFromResponse({
        published: true,
        boundaryCovered: true,
      }),
    ).toEqual(COVERED);
  });
});

describe("publicationStateFromResponse layers `definitive` on top of the ordinary reading", () => {
  const COVERED_RESPONSE = { published: true, boundaryCovered: true } as const;

  it("chat-deleted invalidates an otherwise-covered head", () => {
    expect(
      publicationStateFromResponse({
        ...COVERED_RESPONSE,
        definitive: "chat-deleted",
      }),
    ).toEqual({ kind: "definitivelyUnavailable", reason: "chat-deleted" });
  });

  it("lineage-superseded invalidates an otherwise-covered head", () => {
    expect(
      publicationStateFromResponse({
        ...COVERED_RESPONSE,
        definitive: "lineage-superseded",
      }),
    ).toEqual({
      kind: "definitivelyUnavailable",
      reason: "lineage-superseded",
    });
  });

  // Counterfactual for the two blocks above: same base fixture, only the
  // reason changes. `backup-halted` is the pure freeze - publication
  // stopped, but whatever had already been acknowledged is still there to be
  // pulled - so it must NOT contradict the coverage fact this client already
  // read.
  it("backup-halted does NOT invalidate an otherwise-covered head", () => {
    expect(
      publicationStateFromResponse({
        ...COVERED_RESPONSE,
        definitive: "backup-halted",
      }),
    ).toEqual(COVERED);
  });

  // Same counterfactual again: an unrecognised reason is a licence to stop
  // polling (see chat-publication-definitive.test.ts), never a licence to
  // contradict a coverage fact this client actually read.
  it("an unrecognised reason does NOT invalidate an otherwise-covered head either", () => {
    expect(
      publicationStateFromResponse({
        ...COVERED_RESPONSE,
        definitive: "a-reason-this-build-does-not-know",
      }),
    ).toEqual(COVERED);
  });

  it("counterfactual: the same base fixture with definitive: null stays covered", () => {
    expect(
      publicationStateFromResponse({
        ...COVERED_RESPONSE,
        definitive: null,
      }),
    ).toEqual(COVERED);
  });

  it("keeps boundaryCovered: null uncollapsed when a definitive field is also present", () => {
    // Guards the tri-state discipline against the new field: `definitive:
    // null` must not be mistaken for a boundaryCovered value, and must not
    // itself collapse the tri-state to false.
    expect(
      publicationStateFromResponse({
        published: true,
        boundaryCovered: null,
        definitive: null,
      }),
    ).toEqual(COVERED);
  });

  it("a definitive reason freezes an unpublished or uncovered answer too", () => {
    expect(
      publicationStateFromResponse({
        published: false,
        boundaryCovered: null,
        definitive: "chat-deleted",
      }),
    ).toEqual({ kind: "definitivelyUnavailable", reason: "chat-deleted" });
    expect(
      publicationStateFromResponse({
        published: true,
        boundaryCovered: false,
        definitive: "backup-halted",
      }),
    ).toEqual({ kind: "definitivelyUnavailable", reason: "backup-halted" });
  });
});

describe("chatForkTargetVerdict with a definitively unavailable publication", () => {
  const DEFINITIVELY_DELETED: ChatForkPublicationState = {
    kind: "definitivelyUnavailable",
    reason: "chat-deleted",
  };
  const DEFINITIVELY_SUPERSEDED: ChatForkPublicationState = {
    kind: "definitivelyUnavailable",
    reason: "lineage-superseded",
  };
  const DEFINITIVELY_HALTED: ChatForkPublicationState = {
    kind: "definitivelyUnavailable",
    reason: "backup-halted",
  };
  const DEFINITIVELY_UNEXPLAINED: ChatForkPublicationState = {
    kind: "definitivelyUnavailable",
    reason: "unexplained",
  };

  it.each([
    { publication: DEFINITIVELY_DELETED, notice: CHAT_DELETED_NOTICE },
    {
      publication: DEFINITIVELY_SUPERSEDED,
      notice: CHAT_LINEAGE_SUPERSEDED_NOTICE,
    },
    { publication: DEFINITIVELY_HALTED, notice: CHAT_BACKUP_HALTED_NOTICE },
    {
      publication: DEFINITIVELY_UNEXPLAINED,
      notice: CHAT_BACKUP_UNAVAILABLE_NOTICE,
    },
  ])(
    "names the reason-specific notice, blocks submit, and marks the row unreachable ($publication.reason)",
    ({ publication, notice }) => {
      const verdict = chatForkTargetVerdict({
        isCrossHost: true,
        version: SUPPORTED,
        publication,
      });
      expect(verdict).toEqual({ kind: "chatUnavailable", notice });
      expect(verdictAllowsSubmit(verdict)).toBe(false);
      expect(verdictNotice(verdict)).toBe(notice);
      expect(
        remoteClassIsUnreachable(chatForkRemoteClassState(publication)),
      ).toBe(true);
    },
  );

  it("outranks a per-host build refusal - a frozen source-chat fact is universal, a build fact is per-row", () => {
    const verdict = chatForkTargetVerdict({
      isCrossHost: true,
      version: REFUSED,
      publication: DEFINITIVELY_DELETED,
    });
    expect(verdict.kind).toBe("chatUnavailable");
  });
});

describe("verdictAllowsSubmit is true only for the allowed verdict", () => {
  it.each<{ name: string; verdict: ChatForkTargetVerdict; allows: boolean }>([
    { name: "allowed", verdict: ALLOWED, allows: true },
    { name: "chatUnpublished", verdict: UNPUBLISHED_VERDICT, allows: false },
    { name: "boundarySyncing", verdict: SYNCING_VERDICT, allows: false },
    { name: "hostRefused", verdict: refusedVerdict(), allows: false },
    {
      name: "chatUnavailable",
      verdict: { kind: "chatUnavailable", notice: CHAT_DELETED_NOTICE },
      allows: false,
    },
  ])("$name -> allows=$allows", ({ verdict, allows }) => {
    expect(verdictAllowsSubmit(verdict)).toBe(allows);
  });

  it("keeps the permissive publication states allowing submit - an unsupported or unreachable source host must not start blocking the fork", () => {
    // `unknown` publication is what a source host that predates
    // `epic.chatPublicationState`, or one that is currently unreachable,
    // resolves to (see use-chat-publication-state-query.ts's "every failure
    // resolves to unknown"). Neither must be swept into the blocking
    // behaviour added for `boundarySyncing` and `definitivelyUnavailable`.
    expect(
      verdictAllowsSubmit(
        chatForkTargetVerdict({
          isCrossHost: true,
          version: SUPPORTED,
          publication: PUB_UNKNOWN,
        }),
      ),
    ).toBe(true);
    expect(
      verdictAllowsSubmit(
        chatForkTargetVerdict({
          isCrossHost: true,
          version: UNKNOWN,
          publication: PUB_UNKNOWN,
        }),
      ),
    ).toBe(true);
  });
});
