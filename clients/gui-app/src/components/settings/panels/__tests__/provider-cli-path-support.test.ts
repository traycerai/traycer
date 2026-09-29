import { describe, expect, it } from "vitest";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  providerCustomCliPathHeldReason,
  providerSupportsCustomCliPath,
} from "@/components/settings/panels/provider-cli-path-support";

describe("providerSupportsCustomCliPath", () => {
  it("is false for antigravity - its agent runs the managed download's own ACP server, not a CLI on a path", () => {
    expect(providerSupportsCustomCliPath("antigravity")).toBe(false);
  });

  const SUPPORTED_PROVIDERS: readonly ProviderId[] = [
    "codex",
    "claude-code",
    "opencode",
  ];
  for (const providerId of SUPPORTED_PROVIDERS) {
    it(`is true for ${providerId}`, () => {
      expect(providerSupportsCustomCliPath(providerId)).toBe(true);
    });
  }
});

describe("providerCustomCliPathHeldReason", () => {
  it("names antigravity's own ACP server as the reason", () => {
    expect(providerCustomCliPathHeldReason("antigravity")).toBe(
      "Antigravity runs only its own ACP server (`agy_acp_server`), not the `agy` CLI, so a custom CLI path isn't supported.",
    );
  });

  it("holds on every platform: names no managed download, which an Intel Mac lacks", () => {
    expect(providerCustomCliPathHeldReason("antigravity")).not.toMatch(
      /download/iu,
    );
  });

  const SUPPORTED_PROVIDERS: readonly ProviderId[] = [
    "codex",
    "claude-code",
    "opencode",
  ];
  for (const providerId of SUPPORTED_PROVIDERS) {
    it(`is null for ${providerId} - the control is not held`, () => {
      expect(providerCustomCliPathHeldReason(providerId)).toBeNull();
    });
  }
});
