import { describe, expect, it } from "vitest";
import {
  RPC_ERROR_CODES,
  isRpcErrorCode,
} from "@traycer/protocol/framework/versioned-rpc-types";
import * as env from "@traycer/protocol/host/environment-schemas";

/**
 * The wire of `providers.link`: its three prompt arms,
 * `providers.linkComplete`'s answer (the account the profile is linked as, and
 * the account it was expected to be on a mismatch), and the two error codes
 * the Link dialog turns into its states.
 */

describe("providers.link response", () => {
  it("parses the sign_in_url arm, with and without a code prompt", () => {
    const withPrompt = env.providersLinkResponseSchema.parse({
      linkId: "link-1",
      prompt: {
        kind: "sign_in_url",
        url: "https://claude.ai/oauth",
        codePrompt: "Code",
      },
    });
    expect(withPrompt.prompt).toStrictEqual({
      kind: "sign_in_url",
      url: "https://claude.ai/oauth",
      codePrompt: "Code",
    });
    const withoutPrompt = env.providersLinkResponseSchema.parse({
      linkId: "link-1",
      prompt: {
        kind: "sign_in_url",
        url: "https://claude.ai/oauth",
        codePrompt: null,
      },
    });
    expect(withoutPrompt.prompt).toMatchObject({ codePrompt: null });
  });

  it("parses the device_code arm", () => {
    const parsed = env.providersLinkResponseSchema.parse({
      linkId: "link-2",
      prompt: {
        kind: "device_code",
        verificationUrl: "https://auth.example.test/device",
        userCode: "ABCD-1234",
        expiresAt: 1_900_000_000,
      },
    });
    expect(parsed.prompt.kind).toBe("device_code");
  });

  it("parses the local_handoff arm, which carries no prompt fields", () => {
    const parsed = env.providersLinkResponseSchema.parse({
      linkId: "link-3",
      prompt: { kind: "local_handoff" },
    });
    expect(parsed).toStrictEqual({
      linkId: "link-3",
      prompt: { kind: "local_handoff" },
    });
  });

  it("rejects an unknown prompt kind and an empty link id", () => {
    expect(
      env.providersLinkResponseSchema.safeParse({
        linkId: "link-4",
        prompt: { kind: "carrier_pigeon" },
      }).success,
    ).toBe(false);
    expect(
      env.providersLinkResponseSchema.safeParse({
        linkId: "",
        prompt: { kind: "local_handoff" },
      }).success,
    ).toBe(false);
  });
});

describe("providers.linkComplete response", () => {
  it("parses with account and expectedAccount null", () => {
    const parsed = env.providersLinkCompleteResponseSchema.parse({
      state: "pending",
      code: null,
      account: null,
      expectedAccount: null,
    });
    expect(parsed).toStrictEqual({
      state: "pending",
      code: null,
      account: null,
      expectedAccount: null,
    });
  });

  it("parses with both accounts as strings, as a mismatch carries them", () => {
    const parsed = env.providersLinkCompleteResponseSchema.parse({
      state: "mismatch",
      code: null,
      account: "a@x.test",
      expectedAccount: "b@x.test",
    });
    expect(parsed.account).toBe("a@x.test");
    expect(parsed.expectedAccount).toBe("b@x.test");
  });

  it("rejects a missing account key", () => {
    expect(
      env.providersLinkCompleteResponseSchema.safeParse({
        state: "linked",
        code: null,
        expectedAccount: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing expectedAccount key", () => {
    expect(
      env.providersLinkCompleteResponseSchema.safeParse({
        state: "linked",
        code: null,
        account: "a@x.test",
      }).success,
    ).toBe(false);
  });

  it("accepts an account of 320 characters and rejects one over it", () => {
    const atLimit = "a".repeat(320);
    expect(
      env.providersLinkCompleteResponseSchema.safeParse({
        state: "linked",
        code: null,
        account: atLimit,
        expectedAccount: null,
      }).success,
    ).toBe(true);
    expect(
      env.providersLinkCompleteResponseSchema.safeParse({
        state: "linked",
        code: null,
        account: `${atLimit}a`,
        expectedAccount: null,
      }).success,
    ).toBe(false);
    expect(
      env.providersLinkCompleteResponseSchema.safeParse({
        state: "mismatch",
        code: null,
        account: "a@x.test",
        expectedAccount: `${atLimit}a`,
      }).success,
    ).toBe(false);
  });
});

describe("the Link error codes", () => {
  it("are members of RPC_ERROR_CODES", () => {
    expect(RPC_ERROR_CODES).toContain("PROVIDER_LINK_NOT_OFFERED");
    expect(RPC_ERROR_CODES).toContain("PROVIDER_LINK_UNAVAILABLE");
  });

  it("are accepted by isRpcErrorCode", () => {
    expect(isRpcErrorCode("PROVIDER_LINK_NOT_OFFERED")).toBe(true);
    expect(isRpcErrorCode("PROVIDER_LINK_UNAVAILABLE")).toBe(true);
    expect(isRpcErrorCode("PROVIDER_LINK_NOPE")).toBe(false);
  });
});
