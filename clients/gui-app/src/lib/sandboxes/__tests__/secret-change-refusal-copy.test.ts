import { describe, expect, it } from "vitest";
import { SECRET_UNDO_REFUSAL_CODES } from "@traycer/protocol/host/environment-schemas";
import {
  secretChangeRefusalLine,
  type SecretChangeOperation,
} from "@/lib/sandboxes/secret-change-refusal-copy";

const OPERATIONS: readonly SecretChangeOperation[] = [
  "create",
  "undo",
  "destroy",
];

describe("secretChangeRefusalLine", () => {
  it("returns the exact line for each undo refusal code", () => {
    expect(secretChangeRefusalLine("undo", "version_destroyed")).toBe(
      "That value was destroyed, so it cannot be restored.",
    );
    expect(secretChangeRefusalLine("undo", "secret_revoked")).toBe(
      "This secret is revoked. Restore it to undo; it gets the grants a new secret gets.",
    );
    expect(secretChangeRefusalLine("undo", "version_current")).toBe(
      "That value is already the current one.",
    );
    expect(secretChangeRefusalLine("undo", "secret_version_stale")).toBe(
      "Changed somewhere else just now. Look again before you undo.",
    );
  });

  it.each(SECRET_UNDO_REFUSAL_CODES)(
    "has a non-empty undo line for the protocol code %s",
    (code) => {
      const line = secretChangeRefusalLine("undo", code);
      expect(line).not.toBeNull();
      expect(line?.trim().length).toBeGreaterThan(0);
    },
  );

  it("returns the exact line for the destroy and create rows", () => {
    expect(secretChangeRefusalLine("destroy", "version_current")).toBe(
      "This is the current value. Replace or revoke it first.",
    );
    expect(secretChangeRefusalLine("create", "team_secrets_are_brokered")).toBe(
      "Team secrets are brokered only; a tool that needs a plain value needs a personal sandbox.",
    );
  });

  it("a create refused for an unknown provider name says to choose the provider", () => {
    expect(secretChangeRefusalLine("create", "provider_name_unknown")).toBe(
      "Choose the provider; a model provider key takes its provider's variable name.",
    );
  });

  it("words version_current differently for undo and destroy", () => {
    const undo = secretChangeRefusalLine("undo", "version_current");
    const destroy = secretChangeRefusalLine("destroy", "version_current");
    expect(undo).not.toBeNull();
    expect(destroy).not.toBeNull();
    expect(undo).not.toBe(destroy);
  });

  it("keeps each code on its own operation", () => {
    expect(secretChangeRefusalLine("create", "version_current")).toBeNull();
    expect(secretChangeRefusalLine("destroy", "version_destroyed")).toBeNull();
    expect(secretChangeRefusalLine("destroy", "secret_revoked")).toBeNull();
    expect(
      secretChangeRefusalLine("destroy", "secret_version_stale"),
    ).toBeNull();
    expect(
      secretChangeRefusalLine("undo", "team_secrets_are_brokered"),
    ).toBeNull();
    expect(
      secretChangeRefusalLine("destroy", "team_secrets_are_brokered"),
    ).toBeNull();
    expect(secretChangeRefusalLine("create", "version_destroyed")).toBeNull();
  });

  it("returns null for secret_name_taken and unknown codes on every operation", () => {
    for (const operation of OPERATIONS) {
      for (const code of [
        "secret_name_taken",
        "something_new",
        "",
        "VERSION_CURRENT",
      ]) {
        expect(
          secretChangeRefusalLine(operation, code),
          `${operation}: ${JSON.stringify(code)}`,
        ).toBeNull();
      }
    }
  });

  it("returns null for prototype keys on every operation", () => {
    for (const operation of OPERATIONS) {
      for (const code of [
        "toString",
        "constructor",
        "hasOwnProperty",
        "valueOf",
        "__proto__",
      ]) {
        expect(
          secretChangeRefusalLine(operation, code),
          `${operation}: ${code}`,
        ).toBeNull();
      }
    }
  });
});
