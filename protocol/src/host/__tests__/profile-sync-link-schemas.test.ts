/**
 * Wire contract of profile sync: which sign-in may travel under which
 * provider, the closed sets the app renders, and the bounds a host enforces.
 */
import { describe, expect, it } from "vitest";
import { PROFILE_SYNC_LINK_RPC_METHODS } from "@traycer/protocol/host/profile-sync-link-contracts";
import {
  PROFILE_SYNC_MAX_CREDENTIAL_BYTES,
  hostProfileSyncApplyRequestSchema,
  hostProfileSyncFetchResponseSchema,
  hostProfileSyncGroupHoldersRequestSchema,
  hostProfileSyncGroupHoldersResponseSchema,
  hostProfileSyncOfferRequestSchema,
  hostProfileSyncStopLinkRequestSchema,
  hostProfileSyncStopLinkResponseSchema,
  profileSyncCredentialFitsProvider,
  profileSyncCredentialSchema,
  profileSyncNowRequestSchema,
  profileSyncReasonSchema,
  profileSyncStatusSchema,
  type ProfileSyncCredential,
  type ProfileSyncProvider,
} from "@traycer/protocol/host/profile-sync-link-schemas";

const LINK_ID = "6f1c2f0e-8a44-4d19-9c3e-5b7a0d21f8ac";
const SOURCE_PROFILE_ID = "0f6c1b2e-8a44-4d19-9c3e-5b7a0d21f8ac";

const CREDENTIALS: Record<string, ProfileSyncCredential> = {
  claude: {
    kind: "claude-oauth",
    document: { accessToken: "t" },
    account: { accountUuid: "a" },
  },
  codex: { kind: "codex-auth-file", document: { tokens: {} } },
  grok: { kind: "grok-auth-file", document: { key: "k" } },
  "antigravity-oauth": { kind: "antigravity-oauth", document: { token: "t" } },
  "antigravity-key": { kind: "antigravity-api-key", apiKey: "key" },
};

