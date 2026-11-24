import { describe, expect, it } from "vitest";
import {
  heldFactsOf,
  maskedHeldText,
} from "@traycer/protocol/host/environment/held-facts";

describe("heldFactsOf", () => {
  const NO_FACTS = {
    command: null,
    description: null,
    harness: null,
    value: null,
  };

  function factsOf(kind: string, key: string, value: unknown) {
    return heldFactsOf({ kind, key, value });
  }

  function stdio(args: string[]) {
    return factsOf("mcp_server", "memory", {
      definition: { transport: "stdio", command: "npx", args },
      toolToggles: {},
    });
  }

  it("names a held stdio server's command line", () => {
    expect(stdio(["-y", "@mcp/memory"])).toEqual({
      ...NO_FACTS,
      command: "npx -y @mcp/memory",
    });
  });

  it("keeps an HTTP definition out of the shared line facts", () => {
    expect(
      factsOf("mcp_server", "docs-server", {
        definition: {
          transport: "http",
          url: "https://docs.example.test/v1/mcp",
        },
        toolToggles: {},
      }),
    ).toEqual(NO_FACTS);
  });

  it("masks a credential-like URL path segment and preserves an ordinary MCP path", () => {
    const pathToken = ["a8Zt4Qk2", "Vj6Rf0Xn3", "Db9Hp5Ms7"].join("");
    expect(maskedHeldText(`https://docs.example.test/s/${pathToken}/mcp`)).toBe(
      "https://docs.example.test/s/•••/mcp",
    );
    expect(maskedHeldText("https://docs.example.test/v1/mcp")).toBe(
      "https://docs.example.test/v1/mcp",
    );
  });

  it("preserves a Nix store executable path and an ordinary absolute shell path", () => {
    const storeHash = ["a8Zt4Qk2", "Vj6Rf0Xn3", "Db9Hp5Ms7"].join("");
    const nixPath = `/nix/store/${storeHash}-zsh-5.9/bin/zsh`;
    expect(
      factsOf("shell", "zsh", { path: nixPath, args: ["-l"] }).command,
    ).toBe(`${nixPath} -l`);
    expect(
      factsOf("shell", "zsh", {
        path: "/usr/local/bin/zsh",
        args: ["-l"],
      }).command,
    ).toBe("/usr/local/bin/zsh -l");
  });

  it("names a shell's path and arguments", () => {
    expect(factsOf("shell", "zsh", { path: "/bin/zsh", args: ["-l"] })).toEqual(
      { ...NO_FACTS, command: "/bin/zsh -l" },
    );
  });

  it("joins a setup script's non-empty trimmed lines", () => {
    expect(
      factsOf("setup_script", "setup", {
        text: "  brew install jq\n\n  npm ci  \n",
      }),
    ).toEqual({ ...NO_FACTS, command: "brew install jq; npm ci" });
  });

  it("shows an env override's value and harness, and a variable's value alone", () => {
    expect(
      factsOf("env_override", "claude:NODE_OPTIONS", {
        value: "--max-old-space-size=8192",
      }),
    ).toEqual({
      ...NO_FACTS,
      harness: "claude",
      value: "--max-old-space-size=8192",
    });
    expect(factsOf("variable", "EDITOR", { value: "vim" })).toEqual({
      ...NO_FACTS,
      value: "vim",
    });
  });

  it.each([
    [["--api-key", "abc123"], "npx --api-key •••"],
    [["--token=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"], "npx --token=•••"],
    [["https://u:p4ss@db.example.com/x"], "npx •••"],
  ])("masks a credential in a stdio server's arguments %j", (args, command) => {
    expect(stdio(args).command).toBe(command);
  });

  it("masks a key-shaped piece in a shell and in a setup script", () => {
    expect(
      factsOf("shell", "sh", { path: "/bin/sh", args: ["--api-key", "abc123"] })
        .command,
    ).toBe("/bin/sh --api-key •••");
    expect(
      factsOf("setup_script", "setup", {
        text: "export API_KEY=abc123\nnpm ci",
      }).command,
    ).toBe("export API_KEY=•••; npm ci");
  });
});
