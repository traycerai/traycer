import { SANDBOX_PLAINTEXT_DISCLOSURE_VERSION } from "@traycer/protocol/host/secret-intake-catalogue";
import { describe, expect, it } from "vitest";
import {
  heldSecretApplyRequest,
  heldSecretBindingProblem,
} from "@/components/settings/move/held-secret-binding";
import {
  initialSecretForm,
  type SecretFormState,
} from "@/lib/sandboxes/secret-intake-form";

function apiKey(patch: Partial<SecretFormState>): SecretFormState {
  return {
    ...initialSecretForm("api_key"),
    hosts: "api.example.com",
    ...patch,
  };
}

describe("heldSecretBindingProblem", () => {
  it("accepts a destination with a swap site", () => {
    expect(heldSecretBindingProblem(apiKey({}))).toBeNull();
  });

  it("asks for a host, and rejects a bad or too many hosts", () => {
    expect(heldSecretBindingProblem(apiKey({ hosts: "  " }))).toBe(
      "Enter the server address.",
    );
    expect(heldSecretBindingProblem(apiKey({ hosts: "bad host!" }))).toContain(
      "is not a hostname",
    );
    const many = Array.from({ length: 17 }, (_, i) => `h${i}.example.com`);
    expect(heldSecretBindingProblem(apiKey({ hosts: many.join(",") }))).toBe(
      "A secret reaches at most 16 hosts.",
    );
  });

  it("rejects an unreadable or out-of-range port", () => {
    expect(heldSecretBindingProblem(apiKey({ port: "abc" }))).toBe(
      "The port is a number from 1 to 65535.",
    );
    expect(heldSecretBindingProblem(apiKey({ port: "0" }))).toBe(
      "The port is a number from 1 to 65535.",
    );
    expect(heldSecretBindingProblem(apiKey({ port: "65535" }))).toBeNull();
  });

  it("needs a swap site for an API key", () => {
    expect(heldSecretBindingProblem(apiKey({ swapSites: [] }))).toBe(
      "Choose where the key appears in a request.",
    );
  });

  it("needs the plaintext notice confirmed for a brokered database login", () => {
    const db = {
      ...initialSecretForm("database"),
      hosts: "db.example.com",
    };
    expect(heldSecretBindingProblem(db)).toBe("Confirm the plaintext notice.");
    expect(
      heldSecretBindingProblem({ ...db, plaintextConsent: true }),
    ).toBeNull();
  });
});

describe("heldSecretApplyRequest", () => {
  it("carries the binding and never a value", () => {
    const request = heldSecretApplyRequest(
      "held-1",
      apiKey({
        hosts: "a.example.com, b.example.com",
        port: "8443",
        value: "sk-should-not-travel",
        swapSites: ["header", "query"],
      }),
    );
    expect(request).toEqual({
      heldId: "held-1",
      choice: "secret",
      kind: "api_key",
      protocol: "https",
      hosts: ["a.example.com", "b.example.com"],
      port: 8443,
      portOverride: true,
      swapSites: ["header", "query"],
      plaintextConsent: null,
    });
    expect(JSON.stringify(request)).not.toContain("sk-should-not-travel");
  });

  it("sends the default port without an override", () => {
    const request = heldSecretApplyRequest("h", apiKey({}));
    expect(request.port).toBeNull();
    expect(request.portOverride).toBe(false);
  });

  it("records the disclosure version for a consented database login", () => {
    const db = {
      ...initialSecretForm("database"),
      hosts: "db.example.com",
      plaintextConsent: true,
    };
    const request = heldSecretApplyRequest("h", db);
    expect(request.swapSites).toEqual(["header"]);
    expect(request.plaintextConsent).toEqual({
      disclosureVersion: SANDBOX_PLAINTEXT_DISCLOSURE_VERSION,
    });
  });
});
