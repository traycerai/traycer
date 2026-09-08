import { describe, expect, it } from "vitest";
import {
  extractConfirmationCode,
  isTraycerEndpointModelProvider,
  sourceBadgeHint,
  sourceBadgeLabel,
} from "@/components/settings/panels/model-provider-connect-model";
import { TRAYCER_ENDPOINT_MODEL_PROVIDER_ID } from "@traycer/protocol/host/provider-native-schemas";

/**
 * Upstream lifts the code with `instructions.split(":").pop().trim()`. We
 * deliberately do not copy that rule unguarded - see the URL case below, which
 * is the one that made it worth diverging.
 */
describe("extractConfirmationCode", () => {
  it("lifts a code that follows a colon", () => {
    expect(
      extractConfirmationCode("Enter this code in your browser: ABCD-1234"),
    ).toBe("ABCD-1234");
  });

  it("takes a bare code as-is", () => {
    expect(extractConfirmationCode("WXYZ-7890")).toBe("WXYZ-7890");
  });

  it("DEGRADES rather than reporting a URL tail as a code", () => {
    // The whole reason for diverging from upstream: splitting on `:` here
    // yields "//example.test/device and enter ABCD-1234", which their rule
    // would present in a monospace field as though it were the code.
    expect(
      extractConfirmationCode(
        "Visit https://example.test/device and enter ABCD-1234",
      ),
    ).toBeNull();
  });

  it("degrades when the tail is a sentence rather than a code", () => {
    expect(
      extractConfirmationCode("Do this: open the page and approve the request"),
    ).toBeNull();
  });

  it("degrades on a tail that is too short to be a code", () => {
    expect(extractConfirmationCode("Code: ab")).toBeNull();
  });

  it("answers null for absent or empty instructions", () => {
    expect(extractConfirmationCode(null)).toBeNull();
    expect(extractConfirmationCode("   ")).toBeNull();
  });
});

describe("source badges", () => {
  it("speaks the upstream app's vocabulary", () => {
    // Same row, same word, in both apps, so a user who knows one reads the
    // other. "Saved in OpenCode" is true and useful in a sentence, but not in
    // the one slot that has to stay scannable across ~180 rows.
    expect(sourceBadgeLabel("anthropic", "api", false)).toBe("API key");
    expect(sourceBadgeLabel("openai", "env", false)).toBe("Environment");
    expect(sourceBadgeLabel("my-loader", "custom", false)).toBe("Custom");
  });

  it("splits one source into two badges on the host's flag", () => {
    // `config` covers a provider the user DECLARED as a custom endpoint and one
    // a config file merely supplies a key for. The difference is not
    // recoverable from `source`, so the host sends the predicate's answer.
    expect(sourceBadgeLabel("my-endpoint", "config", false)).toBe("Config");
    expect(sourceBadgeLabel("my-endpoint", "config", true)).toBe("Custom");
  });

  it("puts the provenance the badge dropped into the hint", () => {
    expect(sourceBadgeHint("anthropic", "api", "OpenCode", false)).toContain(
      "OpenCode's own credential store",
    );
    // A declared custom row is the user's own work, not something managed away
    // from them - so it does not get the "managed outside Traycer" line.
    expect(
      sourceBadgeHint("my-endpoint", "config", "OpenCode", true),
    ).toContain("with its own base URL and models");
    expect(
      sourceBadgeHint("my-endpoint", "config", "OpenCode", false),
    ).toContain("managed outside Traycer");
  });

  // D08/W3-T5: the `traycer-endpoint` row is `config` + `configDeclaredCustom`
  // on the wire, same as a user-declared custom provider - Traycer wrote the
  // block, not the user, and the disclosure must say so rather than reading
  // as the user's own work.
  it("names Traycer as the owner of its own projected endpoint block, by id, whatever the source says", () => {
    expect(sourceBadgeLabel("traycer-endpoint", "config", true)).toBe(
      "Traycer",
    );
    expect(
      sourceBadgeHint("traycer-endpoint", "config", "OpenCode", true),
    ).toContain("Traycer manages this connection");
    expect(
      sourceBadgeHint("traycer-endpoint", "config", "OpenCode", true),
    ).not.toContain("You declared this provider");
  });

  // D26: the default account is never "a profile". D08 gives it an endpoint
  // section of its own, so this exact row renders under it too - the hint has
  // to be true for both selections, which is what "this account's" buys.
  it("does not call the default account a profile, and points at where the block is edited", () => {
    const hint = sourceBadgeHint(
      "traycer-endpoint",
      "config",
      "OpenCode",
      true,
    );
    expect(hint).not.toContain("profile");
    expect(hint).toContain("this account's OpenCode configuration");
    expect(hint).toContain("Account tab");
  });

  // The id is the protocol's, not a literal re-spelled on this side of the
  // repo boundary: a rename there must move this predicate with it.
  it("recognizes the projected endpoint row by the protocol's own id", () => {
    expect(
      isTraycerEndpointModelProvider(TRAYCER_ENDPOINT_MODEL_PROVIDER_ID),
    ).toBe(true);
    expect(isTraycerEndpointModelProvider("anthropic")).toBe(false);
  });
});
