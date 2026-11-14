import { describe, expect, it, vi } from "vitest";
import { replaceSecretValue } from "../configuration-secrets";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

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
});
