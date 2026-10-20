import { describe, expect, it } from "vitest";
import type { ProviderMcpServerTransportWrite } from "@traycer/protocol/host/provider-native-schemas";
import {
  isCredentialShapedEnvName,
  mcpTransportCredentialReason,
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

function stdio(
  overrides: Partial<
    Extract<ProviderMcpServerTransportWrite, { type: "stdio" }>
  >,
): ProviderMcpServerTransportWrite {
  return {
    type: "stdio",
    command: "npx",
    args: NO_ARGS,
    env: null,
    ...overrides,
  };
}

describe("mcpTransportCredentialReason", () => {
  describe("stdio", () => {
    it("is credential-env-name for an env entry whose NAME looks like a credential", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({ env: [{ name: "OPENAI_API_KEY", value: "sk-x" }] }),
        ),
      ).toBe("credential-env-name");
    });

    it("is credential-env-name whatever the value, an empty one included", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({ env: [{ name: "GITHUB_TOKEN", value: "" }] }),
        ),
      ).toBe("credential-env-name");
    });

    it("is null for a plain env such as NODE_ENV=production", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({ env: [{ name: "NODE_ENV", value: "production" }] }),
        ),
      ).toBeNull();
    });

    it("is url-sign-in for an env VALUE that is a URL with a sign-in under an ordinary name", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({ env: [{ name: "DB_URL", value: "postgres://u:p@db/app" }] }),
        ),
      ).toBe("url-sign-in");
    });

    it("is url-sign-in for an argument that is a URL with a sign-in", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({ args: ["mcp-remote", "https://alice:token@host/mcp"] }),
        ),
      ).toBe("url-sign-in");
    });

    it("is url-sign-in for a command that is a URL with a sign-in", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({ command: "https://alice:token@host/run" }),
        ),
      ).toBe("url-sign-in");
    });

    it("names the env NAME first when both a credential-shaped name and a sign-in URL are present", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({
            args: ["https://alice:token@host/mcp"],
            env: [{ name: "GITHUB_TOKEN", value: "x" }],
          }),
        ),
      ).toBe("credential-env-name");
    });

    it("is null for a plain stdio server, including URL arguments without a sign-in", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({ args: ["mcp-remote", "https://host/mcp", "--flag"] }),
        ),
      ).toBeNull();
    });

    it("is null for an ssh URL argument that names only an account", () => {
      expect(
        mcpTransportCredentialReason(
          stdio({ args: ["clone", "ssh://git@host/repo"] }),
        ),
      ).toBeNull();
    });
  });

  describe.each(["http", "sse"] as const)("%s", (type) => {
    it("is secret-auth for header auth, whatever the values", () => {
      expect(
        mcpTransportCredentialReason({
          type,
          url: "https://host/mcp",
          auth: { type: "header", name: "Authorization", value: "Bearer x" },
        }),
      ).toBe("secret-auth");
      expect(
        mcpTransportCredentialReason({
          type,
          url: "https://host/mcp",
          auth: { type: "header", name: "x-trace", value: "" },
        }),
      ).toBe("secret-auth");
    });

    it("is secret-auth for env auth with an empty value (just the variable name)", () => {
      expect(
        mcpTransportCredentialReason({
          type,
          url: "https://host/mcp",
          auth: { type: "env", name: "GITHUB_TOKEN", value: "" },
        }),
      ).toBe("secret-auth");
    });

    it("is secret-auth for env auth that carries a value", () => {
      expect(
        mcpTransportCredentialReason({
          type,
          url: "https://host/mcp",
          auth: { type: "env", name: "GITHUB_TOKEN", value: "ghp_secret" },
        }),
      ).toBe("secret-auth");
    });

    it("is null for oauth with a plain resource, a null one, or none", () => {
      for (const oauthResource of ["https://host/resource", null, undefined]) {
        expect(
          mcpTransportCredentialReason({
            type,
            url: "https://host/mcp",
            auth: { type: "oauth", oauthClientId: "client-1", oauthResource },
          }),
        ).toBeNull();
      }
    });

    it("is url-sign-in for oauth whose resource is a URL with a sign-in", () => {
      expect(
        mcpTransportCredentialReason({
          type,
          url: "https://host/mcp",
          auth: {
            type: "oauth",
            oauthClientId: null,
            oauthResource: "https://alice:token@host/resource",
          },
        }),
      ).toBe("url-sign-in");
    });

    it("is null for a plain URL with no auth", () => {
      expect(
        mcpTransportCredentialReason({
          type,
          url: "https://host/mcp",
          auth: null,
        }),
      ).toBeNull();
    });

    it("is url-sign-in for a URL with a sign-in and no auth", () => {
      expect(
        mcpTransportCredentialReason({
          type,
          url: "https://alice:token@host/mcp",
          auth: null,
        }),
      ).toBe("url-sign-in");
    });

    it("names the auth first when the URL carries a sign-in too", () => {
      expect(
        mcpTransportCredentialReason({
          type,
          url: "https://alice:token@host/mcp",
          auth: { type: "header", name: "Authorization", value: "Bearer x" },
        }),
      ).toBe("secret-auth");
    });
  });
});

describe("isCredentialShapedEnvName", () => {
  it.each([
    "OPENAI_API_KEY",
    "DATABASE_PASSWORD",
    "GITHUB_TOKEN",
    "AUTH_URL",
    "my_secret",
    "SSL_CERT_FILE",
    "SESSION_ID",
  ])("is true for %s", (name) => {
    expect(isCredentialShapedEnvName(name)).toBe(true);
  });

  it.each(["EDITOR", "PATH", "NODE_OPTIONS", "NODE_ENV", "HOME"])(
    "is false for %s",
    (name) => {
      expect(isCredentialShapedEnvName(name)).toBe(false);
    },
  );
});
