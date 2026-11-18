import { describe, expect, it } from "vitest";
import type { ProviderMcpCapabilities } from "@traycer/protocol/host/provider-native-schemas";
import { mcpBinaryAbsentNotice } from "@/components/settings/panels/provider-mcp-binary-gate";

const BOTH = ["global", "project"] as const;

/**
 * Build a base MCP capability object. Second helpers (rather than default
 * params) keep the suite inside the monorepo's no-default-params ESLint rule.
 */
function baseMcpCaps(): ProviderMcpCapabilities {
  return {
    transports: ["stdio", "http"],
    authTypes: ["none"],
    authActions: ["login", "logout"],
    actionScopes: {
      list: [...BOTH],
      add: [...BOTH],
      update: [...BOTH],
      remove: [...BOTH],
      toggleServer: [...BOTH],
      toggleTool: [...BOTH],
      discover: [...BOTH],
      auth: [...BOTH],
    },
    addServer: "cli",
    removeServer: "cli",
    updateServer: "cli",
    perToolBacking: "native",
    statusSource: "probe",
    toolsSource: "probe",
    schemasSource: "probe",
    instructionsSource: "probe",
    traycerSessionsOnlyEnforcement: false,
    stdioDegradeNotice: false,
    oauthDegradesToConfigOnly: true,
  };
}

function withEmptyScopes(
  caps: ProviderMcpCapabilities,
  verbs: ReadonlyArray<"add" | "remove" | "update" | "auth">,
): ProviderMcpCapabilities {
  const actionScopes = { ...caps.actionScopes };
  for (const verb of verbs) {
    if (verb === "add") actionScopes.add = [];
    else if (verb === "remove") actionScopes.remove = [];
    else if (verb === "update") actionScopes.update = [];
    else actionScopes.auth = [];
  }
  return {
    ...caps,
    actionScopes,
    authActions: verbs.includes("auth") ? [] : caps.authActions,
  };
}

describe("mcpBinaryAbsentNotice", () => {
  it("returns null when the host resolved a binary", () => {
    // Nothing was taken away; the notice would be a lie.
    const caps = withEmptyScopes(baseMcpCaps(), ["add", "remove", "update"]);
    expect(mcpBinaryAbsentNotice(caps, true, "Amp")).toBeNull();
  });

  it("names a single lost verb", () => {
    const addOnly = withEmptyScopes(baseMcpCaps(), ["add"]);
    expect(mcpBinaryAbsentNotice(addOnly, false, "Amp")).toContain("adding");
    expect(mcpBinaryAbsentNotice(addOnly, false, "Amp")).not.toContain(
      "removing",
    );

    const removeOnly = withEmptyScopes(baseMcpCaps(), ["remove"]);
    expect(mcpBinaryAbsentNotice(removeOnly, false, "Amp")).toContain(
      "removing",
    );

    const updateOnly = withEmptyScopes(baseMcpCaps(), ["update"]);
    expect(mcpBinaryAbsentNotice(updateOnly, false, "Amp")).toContain(
      "editing",
    );
  });

  it("joins two verbs with 'and'", () => {
    const caps = withEmptyScopes(baseMcpCaps(), ["add", "remove"]);
    const notice = mcpBinaryAbsentNotice(caps, false, "Amp");
    expect(notice).toContain("adding and removing");
    // Two-verb form has no Oxford-style comma between the verbs (the sentence
    // still has commas elsewhere - "this machine, so …").
    expect(notice).not.toContain("adding, removing");
  });

  it("joins three verbs with commas and a final 'and'", () => {
    const caps = withEmptyScopes(baseMcpCaps(), ["add", "remove", "update"]);
    const notice = mcpBinaryAbsentNotice(caps, false, "Amp");
    expect(notice).toContain("adding, removing and editing");
  });

  it("returns null for a cli-routed verb whose scope list is still populated", () => {
    // Routing alone is not proof of a strip - the scopes must also be empty.
    // Otherwise every healthy CLI-routed provider would get the notice.
    const caps = baseMcpCaps();
    expect(caps.addServer).toBe("cli");
    expect(caps.actionScopes.add.length).toBeGreaterThan(0);
    expect(mcpBinaryAbsentNotice(caps, false, "Amp")).toBeNull();
  });

  it("never names auth even when authActions is empty", () => {
    // Deliberate limit: post-gate authActions:[] is indistinguishable from a
    // contract that never had auth actions (droid, copilot). Naming auth here
    // would be a guess dressed as a fact.
    const caps = withEmptyScopes(baseMcpCaps(), ["auth"]);
    expect(caps.authActions).toEqual([]);
    expect(caps.actionScopes.auth).toEqual([]);
    expect(mcpBinaryAbsentNotice(caps, false, "Amp")).toBeNull();
  });

  it("returns null for patch-routed write verbs (cursor)", () => {
    // Cursor's add/remove are patch-routed, so an absent binary takes nothing
    // this helper can prove - even with empty scopes the routing is not "cli".
    const caps: ProviderMcpCapabilities = {
      ...withEmptyScopes(baseMcpCaps(), ["add", "remove", "update", "auth"]),
      addServer: "patch",
      removeServer: "patch",
      updateServer: "none",
    };
    expect(mcpBinaryAbsentNotice(caps, false, "Cursor")).toBeNull();
  });

  it("includes the provider label and the CLI & Args recovery path", () => {
    const caps = withEmptyScopes(baseMcpCaps(), ["add", "remove"]);
    const notice = mcpBinaryAbsentNotice(caps, false, "Amp");
    expect(notice).toContain("Amp");
    expect(notice).toContain("CLI & Args");
  });
});
