import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSecretValue } from "../configuration-secrets";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

const BEARER = "test-bearer-secret";
const SECRET_VALUE = "test-secret-value";

afterEach(() => {
  vi.restoreAllMocks();
});

async function replaceAndReadRefusal(
  bearer: string,
  value: string,
  authnText: string,
): Promise<string> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: authnText }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  );

  try {
    await replaceSecretValue(createEnvironmentCloud(bearer), "team-a", {
      environmentId: "team-a",
      secretId: "secret-a",
      value,
      expectedVersionId: "version-1",
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
  throw new Error("Expected authn to refuse the secret change.");
}

describe("environment error messages", () => {
  it("replaces authn text that contains the request's bearer", async () => {
    const message = await replaceAndReadRefusal(
      BEARER,
      SECRET_VALUE,
      `Bearer ${BEARER} is invalid.`,
    );

    expect(message).toBe("Your environment did not accept this change.");
    expect(message).not.toContain(BEARER);
    expect(message).not.toContain(SECRET_VALUE);
  });

  it("replaces authn text that contains the request's secret value", async () => {
    const message = await replaceAndReadRefusal(
      BEARER,
      SECRET_VALUE,
      `Value ${SECRET_VALUE} is invalid.`,
    );

    expect(message).toBe("Your environment did not accept this change.");
    expect(message).not.toContain(BEARER);
    expect(message).not.toContain(SECRET_VALUE);
  });

  it("shows authn's refusal words when they contain no request secret", async () => {
    const message = await replaceAndReadRefusal(
      BEARER,
      SECRET_VALUE,
      "The requested value is invalid.",
    );

    expect(message).toBe("The requested value is invalid.");
  });

  it("replaces authn text that contains a one-character secret value", async () => {
    const message = await replaceAndReadRefusal(
      BEARER,
      "x",
      "Invalid value: x",
    );

    expect(message).toBe("Your environment did not accept this change.");
    expect(message).not.toContain("x");
  });
});
