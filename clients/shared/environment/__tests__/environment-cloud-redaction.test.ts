import { describe, expect, it, vi } from "vitest";
import { replaceSecretValue } from "../configuration-secrets";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

const BEARER = "test-bearer-secret";
const SECRET_VALUE = "test-secret-value";
const REQUEST_BODY = JSON.stringify({
  value: SECRET_VALUE,
  expectedVersionId: "version-1",
});

describe("environment error messages", () => {
  it("does not expose the bearer, secret value, or request body on refusal", async () => {
    const responseMessage = `Bearer ${BEARER}; value=${SECRET_VALUE}; request=${REQUEST_BODY}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: responseMessage }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    let errorMessage: string | null = null;

    try {
      await replaceSecretValue(createEnvironmentCloud(BEARER), "team-a", {
        environmentId: "team-a",
        secretId: "secret-a",
        value: SECRET_VALUE,
        expectedVersionId: "version-1",
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errorMessage = error.message;
    }

    expect(errorMessage).not.toBeNull();
    expect(errorMessage).not.toContain(BEARER);
    expect(errorMessage).not.toContain(SECRET_VALUE);
    expect(errorMessage).not.toContain(REQUEST_BODY);
  });
});