const PAIRS: ReadonlyArray<readonly [ProfileSyncProvider, string]> = [
  ["claude", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
  ["antigravity", "antigravity-oauth"],
  ["antigravity", "antigravity-key"],
];

function credentialFor(name: string): ProfileSyncCredential {
  const credential = CREDENTIALS[name];
  if (credential === undefined) throw new Error(`no fixture ${name}`);
  return credential;
}

function applyRequest(
  providerId: ProfileSyncProvider,
  credential: ProfileSyncCredential,
): Record<string, unknown> {
  return {
    linkId: LINK_ID,
    providerId,
    sourceProfileId: SOURCE_PROFILE_ID,
    profile: { name: "Work", color: "#ef4444", enabled: true },
    accountId: "acct",
    generation: 1,
    credential,
    acceptAccountChange: false,
    newLink: true,
  };
}

function offerRequest(
  providerId: ProfileSyncProvider,
  credential: ProfileSyncCredential,
): Record<string, unknown> {
  return {
    linkId: LINK_ID,
    providerId,
    accountId: "acct",
    generation: 1,
    credential,
  };
}

describe("a request's sign-in must belong to its provider", () => {
  it.each(PAIRS)("accepts %s with %s", (providerId, name) => {
    const credential = credentialFor(name);
    expect(
      hostProfileSyncApplyRequestSchema.safeParse(
        applyRequest(providerId, credential),
      ).success,
    ).toBe(true);
    expect(
      hostProfileSyncOfferRequestSchema.safeParse(
        offerRequest(providerId, credential),
      ).success,
    ).toBe(true);
  });

  it("refuses a mismatched provider and sign-in", () => {
    const codex = credentialFor("codex");
    const claude = credentialFor("claude");
    expect(
      hostProfileSyncApplyRequestSchema.safeParse(applyRequest("claude", codex))
        .success,
    ).toBe(false);
    expect(
      hostProfileSyncOfferRequestSchema.safeParse(offerRequest("claude", codex))
        .success,
    ).toBe(false);
    expect(
      hostProfileSyncApplyRequestSchema.safeParse(
        applyRequest("antigravity", claude),
      ).success,
    ).toBe(false);
    expect(
      hostProfileSyncOfferRequestSchema.safeParse(offerRequest("grok", claude))
        .success,
    ).toBe(false);
  });
});

describe("profileSyncCredentialFitsProvider", () => {
  const providers: readonly ProfileSyncProvider[] = [
    "claude",
    "codex",
    "grok",
    "antigravity",
  ];
  const kinds: ReadonlyArray<readonly [string, ProfileSyncProvider[]]> = [
    ["claude", ["claude"]],
    ["codex", ["codex"]],
    ["grok", ["grok"]],
    ["antigravity-oauth", ["antigravity"]],
    ["antigravity-key", ["antigravity"]],
  ];

  it.each(kinds)("%s fits only %j", (name, fits) => {
    const credential = credentialFor(name);
    for (const providerId of providers) {
      expect(profileSyncCredentialFitsProvider(providerId, credential)).toBe(
        fits.includes(providerId),
      );
    }
  });
});

describe("closed sets", () => {
  it("includes account-mismatch and removed-on-device among the reasons", () => {
    expect(profileSyncReasonSchema.options).toEqual(
      expect.arrayContaining(["account-mismatch", "removed-on-device"]),
    );
  });

  it("has exactly the six statuses", () => {
    expect([...profileSyncStatusSchema.options].sort()).toEqual(
      [
        "cannot-sync",
        "device-offline",
        "sign-in-needed",
        "synced",
        "syncing",
        "update-needed",
      ].sort(),
    );
  });
});

describe("bounds and strictness", () => {
  it("refuses a sign-in above the byte limit", () => {
    const oversized = {
      kind: "grok-auth-file",
      document: { blob: "x".repeat(PROFILE_SYNC_MAX_CREDENTIAL_BYTES) },
    };
    expect(profileSyncCredentialSchema.safeParse(oversized).success).toBe(
      false,
    );
    expect(
      profileSyncCredentialSchema.safeParse(credentialFor("grok")).success,
    ).toBe(true);
  });

  it("refuses an unknown key on a request and on a credential", () => {
    expect(
      hostProfileSyncOfferRequestSchema.safeParse({
        ...offerRequest("codex", credentialFor("codex")),
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      hostProfileSyncApplyRequestSchema.safeParse({
        ...applyRequest("codex", credentialFor("codex")),
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      profileSyncCredentialSchema.safeParse({
        kind: "antigravity-api-key",
        apiKey: "key",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("refuses a sync whose source and destination are the same host", () => {
    expect(
      profileSyncNowRequestSchema.safeParse({
        sourceHostId: "host-a",
        destinationHostId: "host-a",
      }).success,
    ).toBe(false);
    expect(
      profileSyncNowRequestSchema.safeParse({
        sourceHostId: "host-a",
        destinationHostId: "host-b",
      }).success,
    ).toBe(true);
  });
});

describe("hostProfileSyncFetchResponseSchema", () => {
  it("parses each of its three results", () => {
    expect(
      hostProfileSyncFetchResponseSchema.safeParse({
        result: "current",
        accountId: "acct",
        generation: 3,
        credential: credentialFor("codex"),
      }).success,
    ).toBe(true);
    expect(
      hostProfileSyncFetchResponseSchema.safeParse({
        result: "none",
        generation: 0,
      }).success,
    ).toBe(true);
    expect(
      hostProfileSyncFetchResponseSchema.safeParse({
        result: "refused",
        reason: "removed-on-device",
      }).success,
    ).toBe(true);
    expect(
      hostProfileSyncFetchResponseSchema.safeParse({
        result: "refused",
        reason: "not-a-reason",
      }).success,
    ).toBe(false);
  });
});

describe("released peer-transfer credential slots", () => {
  it("keeps Claude API keys off every released transfer contract", () => {
    const credential = { kind: "claude-api-key", apiKey: "synthetic-key" };
    expect(profileSyncCredentialSchema.safeParse(credential).success).toBe(
      true,
    );
    const apply =
      PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.apply"][1].versions[0]
        .contract.requestSchema;
    const offer =
      PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.offerCredential"][1]
        .versions[0].contract.requestSchema;
    const fetch =
      PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.fetchCredential"][1]
        .versions[0].contract.responseSchema;
    expect(
      apply.safeParse(applyRequest("claude", credentialFor("claude"))).success,
    ).toBe(true);
    expect(
      offer.safeParse(offerRequest("claude", credentialFor("claude"))).success,
    ).toBe(true);
    expect(
      fetch.safeParse({
        result: "current",
        accountId: "synthetic-account",
        generation: 1,
        credential: credentialFor("claude"),
      }).success,
    ).toBe(true);
    expect(
      apply.safeParse(
        applyRequest("claude", profileSyncCredentialSchema.parse(credential)),
      ).success,
    ).toBe(false);
    expect(
      offer.safeParse(
        offerRequest("claude", profileSyncCredentialSchema.parse(credential)),
      ).success,
    ).toBe(false);
    expect(
      fetch.safeParse({
        result: "current",
        accountId: "synthetic-account",
        generation: 1,
        credential,
      }).success,
    ).toBe(false);
  });
});

const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_LINK_ID = "33333333-3333-4333-8333-333333333333";
const member = (index: number): Record<string, unknown> => ({
  hostId: `host-${index}`,
  linkId: MEMBER_LINK_ID,
});
const MANY_MEMBERS = Array.from({ length: 33 }, (_, index) => member(index));

const PREPARE = {
  kind: "prepare",
  claimId: CLAIM_ID,
  claimantHostId: "host-a",
  keeperHostId: "host-b",
  members: [member(1), member(2)],
};

const STOP_STEPS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["prepare", PREPARE],
  [
    "handoff",
    {
      kind: "handoff",
      claimId: CLAIM_ID,
      accountId: "acct",
      generation: 4,
      credential: CREDENTIALS["codex"],
    },
  ],
  ["status", { kind: "status", claimId: CLAIM_ID }],
  ["closed", { kind: "closed", claimId: CLAIM_ID, generation: 4 }],
  ["abort", { kind: "abort", claimId: CLAIM_ID }],
];

const STOP_RESPONSES: ReadonlyArray<
  readonly [string, Record<string, unknown>]
> = [
  ["prepared", { result: "prepared" }],
  ["no-chain", { result: "no-chain" }],
  ["converted", { result: "converted" }],
  ["held", { result: "held", claimId: CLAIM_ID, claimantHostId: "host-a" }],
  ["committed", { result: "committed" }],
  ["unknown", { result: "unknown" }],
  ["receipt", { result: "receipt", generation: 4, held: "renewing" }],
  ["closed", { result: "closed" }],
  ["ok", { result: "ok" }],
  ["refused", { result: "refused", reason: "removed-on-device" }],
];

function stopRequest(step: Record<string, unknown>): Record<string, unknown> {
  return { linkId: LINK_ID, providerId: "codex", step };
}

const parsesRequest = (request: Record<string, unknown>): boolean =>
  hostProfileSyncStopLinkRequestSchema.safeParse(request).success;
const parsesResponse = (response: Record<string, unknown>): boolean =>
  hostProfileSyncStopLinkResponseSchema.safeParse(response).success;

describe("stopLink one-keeper steps", () => {
  it.each(STOP_STEPS)("round-trips the %s step", (_name, step) => {
    const request = stopRequest(step);
    expect(hostProfileSyncStopLinkRequestSchema.parse(request)).toEqual(
      request,
    );
  });

  it("refuses a request without linkId, a claim step, a cross step and a prepare with an extra key", () => {
    // The receiver's own link is named by every request.
    expect(parsesRequest(stopRequest(PREPARE))).toBe(true);
    expect(parsesRequest({ providerId: "codex", step: PREPARE })).toBe(false);
    const claim = {
      kind: "claim",
      claimId: CLAIM_ID,
      claimantHostId: "host-a",
      root: "host-a",
      uplink: "root",
      visited: ["host-a"],
    };
    const cross = { kind: "cross", claimId: CLAIM_ID, root: "host-a" };
    expect(
      [claim, cross].map((step) => parsesRequest(stopRequest(step))),
    ).toEqual([false, false]);
    expect(
      parsesRequest(stopRequest({ ...PREPARE, visited: ["host-a"] })),
    ).toBe(false);
  });

  it.each(STOP_RESPONSES)("round-trips the %s response", (_name, response) => {
    expect(hostProfileSyncStopLinkResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("refuses the old stance response and a prepared answer carrying acks", () => {
    expect(parsesResponse({ result: "prepared" })).toBe(true);
    expect(
      parsesResponse({
        result: "stance",
        stance: { kind: "converted" },
      }),
    ).toBe(false);
    expect(parsesResponse({ result: "prepared", acks: [] })).toBe(false);
  });

  it("accepts 32 members and refuses 33 or one without a linkId", () => {
    expect(
      parsesRequest(
        stopRequest({ ...PREPARE, members: MANY_MEMBERS.slice(0, 32) }),
      ),
    ).toBe(true);
    expect(
      parsesRequest(stopRequest({ ...PREPARE, members: MANY_MEMBERS })),
    ).toBe(false);
    expect(
      parsesRequest(
        stopRequest({ ...PREPARE, members: [{ hostId: "host-1" }] }),
      ),
    ).toBe(false);
  });

  it("keeps the answer literals out of the link reasons", () => {
    // `link.reason` is read by 1.5.4 with this enum.
    for (const literal of [
      "converted",
      "held",
      "committed",
      "no-chain",
      "prepared",
      "unknown",
    ]) {
      expect(profileSyncReasonSchema.options).not.toContain(literal);
    }
  });
});

describe("groupHolders moving, stopping and pinned", () => {
  it("keeps the answering end's pinned link and refuses one that is not a link ref", () => {
    const answer = {
      holders: [],
      complete: true,
      terminal: false,
      pinned: LINK_ID,
    };
    expect(hostProfileSyncGroupHoldersResponseSchema.parse(answer).pinned).toBe(
      LINK_ID,
    );
    expect(
      hostProfileSyncGroupHoldersResponseSchema.safeParse({
        ...answer,
        pinned: "account",
      }).success,
    ).toBe(false);
  });

  it("defaults moving, stopping and pinned when absent and keeps them when given", () => {
    expect(
      hostProfileSyncGroupHoldersResponseSchema.parse({
        holders: ["host-a"],
        complete: true,
        terminal: false,
        converted: false,
      }),
    ).toEqual({
      holders: ["host-a"],
      complete: true,
      terminal: false,
      converted: false,
      moving: false,
      stopping: false,
      pinned: null,
    });
    expect(
      hostProfileSyncGroupHoldersResponseSchema.parse({
        holders: ["host-a"],
        complete: true,
        terminal: false,
        converted: false,
        moving: true,
        stopping: true,
      }),
    ).toMatchObject({ moving: true, stopping: true });
  });
});

describe("groupHolders onward", () => {
  it("walks on unless the asker says the asked link alone", () => {
    const request = {
      linkId: LINK_ID,
      providerId: "codex",
      visited: ["host-a"],
    };
    expect(hostProfileSyncGroupHoldersRequestSchema.parse(request).onward).toBe(
      true,
    );
    expect(
      hostProfileSyncGroupHoldersRequestSchema.parse({
        ...request,
        onward: false,
      }).onward,
    ).toBe(false);
  });
});
