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

const PROFILE_ID = "44444444-4444-4444-8444-444444444444";

const stopRequest = {
  linkId: LINK_ID,
  providerId: "codex",
} as const;

describe("stopLink", () => {
  it("round-trips the one-step request and its answers", () => {
    expect(hostProfileSyncStopLinkRequestSchema.parse(stopRequest)).toEqual(
      stopRequest,
    );
    for (const response of [
      { result: "ended" },
      { result: "refused", reason: "removed-on-device" },
    ]) {
      expect(hostProfileSyncStopLinkResponseSchema.parse(response)).toEqual(
        response,
      );
    }
  });

  it("refuses a request without linkId and any retired step", () => {
    const parses = (request: Record<string, unknown>): boolean =>
      hostProfileSyncStopLinkRequestSchema.safeParse(request).success;
    expect(parses({ providerId: "codex" })).toBe(false);
    for (const step of [
      { kind: "leave" },
      { kind: "status", claimId: LINK_ID, profileId: "ambient" },
      { kind: "claim", claimId: LINK_ID },
    ]) {
      expect(parses({ ...stopRequest, step })).toBe(false);
    }
  });

  it("refuses the retired answers", () => {
    for (const result of [
      "prepared",
      "no-chain",
      "held",
      "committed",
      "unknown",
      "receipt",
      "closed",
      "ok",
    ]) {
      expect(
        hostProfileSyncStopLinkResponseSchema.safeParse({ result }).success,
      ).toBe(false);
    }
  });

  it("keeps the ended answer out of the link reasons", () => {
    // `link.reason` is read by 1.5.4 with this enum.
    expect(profileSyncReasonSchema.options).not.toContain("ended");
  });
});

describe("groupHolders answers", () => {
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

  it("defaults every flag, the split links and the pin when absent", () => {
    const holder = {
      hostId: "host-a",
      profileId: "ambient",
      linkId: LINK_ID,
      oldPeers: [],
      terminal: false,
    };
    expect(
      hostProfileSyncGroupHoldersResponseSchema.parse({
        holders: [holder],
        complete: true,
        terminal: false,
      }),
    ).toEqual({
      holders: [holder],
      complete: true,
      terminal: false,
      converted: false,
      moving: false,
      groupConverted: false,
      stopping: false,
      pinned: null,
      split: [],
      mixed: false,
      twoFolders: false,
    });
  });

  it("keeps twoFolders when the answer says so", () => {
    const answer = { holders: [], complete: true, terminal: false };
    expect(
      hostProfileSyncGroupHoldersResponseSchema.parse({
        ...answer,
        twoFolders: true,
      }).twoFolders,
    ).toBe(true);
  });

  it("refuses a holder without a profileId, and more than 32 holders", () => {
    const holder = {
      hostId: "host-a",
      profileId: PROFILE_ID,
      linkId: LINK_ID,
      oldPeers: [],
      terminal: false,
    };
    const { profileId: _profile, ...withoutProfile } = holder;
    const answer = (holders: unknown[]): boolean =>
      hostProfileSyncGroupHoldersResponseSchema.safeParse({
        holders,
        complete: true,
        terminal: false,
      }).success;
    expect(answer([holder])).toBe(true);
    expect(answer([withoutProfile])).toBe(false);
    expect(answer(Array.from({ length: 32 }, () => holder))).toBe(true);
    expect(answer(Array.from({ length: 33 }, () => holder))).toBe(false);
  });

  it("refuses a holder named by its host id alone", () => {
    expect(
      hostProfileSyncGroupHoldersResponseSchema.safeParse({
        holders: ["host-a"],
        complete: true,
        terminal: false,
      }).success,
    ).toBe(false);
  });
});

describe("groupHolders onward", () => {
  it("walks on unless the asker says the asked link alone", () => {
    const request = {
      linkId: LINK_ID,
      providerId: "codex",
      visited: [LINK_ID],
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

  it("takes link ids as visited, refuses a host id, and bounds them at 256", () => {
    const request = (visited: unknown[]): boolean =>
      hostProfileSyncGroupHoldersRequestSchema.safeParse({
        linkId: LINK_ID,
        providerId: "codex",
        visited,
      }).success;
    expect(request([LINK_ID])).toBe(true);
    expect(request(["host-a"])).toBe(false);
    expect(request(Array.from({ length: 256 }, () => LINK_ID))).toBe(true);
    expect(request(Array.from({ length: 257 }, () => LINK_ID))).toBe(false);
  });
});
