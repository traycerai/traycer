/**
 * Wire contract of profile sync: which sign-in may travel under which
 * provider, the closed sets the app renders, and the bounds a host enforces.
 */
import { describe, expect, it } from "vitest";
import {
  PROFILE_SYNC_MAX_CREDENTIAL_BYTES,
  hostProfileSyncApplyRequestSchema,
  hostProfileSyncFetchResponseSchema,
  hostProfileSyncOfferRequestSchema,
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
