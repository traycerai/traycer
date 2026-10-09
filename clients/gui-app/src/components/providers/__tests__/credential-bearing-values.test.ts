import { describe, expect, it } from "vitest";
import type { ProviderMcpServerTransportWrite } from "@traycer/protocol/host/provider-native-schemas";
import {
  mcpTransportCarriesSecret,
  urlCarriesCredentials,
} from "../credential-bearing-values";

describe("urlCarriesCredentials", () => {
  it.each([
    ["a user and a password", "https://alice:token@host/mcp"],
    ["a user name alone on https", "https://ghp_x@github.com/o/r"],
    ["a user name alone on http", "http://token@host/mcp"],
    ["a user name alone on git+https", "git+https://ghp_x@github.com/o/r"],
    ["a password alone on a scheme that is not http", "ssh://:pw@host/repo"],
    ["a user and a password on ssh", "ssh://git:pw@host/repo"],
    ["a password alone", "https://:pw@h"],
    ["a non-http scheme", "postgres://u:p@db/app"],
    ["surrounding whitespace", "  https://alice:token@host/mcp \n"],
  ])("is true for %s", (_name, value) => {
    expect(urlCarriesCredentials(value)).toBe(true);
  });

  it.each([
    ["a plain https URL", "https://host/mcp"],
    [
      "a user name alone on ssh (an account, not a secret)",
      "ssh://git@host/repo",
    ],
    ["a user name alone on postgres", "postgres://app@db"],
    ["a user name alone on a custom scheme", "git+ssh://git@host/repo"],
    ["a URL with a port, a query and a fragment", "https://host:8443/a?b=c#d"],
    ["an at sign past the host", "https://host/mcp?contact=a@b.example"],
    ["text that is not a URL", "alice:token@host"],
    ["a bare word", "npx"],
    ["a flag", "--token=abc"],
    ["the empty string", ""],
    ["whitespace only", "   "],
  ])("is false for %s", (_name, value) => {
    expect(urlCarriesCredentials(value)).toBe(false);
  });
});

const NO_ARGS: string[] = [];

describe("mcpTransportCarriesSecret", () => {
  it.each(["http", "sse"] as const)(
    "is true for a %s server whose URL has a sign-in and whose auth is null",
    (type) => {
      expect(
        mcpTransportCarriesSecret({
          type,
          url: "https://alice:token@host/mcp",
          auth: null,
        }),
      ).toBe(true);
    },
  );

  it("is true for a remote server with header auth on a plain URL", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "http",
        url: "https://host/mcp",
        auth: { type: "header", name: "Authorization", value: "Bearer x" },
      }),
    ).toBe(true);
  });

  it("is false for an oauth server on a plain URL", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "http",
        url: "https://host/mcp",
        auth: { type: "oauth", oauthClientId: "client-1" },
      }),
    ).toBe(false);
  });

  it("is true for an oauth server whose resource is a URL with a sign-in", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "http",
        url: "https://host/mcp",
        auth: {
          type: "oauth",
          oauthClientId: null,
          oauthResource: "https://alice:token@host/resource",
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["a plain URL", "https://host/resource"],
    ["null", null],
    ["undefined", undefined],
  ])("is false for an oauth server whose resource is %s", (_name, resource) => {
    expect(
      mcpTransportCarriesSecret({
        type: "http",
        url: "https://host/mcp",
        auth: { type: "oauth", oauthClientId: null, oauthResource: resource },
      }),
    ).toBe(false);
  });

  it("is false for an env-auth server whose value is empty (the name is not a secret)", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "http",
        url: "https://host/mcp",
        auth: { type: "env", name: "GITHUB_TOKEN", value: "" },
      }),
    ).toBe(false);
  });

  it("is true for an env-auth server that carries a value (the token itself)", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "http",
        url: "https://host/mcp",
        auth: { type: "env", name: "GITHUB_TOKEN", value: "ghp_secret" },
      }),
    ).toBe(true);
  });

  it("is false for a stdio server that passes an ssh URL naming only an account", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "stdio",
        command: "npx",
        args: ["clone", "ssh://git@host/repo"],
        env: null,
      }),
    ).toBe(false);
  });

  it("is false for a remote server with no auth on a plain URL", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "sse",
        url: "https://host/mcp",
        auth: null,
      }),
    ).toBe(false);
  });

  it("is true for a stdio server with env values", () => {
    const transport: ProviderMcpServerTransportWrite = {
      type: "stdio",
      command: "npx",
      args: NO_ARGS,
      env: [{ name: "GITHUB_TOKEN", value: "ghp_secret" }],
    };
    expect(mcpTransportCarriesSecret(transport)).toBe(true);
  });

  it("is true for a stdio server with a sign-in URL as an argument", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "stdio",
        command: "npx",
        args: ["mcp-remote", "https://alice:token@host/mcp"],
        env: null,
      }),
    ).toBe(true);
  });

  it("is true for a stdio server whose command is a sign-in URL", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "stdio",
        command: "https://alice:token@host/run",
        args: NO_ARGS,
        env: null,
      }),
    ).toBe(true);
  });

  it("is false for a plain stdio server, including URL arguments without a sign-in", () => {
    expect(
      mcpTransportCarriesSecret({
        type: "stdio",
        command: "npx",
        args: ["mcp-remote", "https://host/mcp", "--flag"],
        env: null,
      }),
    ).toBe(false);
  });
});
