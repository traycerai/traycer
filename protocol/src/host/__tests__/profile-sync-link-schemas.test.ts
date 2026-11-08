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
  "grok-key": { kind: "grok-api-key", apiKey: "grok-key" },
  "antigravity-oauth": { kind: "antigravity-oauth", document: { token: "t" } },
  "antigravity-key": { kind: "antigravity-api-key", apiKey: "key" },
};

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
    ["grok-key", ["grok"]],
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
  function fetchCurrent(credential: unknown): Record<string, unknown> {
    return {
      result: "current",
      accountId: "synthetic-account",
      generation: 1,
      credential,
    };
  }

  /** The five variants frozen into the retired @1.0 slots, named as `CREDENTIALS`. */
  const FROZEN: ReadonlyArray<readonly [ProfileSyncProvider, string]> = [
    ["claude", "claude"],
    ["codex", "codex"],
    ["grok", "grok"],
    ["antigravity", "antigravity-oauth"],
    ["antigravity", "antigravity-key"],
  ];
  /** Canonical-only kinds: valid for their provider, never on a retired slot. */
  const LIVE_ONLY: ReadonlyArray<
    readonly [ProfileSyncProvider, Record<string, unknown>]
  > = [
    ["claude", { kind: "claude-api-key", apiKey: "synthetic-key" }],
    ["grok", { kind: "grok-api-key", apiKey: "synthetic-key" }],
  ];

  it.each(FROZEN)(
    "accepts %s with %s on every released slot",
    (providerId, name) => {
      const apply =
        PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.apply"][1].versions[0]
          .contract.requestSchema;
      const offer =
        PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.offerCredential"][1]
          .versions[0].contract.requestSchema;
      const fetch =
        PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.fetchCredential"][1]
          .versions[0].contract.responseSchema;
      const credential = credentialFor(name);
      expect(
        apply.safeParse(applyRequest(providerId, credential)).success,
      ).toBe(true);
      expect(
        offer.safeParse(offerRequest(providerId, credential)).success,
      ).toBe(true);
      expect(fetch.safeParse(fetchCurrent(credential)).success).toBe(true);
    },
  );

  it.each(LIVE_ONLY)(
    "keeps the %s sign-in %j off every released slot",
    (providerId, credential) => {
      const apply =
        PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.apply"][1].versions[0]
          .contract.requestSchema;
      const offer =
        PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.offerCredential"][1]
          .versions[0].contract.requestSchema;
      const fetch =
        PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.fetchCredential"][1]
          .versions[0].contract.responseSchema;
      const canonical = profileSyncCredentialSchema.parse(credential);
      expect(profileSyncCredentialFitsProvider(providerId, canonical)).toBe(
        true,
      );
      expect(apply.safeParse(applyRequest(providerId, canonical)).success).toBe(
        false,
      );
      expect(offer.safeParse(offerRequest(providerId, canonical)).success).toBe(
        false,
      );
      expect(fetch.safeParse(fetchCurrent(canonical)).success).toBe(false);
    },
  );

  it("lists every canonical kind outside the frozen five, so each gets a refusal proof", () => {
    const frozen: string[] = FROZEN.map(([, name]) => credentialFor(name).kind);
    const canonical: string[] = profileSyncCredentialSchema.def.options.map(
      (option) => option.shape.kind.value,
    );
    expect(canonical).toEqual(expect.arrayContaining(frozen));
    expect(canonical.filter((kind) => !frozen.includes(kind)).sort()).toEqual(
      LIVE_ONLY.map(([, credential]) => String(credential.kind)).sort(),
    );
  });
});
