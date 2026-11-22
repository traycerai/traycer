import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecret, replaceSecretValue } from "../configuration-secrets";
import type { EnvironmentSecretsCreateRequestV11 } from "@traycer/protocol/host/environment-schemas";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("environment secret refusal mapping", () => {
  it("keeps authn's words for a role refusal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "The role cannot make this change." }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(
      replaceSecretValue(createEnvironmentCloud("test-bearer"), "team-a", {
        environmentId: "team-a",
        secretId: "secret-a",
        value: "secret-value",
        expectedVersionId: "version-1",
      }),
    ).rejects.toMatchObject({
      kind: "invalid",
      message: "The role cannot make this change.",
    });
  });

  it("uses the secrets-specific sign-in refusal for a 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "expired" }), { status: 401 }),
    );

    await expect(
      replaceSecretValue(createEnvironmentCloud("test-bearer"), "team-a", {
        environmentId: "team-a",
        secretId: "secret-a",
        value: "secret-value",
        expectedVersionId: "version-1",
      }),
    ).rejects.toMatchObject({
      kind: "unauthorized",
      message: "Sign in again to manage secrets.",
    });
  });

  it("returns the stale replacement outcome for authn's secret-version 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "secret_version_stale",
          currentVersionId: "version-2",
          changedBy: { kind: "dashboard" },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      replaceSecretValue(createEnvironmentCloud("test-bearer"), "team-a", {
        environmentId: "team-a",
        secretId: "secret-a",
        value: "secret-value",
        expectedVersionId: "version-1",
      }),
    ).resolves.toEqual({
      outcome: "stale",
      currentVersionId: "version-2",
      changedBy: { kind: "dashboard" },
    });
  });

  it("returns the destination refusal arm for authn's 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "destination_unresolvable" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request: EnvironmentSecretsCreateRequestV11 = {
      environmentId: "team-a",
      name: "API_KEY",
      kind: "http",
      protocol: "https",
      hosts: ["api.example.com"],
      port: null,
      identity: null,
      database: null,
      policy: null,
      tlsPolicy: null,
      pinnedHostKeys: null,
      connectorId: null,
      confirmedAddresses: null,
      value: "secret-value",
      mode: "brokered",
      portOverride: false,
      swapSites: ["header"],
      variables: [],
      exportPolicy: null,
      sandboxesByDefault: false,
      plaintextConsent: null,
    };

    await expect(
      createSecret(createEnvironmentCloud("test-bearer"), "team-a", request),
    ).resolves.toEqual({
      outcome: "refused",
      code: "destination_unresolvable",
    });
  });
});
