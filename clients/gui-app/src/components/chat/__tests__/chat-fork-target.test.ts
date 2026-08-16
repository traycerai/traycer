import { describe, expect, it } from "vitest";
import {
  BOUNDARY_SYNCING_NOTICE,
  CHAT_FORK_NEEDS_UPDATE_WORD,
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
  it("treats 1.2 and a later same-major minor as supported", () => {
    expect(chatForkTargetSupport({ major: 1, minor: 2 })).toEqual({
      kind: "supported",
    });
    expect(chatForkTargetSupport({ major: 1, minor: 3 })).toEqual({
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

  it("refuses a same-major build below 1.2 as needs-update", () => {
    expect(chatForkTargetSupport({ major: 1, minor: 1 })).toEqual({
      kind: "refused",
      word: CHAT_FORK_NEEDS_UPDATE_WORD,
      detail:
        "This host's build can't receive a fork from another machine. Update it and try again.",
    });
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
  const versionByHostId = new Map<string, NegotiatedMethodVersion>([
    ["source-host", { major: 1, minor: 0 }],
    ["old-host", { major: 1, minor: 1 }],
    ["absent-host", false],
    ["unknown-host", null],
    ["ready-host", { major: 1, minor: 2 }],
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

const SUPPORTED: NegotiatedMethodVersion = { major: 1, minor: 2 };
const REFUSED: NegotiatedMethodVersion = { major: 1, minor: 1 };
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
    throw new Error("fixture: 1.1 must be a host refusal");
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
    // Ablation: unpublished + a 1.1 build would be chatUnpublished cross-host.
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

    // Speaks without blocking: if this were silently downgraded to `allowed`
    // the notice would vanish and the non-blocking half would still pass.
    expect(syncing.kind).toBe("boundarySyncing");
    expect(
      remoteClassIsUnreachable(chatForkRemoteClassState(BOUNDARY_UNCOVERED)),
    ).toBe(false);
    expect(verdictAllowsSubmit(syncing)).toBe(true);
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
