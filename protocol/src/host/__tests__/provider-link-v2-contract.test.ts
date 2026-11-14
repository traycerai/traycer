import { describe, expect, it } from "vitest";
import {
  providersLinkCompleteV10,
  providersLinkCompleteV11,
  providersLinkCompleteV20,
  providersLinkV10,
  providersLinkV11,
  providersLinkV20,
} from "@traycer/protocol/host/environment-contracts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("dormant providers.link@2.0 contracts", () => {
  it("requires each link request field and keeps the request strict", () => {
    const request = {
      providerId: "claude-code",
      profileId: "profile-1",
      intentOperationId: UUID,
      expectedEnvironmentId: "environment-1",
    };
    expect(providersLinkV20.requestSchema.parse(request)).toEqual(request);
    expect(() =>
      providersLinkV20.requestSchema.parse({ ...request, extra: true }),
    ).toThrow();
    expect(() =>
      providersLinkV20.requestSchema.parse({
        ...request,
        intentOperationId: "not-a-uuid",
      }),
    ).toThrow();
    for (const missing of [
      {
        profileId: "profile-1",
        intentOperationId: UUID,
        expectedEnvironmentId: "environment-1",
      },
      {
        providerId: "claude-code",
        intentOperationId: UUID,
        expectedEnvironmentId: "environment-1",
      },
      {
        providerId: "claude-code",
        profileId: "profile-1",
        expectedEnvironmentId: "environment-1",
      },
      {
        providerId: "claude-code",
        profileId: "profile-1",
        intentOperationId: UUID,
      },
    ]) {
      expect(() => providersLinkV20.requestSchema.parse(missing)).toThrow();
    }
    expect(() =>
      providersLinkV20.requestSchema.parse({ ...request, profileId: "" }),
    ).toThrow();
    expect(() =>
      providersLinkV20.requestSchema.parse({
        ...request,
        expectedEnvironmentId: "",
      }),
    ).toThrow();
  });

  it("accepts only the success shape and the three link refusal codes", () => {
    const success = { ok: true, linkId: "link-1" };
    expect(providersLinkV20.responseSchema.parse(success)).toEqual(success);
    const refusals = [
      "not_offered",
      "profile_not_found",
      "environment_mismatch",
    ] as const;
    for (const code of refusals) {
      const refusal = { ok: false as const, code };
      expect(providersLinkV20.responseSchema.parse(refusal)).toEqual(refusal);
    }
    expect(() =>
      providersLinkV20.responseSchema.parse({ ok: false, code: "future_code" }),
    ).toThrow();
    expect(() => providersLinkV20.responseSchema.parse({ ok: true })).toThrow();
    expect(() =>
      providersLinkV20.responseSchema.parse({ ...success, account: "person" }),
    ).toThrow();
    for (const field of ["detail", "message"] as const) {
      expect(() =>
        providersLinkV20.responseSchema.parse({
          ok: false,
          code: "not_offered",
          [field]: "host sentence",
        }),
      ).toThrow();
    }
  });

  it("keeps linkComplete@2.0's request strict and linkId-only", () => {
    const request = { linkId: "link-1" };
    expect(providersLinkCompleteV20.requestSchema.parse(request)).toEqual(
      request,
    );
    for (const extra of [
      { code: "old-code" },
      { environmentId: "environment-1" },
    ]) {
      expect(() =>
        providersLinkCompleteV20.requestSchema.parse({ ...request, ...extra }),
      ).toThrow();
    }
  });

  it("accepts only the bare linkComplete states and three failed codes", () => {
    for (const state of [
      "pending",
      "unavailable",
      "linked",
      "expired",
    ] as const) {
      const answer = { state };
      expect(providersLinkCompleteV20.responseSchema.parse(answer)).toEqual(
        answer,
      );
    }
    for (const code of [
      "no_sign_in",
      "account_mismatch",
      "link_refused",
    ] as const) {
      const answer = { state: "failed" as const, code };
      expect(providersLinkCompleteV20.responseSchema.parse(answer)).toEqual(
        answer,
      );
    }
    for (const code of ["target_mismatch", "future_code"] as const) {
      expect(() =>
        providersLinkCompleteV20.responseSchema.parse({
          state: "failed",
          code,
        }),
      ).toThrow();
    }
    expect(() =>
      providersLinkCompleteV20.responseSchema.parse({ state: "failed" }),
    ).toThrow();
    expect(() =>
      providersLinkCompleteV20.responseSchema.parse({
        state: "mismatch",
        account: "person",
        expectedAccount: "other",
      }),
    ).toThrow();
    for (const field of [
      "account",
      "expectedAccount",
      "detail",
      "message",
    ] as const) {
      expect(() =>
        providersLinkCompleteV20.responseSchema.parse({
          state: "failed",
          code: "link_refused",
          [field]: "not on the wire",
        }),
      ).toThrow();
    }
    expect(() =>
      providersLinkCompleteV20.responseSchema.parse({
        state: "pending",
        code: "no_sign_in",
      }),
    ).toThrow();
  });

  it("preserves the released major-1 link shapes", () => {
    const handoff = {
      linkId: "link-1",
      prompt: { kind: "local_handoff" as const },
    };
    expect(providersLinkV10.responseSchema.parse(handoff)).toEqual(handoff);
    const signInUrl = {
      linkId: "link-2",
      prompt: {
        kind: "sign_in_url" as const,
        url: "https://example.test/sign-in",
        codePrompt: null,
      },
    };
    expect(providersLinkV11.responseSchema.parse(signInUrl)).toEqual(signInUrl);

    const mismatch = {
      state: "mismatch",
      code: null,
      account: "person",
      expectedAccount: "other",
    };
    expect(providersLinkCompleteV11.responseSchema.parse(mismatch)).toEqual(
      mismatch,
    );

    const majorOneRequest = { providerId: "claude-code", profileId: null };
    expect(providersLinkV10.requestSchema.parse(majorOneRequest)).toEqual(
      majorOneRequest,
    );
    const completeRequest = { linkId: "link-1", code: null };
    expect(
      providersLinkCompleteV10.requestSchema.parse(completeRequest),
    ).toEqual(completeRequest);
    const requestWithEnvironment = {
      providerId: "claude-code",
      profileId: "profile-1",
      environmentId: "environment-1",
    };
    expect(
      providersLinkV11.requestSchema.parse(requestWithEnvironment),
    ).toEqual(requestWithEnvironment);
    expect(
      providersLinkV11.requestSchema.parse({
        providerId: "claude-code",
        profileId: "profile-1",
      }).environmentId,
    ).toBeNull();
    const completeRequestWithEnvironment = {
      linkId: "link-1",
      code: null,
      environmentId: "environment-1",
    };
    expect(
      providersLinkCompleteV11.requestSchema.parse(
        completeRequestWithEnvironment,
      ),
    ).toEqual(completeRequestWithEnvironment);
    expect(
      providersLinkCompleteV11.requestSchema.parse({
        linkId: "link-1",
        code: null,
      }).environmentId,
    ).toBeNull();
  });
});
