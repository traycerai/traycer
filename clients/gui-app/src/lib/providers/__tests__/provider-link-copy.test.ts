import { describe, expect, it } from "vitest";
import type {
  ProvidersLinkCompleteResponse,
  ProvidersLinkResponse,
} from "@traycer/protocol/host/environment-schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  LINK_FAILED,
  LINK_INTRO,
  LINK_NO_SIGN_IN,
  LINK_PASTE_WHOLE_CODE,
  LINK_UNAVAILABLE,
  linkedLine,
  mismatchLine,
  onHostOnlyLine,
  stateOfLinkComplete,
  stateOfLinkError,
  stateOfLinkStart,
  type LinkDialogState,
} from "@/lib/providers/provider-link-copy";

function rpcError(
  code: "PROVIDER_LINK_NOT_OFFERED" | "PROVIDER_LINK_UNAVAILABLE" | "RPC_ERROR",
  message: string,
): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req-1",
    method: "providers.link",
    fatalDetails: null,
  });
}

function completeResponse(
  overrides: Partial<ProvidersLinkCompleteResponse>,
): ProvidersLinkCompleteResponse {
  return {
    state: "pending",
    code: null,
    account: null,
    expectedAccount: null,
    ...overrides,
  };
}

const SIGN_IN: LinkDialogState = {
  kind: "sign_in",
  linkId: "link-1",
  url: "https://claude.ai/oauth",
  codePrompt: "Code",
  note: null,
};

describe("the exact copy", () => {
  it("states the intro, the unavailable line and the per-host lines word for word", () => {
    expect(LINK_INTRO).toBe(
      "This signs Traycer in to your plan once. It will be offered on every host and sandbox you use; it counts as a device on your plan.",
    );
    expect(LINK_UNAVAILABLE).toBe("Connect to Traycer to link this profile.");
    expect(onHostOnlyLine("Studio")).toBe("On Studio only.");
    expect(mismatchLine("a@x.test", "b@x.test")).toBe(
      "You signed in as a@x.test, not b@x.test.",
    );
  });

  it("names the account on a linked line only when it is known", () => {
    expect(linkedLine("a@x.test")).toBe("Linked as a@x.test.");
    expect(linkedLine(null)).toBe("Linked.");
  });

  it("falls back to a generic mismatch line when either account is unknown", () => {
    expect(mismatchLine(null, "b@x.test")).toBe(
      "You signed in to a different account.",
    );
    expect(mismatchLine("a@x.test", null)).toBe(
      "You signed in to a different account.",
    );
  });
});

describe("stateOfLinkStart", () => {
  it("opens a sign-in with the pasted-code prompt the host named", () => {
    const response: ProvidersLinkResponse = {
      linkId: "link-1",
      prompt: {
        kind: "sign_in_url",
        url: "https://claude.ai/oauth",
        codePrompt: "Authorization code",
      },
    };
    expect(stateOfLinkStart(response)).toStrictEqual({
      kind: "sign_in",
      linkId: "link-1",
      url: "https://claude.ai/oauth",
      codePrompt: "Authorization code",
      note: null,
    });
  });

  it("labels the code box 'Code' when the host named no prompt", () => {
    const response: ProvidersLinkResponse = {
      linkId: "link-1",
      prompt: {
        kind: "sign_in_url",
        url: "https://claude.ai/oauth",
        codePrompt: null,
      },
    };
    expect(stateOfLinkStart(response)).toMatchObject({
      kind: "sign_in",
      codePrompt: "Code",
    });
  });

  it("shows a device code with its verification page", () => {
    const response: ProvidersLinkResponse = {
      linkId: "link-2",
      prompt: {
        kind: "device_code",
        verificationUrl: "https://auth.example.test/device",
        userCode: "ABCD-1234",
        expiresAt: 1_700_000_000,
      },
    };
    expect(stateOfLinkStart(response)).toStrictEqual({
      kind: "device",
      linkId: "link-2",
      verificationUrl: "https://auth.example.test/device",
      userCode: "ABCD-1234",
    });
  });

  it("goes straight to linking on a local handoff", () => {
    const response: ProvidersLinkResponse = {
      linkId: "link-3",
      prompt: { kind: "local_handoff" },
    };
    expect(stateOfLinkStart(response)).toStrictEqual({
      kind: "linking",
      linkId: "link-3",
    });
  });
});

