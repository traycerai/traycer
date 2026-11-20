import { describe, expect, it } from "vitest";
import { PROFILE_SYNC_LINK_RPC_METHODS } from "@traycer/protocol/host/profile-sync-link-contracts";
import {
  profileSyncCredentialFitsProvider,
  profileSyncCredentialSchema,
} from "@traycer/protocol/host/profile-sync-link-schemas";

const GROK_KEY = {
  kind: "grok-api-key",
  apiKey: "synthetic-grok-key",
} as const;
const GROK_OAUTH = {
  kind: "grok-auth-file",
  document: { refresh_token: "synthetic-refresh" },
} as const;

function applyRequest(credential: typeof GROK_KEY | typeof GROK_OAUTH) {
  return {
    linkId: "6f1c2f0e-8a44-4d19-9c3e-5b7a0d21f8ac",
    providerId: "grok",
    sourceProfileId: "0f6c1b2e-8a44-4d19-9c3e-5b7a0d21f8ac",
    profile: { name: "Work", color: "#ef4444", enabled: true },
    accountId: null,
    generation: 1,
    credential,
    acceptAccountChange: false,
    newLink: true,
  };
}

function offerRequest(credential: typeof GROK_KEY | typeof GROK_OAUTH) {
  return {
    linkId: "6f1c2f0e-8a44-4d19-9c3e-5b7a0d21f8ac",
    providerId: "grok",
    accountId: null,
    generation: 1,
    credential,
  };
}

describe("Grok API-key profile-sync protocol leaf", () => {
  it("accepts the current leaf and assigns it only to Grok", () => {
    const parsed = profileSyncCredentialSchema.safeParse(GROK_KEY);
    expect(parsed.success).toBe(true);
    expect(profileSyncCredentialFitsProvider("grok", GROK_KEY)).toBe(true);
    expect(profileSyncCredentialFitsProvider("claude", GROK_KEY)).toBe(false);
    expect(profileSyncCredentialFitsProvider("codex", GROK_KEY)).toBe(false);
    expect(profileSyncCredentialFitsProvider("antigravity", GROK_KEY)).toBe(
      false,
    );
  });

  it("keeps the API-key leaf out of every released V10 transfer contract", () => {
    const apply =
      PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.apply"][1].versions[0]
        .contract.requestSchema;
    const offer =
      PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.offerCredential"][1]
        .versions[0].contract.requestSchema;
    const fetch =
      PROFILE_SYNC_LINK_RPC_METHODS["host.profileSync.fetchCredential"][1]
        .versions[0].contract.responseSchema;

    expect(apply.safeParse(applyRequest(GROK_OAUTH)).success).toBe(true);
    expect(offer.safeParse(offerRequest(GROK_OAUTH)).success).toBe(true);
    expect(
      fetch.safeParse({
        result: "current",
        accountId: null,
        generation: 1,
        credential: GROK_OAUTH,
      }).success,
    ).toBe(true);

    expect(apply.safeParse(applyRequest(GROK_KEY)).success).toBe(false);
    expect(offer.safeParse(offerRequest(GROK_KEY)).success).toBe(false);
    expect(
      fetch.safeParse({
        result: "current",
        accountId: null,
        generation: 1,
        credential: GROK_KEY,
      }).success,
    ).toBe(false);
  });

  it("preserves future provider document fields while keeping the credential root strict", () => {
    const credential = {
      kind: "grok-auth-file",
      document: {
        refresh_token: "synthetic-refresh",
        providerAddedLater: { nested: true },
      },
    };
    expect(profileSyncCredentialSchema.parse(credential)).toEqual(credential);
    expect(
      profileSyncCredentialSchema.safeParse({ ...GROK_KEY, extra: true })
        .success,
    ).toBe(false);
  });
});
