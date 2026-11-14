import { describe, expect, it } from "vitest";
import { heldFactsOf } from "@traycer/protocol/host/environment/held-facts";

describe("heldFactsOf", () => {
  const NO_FACTS = {
    command: null,
    event: null,
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