describe("stateOfLinkError", () => {
  it("maps PROVIDER_LINK_NOT_OFFERED to not_offered", () => {
    expect(
      stateOfLinkError(rpcError("PROVIDER_LINK_NOT_OFFERED", "host detail")),
    ).toStrictEqual({ kind: "not_offered" });
  });

  it("maps PROVIDER_LINK_UNAVAILABLE to unavailable", () => {
    expect(
      stateOfLinkError(rpcError("PROVIDER_LINK_UNAVAILABLE", "host detail")),
    ).toStrictEqual({ kind: "unavailable" });
  });

  it("keeps another host error's message as the failed line", () => {
    expect(
      stateOfLinkError(rpcError("RPC_ERROR", "the keychain is locked")),
    ).toStrictEqual({ kind: "failed", line: "the keychain is locked" });
  });

  it("keeps a plain Error's message as the failed line", () => {
    expect(stateOfLinkError(new Error("socket closed"))).toStrictEqual({
      kind: "failed",
      line: "socket closed",
    });
  });

  it("uses the generic line for an empty message or a non-Error", () => {
    expect(stateOfLinkError(rpcError("RPC_ERROR", ""))).toStrictEqual({
      kind: "failed",
      line: LINK_FAILED,
    });
    expect(stateOfLinkError("boom")).toStrictEqual({
      kind: "failed",
      line: LINK_FAILED,
    });
  });
});

describe("stateOfLinkComplete", () => {
  it("keeps the account on linked", () => {
    expect(
      stateOfLinkComplete(
        SIGN_IN,
        completeResponse({ state: "linked", account: "a@x.test" }),
      ),
    ).toStrictEqual({ kind: "linked", account: "a@x.test" });
  });

  it("links without an account when the host named none", () => {
    expect(
      stateOfLinkComplete(SIGN_IN, completeResponse({ state: "linked" })),
    ).toStrictEqual({ kind: "linked", account: null });
  });

  it("carries both accounts on mismatch", () => {
    expect(
      stateOfLinkComplete(
        SIGN_IN,
        completeResponse({
          state: "mismatch",
          account: "a@x.test",
          expectedAccount: "b@x.test",
        }),
      ),
    ).toStrictEqual({
      kind: "mismatch",
      account: "a@x.test",
      expectedAccount: "b@x.test",
    });
  });

  it("maps expired and unavailable", () => {
    expect(
      stateOfLinkComplete(SIGN_IN, completeResponse({ state: "expired" })),
    ).toStrictEqual({ kind: "expired" });
    expect(
      stateOfLinkComplete(SIGN_IN, completeResponse({ state: "unavailable" })),
    ).toStrictEqual({ kind: "unavailable" });
  });

  it("explains no_sign_in on a failed link", () => {
    expect(
      stateOfLinkComplete(
        SIGN_IN,
        completeResponse({ state: "failed", code: "no_sign_in" }),
      ),
    ).toStrictEqual({ kind: "failed", line: LINK_NO_SIGN_IN });
  });

  it("uses the generic line for any other failure or unknown state", () => {
    expect(
      stateOfLinkComplete(SIGN_IN, completeResponse({ state: "failed" })),
    ).toStrictEqual({ kind: "failed", line: LINK_FAILED });
    expect(
      stateOfLinkComplete(
        SIGN_IN,
        completeResponse({ state: "something_new", code: "no_sign_in" }),
      ),
    ).toStrictEqual({ kind: "failed", line: LINK_NO_SIGN_IN });
    expect(
      stateOfLinkComplete(
        SIGN_IN,
        completeResponse({ state: "failed", code: "other" }),
      ),
    ).toStrictEqual({ kind: "failed", line: LINK_FAILED });
  });

  it("asks for the whole code on a pending sign-in whose paste was short", () => {
    expect(
      stateOfLinkComplete(
        SIGN_IN,
        completeResponse({ state: "pending", code: "harness_token_shape" }),
      ),
    ).toStrictEqual({ ...SIGN_IN, note: LINK_PASTE_WHOLE_CODE });
  });

  it("clears the note on a pending sign-in without that code", () => {
    const noted: LinkDialogState = { ...SIGN_IN, note: LINK_PASTE_WHOLE_CODE };
    expect(
      stateOfLinkComplete(noted, completeResponse({ state: "pending" })),
    ).toStrictEqual({ ...SIGN_IN, note: null });
  });

  it("returns the very same state while a device code or a handoff is pending", () => {
    const device: LinkDialogState = {
      kind: "device",
      linkId: "link-2",
      verificationUrl: "https://auth.example.test/device",
      userCode: "ABCD-1234",
    };
    const linking: LinkDialogState = { kind: "linking", linkId: "link-3" };
    expect(
      stateOfLinkComplete(device, completeResponse({ state: "pending" })),
    ).toBe(device);
    expect(
      stateOfLinkComplete(linking, completeResponse({ state: "pending" })),
    ).toBe(linking);
  });
});
