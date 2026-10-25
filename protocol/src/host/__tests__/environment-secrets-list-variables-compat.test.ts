import { describe, expect, it } from "vitest";
import {
  environmentSecretsListUpgradeV11ToV12,
  environmentSecretsListV11,
  environmentSecretsListV12,
} from "@traycer/protocol/host/environment-contracts";

const row = {
  secretId: "sec-1",
  name: "ENV_E2E_SERVICE_TOKEN",
  kind: "api_key",
  protocol: "https",
  destinations: ["api.example.com"],
  mode: "exposed",
  state: "live",
  currentVersionId: "ver-1",
  revoked: false,
  updatedAt: 1,
};

const removed = {
  id: "sec-2",
  name: "OLD_TOKEN",
  removal: {
    outcome: "cleanup_requested" as const,
    revokedAt: 5,
    destroyedAt: null,
    targets: [
      {
        target: "host" as const,
        hostId: "host-1",
        hostName: "dev-box",
        state: "requested" as const,
        at: 4,
      },
    ],
  },
};

describe("environment.secrets.list 1.1 -> 1.2", () => {
  it("names no variables for a 1.1 host's rows and keeps removed", () => {
    const upgraded = environmentSecretsListUpgradeV11ToV12.upgradeResponse({
      secrets: [row],
      removed: [removed],
    });

    expect(upgraded.secrets).toEqual([
      { ...row, variables: [], providerVariables: [] },
    ]);
    expect(upgraded.removed).toEqual([
      {
        ...removed,
        removal: {
          ...removed.removal,
          targets: [{ ...removed.removal.targets[0], failedAt: null }],
        },
      },
    ]);
  });

  it("lets a 1.1 client parse a 1.2 answer, stripping the new keys", () => {
    const answer = environmentSecretsListV12.responseSchema.parse({
      secrets: [
        {
          ...row,
          variables: ["ENV_E2E_SERVICE_TOKEN"],
          providerVariables: [
            { providerId: "claude-code", name: "ANTHROPIC_AUTH_TOKEN" },
          ],
        },
      ],
      removed: [
        {
          ...removed,
          removal: {
            ...removed.removal,
            targets: [{ ...removed.removal.targets[0], failedAt: 9 }],
          },
        },
      ],
    });

    const parsed = environmentSecretsListV11.responseSchema.parse(answer);

    expect(parsed.secrets).toEqual([row]);
    expect(parsed.removed).toEqual([removed]);
  });

  it("defaults a missing 1.2 cleanup failure to null", () => {
    const parsed = environmentSecretsListV12.responseSchema.parse({
      secrets: [],
      removed: [removed],
    });

    expect(parsed.removed[0]?.removal.targets[0]?.failedAt).toBeNull();
  });
});
