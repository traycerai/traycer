import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providerCliStateSchema,
  providersListResponseSchema,
  providersListResponseSchemaV109Preimage,
  providersSetModelProviderHiddenRequestSchema,
  providersSetModelProviderHiddenResponseSchema,
} from "@traycer/protocol/host/provider-schemas";

const row = {
  providerId: "opencode",
  enabled: true,
  disabledBy: null,
  selected: { kind: "bundled" },
  candidates: [],
  authPending: false,
  checkedAt: null,
  apiKey: { supported: false, configured: false, source: null },
  auth: { status: "unknown", badgeText: null, label: null, detail: null },
};

describe("hidden model providers protocol", () => {
  it("publishes and validates the row field on providers.list@10.10", () => {
    expect(
      providersListResponseSchema.parse({
        providers: [{ ...row, hiddenModelProviders: ["openrouter"] }],
        native: null,
      }).providers[0].hiddenModelProviders,
    ).toEqual(["openrouter"]);
    expect(
      providersListResponseSchemaV109Preimage.parse({
        providers: [{ ...row, hiddenModelProviders: ["openrouter"] }],
        native: null,
      }).providers[0],
    ).not.toHaveProperty("hiddenModelProviders");
    expect(
      providerCliStateSchema.safeParse({ ...row, hiddenModelProviders: [""] })
        .success,
    ).toBe(false);
  });

  it("validates the setter request and stored-list response", () => {
    expect(
      providersSetModelProviderHiddenRequestSchema.safeParse({
        harnessId: "opencode",
        modelProviderId: "openrouter",
        hidden: true,
      }).success,
    ).toBe(true);
    expect(
      providersSetModelProviderHiddenRequestSchema.safeParse({
        harnessId: "opencode",
        modelProviderId: "",
        hidden: true,
      }).success,
    ).toBe(false);
    expect(
      providersSetModelProviderHiddenRequestSchema.safeParse({
        harnessId: "unknown",
        modelProviderId: "openrouter",
        hidden: true,
      }).success,
    ).toBe(false);
    expect(
      providersSetModelProviderHiddenResponseSchema.parse({
        hiddenModelProviders: ["openrouter"],
      }),
    ).toEqual({ hiddenModelProviders: ["openrouter"] });
  });

  it("registers as optional 1.0 and degrades to unsupported", () => {
    const entry = hostRpcRegistry["providers.setModelProviderHidden"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
  });
});
