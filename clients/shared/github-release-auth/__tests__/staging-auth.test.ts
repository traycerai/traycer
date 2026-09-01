import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithGitHubReleaseAuth,
  GitHubReleaseCredentialResolver,
  sanitizeCredentialTextWithSecrets,
  stripGitHubReleaseCredentialsFromEnv,
  type GitHubReleaseAuthPolicy,
} from "..";
import {
  createStagingGitHubReleaseAuthPolicy,
  isAuthorizedGitHubReleaseUrl,
} from "../policy";
import { STAGING_RELEASE_TOKEN_ENV } from "../types";

const repo = "traycerai/traycer-internal";
const apiUrl = `https://api.github.com/repos/${repo}`;
const roots: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const oldToken = process.env[STAGING_RELEASE_TOKEN_ENV];
const oldPath = process.env.PATH;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

function policy(): GitHubReleaseAuthPolicy {
  const result = createStagingGitHubReleaseAuthPolicy(repo);
  if (result === null) throw new Error("invalid test repository");
  return result;
}

function ghFixture(token: string): string {
  const root = mkdtempSync(join(tmpdir(), "traycer-gh-test-"));
  roots.push(root);
  const executable = join(root, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${token}'\n`, "utf8");
  chmodSync(executable, 0o755);
  process.env.PATH = root;
  return executable;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (oldToken === undefined) {
    Reflect.deleteProperty(process.env, STAGING_RELEASE_TOKEN_ENV);
  } else {
    process.env[STAGING_RELEASE_TOKEN_ENV] = oldToken;
  }
  if (oldPath === undefined) {
    Reflect.deleteProperty(process.env, "PATH");
  } else {
    process.env.PATH = oldPath;
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("staging GitHub release credentials", () => {
  it("prefers the environment token to gh auth token", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "env-token";
    ghFixture("gh-token");
    const resolver = new GitHubReleaseCredentialResolver();
    await expect(resolver.resolveOrThrow()).resolves.toMatchObject({
      source: "environment",
      token: "env-token",
    });
  });

  it("uses gh auth token when the environment token is absent", async () => {
    Reflect.deleteProperty(process.env, STAGING_RELEASE_TOKEN_ENV);
    setPlatform("win32");
    ghFixture("gh-token");
    const resolver = new GitHubReleaseCredentialResolver();
    await expect(resolver.resolveOrThrow()).resolves.toMatchObject({
      source: "github-cli",
      token: "gh-token",
    });
  });

  it("throws AuthenticationRequiredError when neither source is available", async () => {
    Reflect.deleteProperty(process.env, STAGING_RELEASE_TOKEN_ENV);
    setPlatform("win32");
    process.env.PATH = "/path/that/does/not/exist";
    const resolver = new GitHubReleaseCredentialResolver();
    await expect(resolver.resolveOrThrow()).rejects.toMatchObject({
      name: "AuthenticationRequiredError",
    });
  });

  it("reuses a lease until discardLease, then resolves the new token", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "first-token";
    const resolver = new GitHubReleaseCredentialResolver();
    await expect(resolver.resolveOrThrow()).resolves.toMatchObject({
      token: "first-token",
    });
    process.env[STAGING_RELEASE_TOKEN_ENV] = "second-token";
    await expect(resolver.resolveOrThrow()).resolves.toMatchObject({
      token: "first-token",
    });
    resolver.discardLease();
    await expect(resolver.resolveOrThrow()).resolves.toMatchObject({
      token: "second-token",
    });
  });

  it("removes only the staging token without mutating the input", () => {
    const input = { PATH: "/bin", [STAGING_RELEASE_TOKEN_ENV]: "secret" };
    const output = stripGitHubReleaseCredentialsFromEnv(input);
    expect(output).toEqual({ PATH: "/bin" });
    expect(input[STAGING_RELEASE_TOKEN_ENV]).toBe("secret");
  });

  it("authorizes only the exact GitHub release origins and repository path", () => {
    const authPolicy = policy();
    expect(
      isAuthorizedGitHubReleaseUrl(
        new URL(`${apiUrl}/releases/assets/1`),
        authPolicy,
      ),
    ).toBe(true);
    expect(
      isAuthorizedGitHubReleaseUrl(
        new URL(`https://github.com/${repo}/releases/download/v1/a`),
        authPolicy,
      ),
    ).toBe(true);
    expect(
      isAuthorizedGitHubReleaseUrl(
        new URL(
          `https://api.github.com/repos/TRAYCERAI/TRAYCER-INTERNAL/releases/assets/1`,
        ),
        authPolicy,
      ),
    ).toBe(true);
    expect(
      isAuthorizedGitHubReleaseUrl(
        new URL("https://api.github.com/repos/other/repo/releases/assets/1"),
        authPolicy,
      ),
    ).toBe(false);
    expect(
      isAuthorizedGitHubReleaseUrl(
        new URL("https://objects.githubusercontent.com/release-asset"),
        authPolicy,
      ),
    ).toBe(false);
  });

  it("redacts GitHub tokens, authorization headers, and supplied secrets", () => {
    const result = sanitizeCredentialTextWithSecrets(
      "ghp_abc123 github_pat_xyz456 Authorization: token raw-token custom-secret",
      ["custom-secret", "raw-token"],
    );
    expect(result).not.toContain("ghp_abc123");
    expect(result).not.toContain("github_pat_xyz456");
    expect(result).not.toContain("raw-token");
    expect(result).not.toContain("custom-secret");
    expect(result).toContain("Authorization: [redacted]");
  });

  it("adds auth only to authorized URLs and drops it on a cross-origin redirect", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "env-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const calls: Array<{
      url: string;
      authorization: string | null;
      method: string;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit | undefined) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          method: init?.method ?? "GET",
        });
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://objects.githubusercontent.com/a" },
          });
        }
        return new Response("ok", { status: 200 });
      }),
    );
    await expect(
      fetchWithGitHubReleaseAuth(resolver, policy(), apiUrl, {}),
    ).resolves.toHaveProperty("status", 200);
    expect(calls).toEqual([
      { url: apiUrl, authorization: "token env-token", method: "GET" },
      {
        url: "https://objects.githubusercontent.com/a",
        authorization: null,
        method: "GET",
      },
    ]);
  });

  it("follows a 302 with GET and discards the lease on 401/403", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "first-token";
    const resolver = new GitHubReleaseCredentialResolver();
    const statuses = [302, 200];
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL, init: RequestInit | undefined) => {
          methods.push(init?.method ?? "GET");
          return new Response(null, {
            status: statuses.shift() ?? 500,
            headers: { location: apiUrl },
          });
        },
      ),
    );
    await expect(
      fetchWithGitHubReleaseAuth(resolver, policy(), apiUrl, {
        method: "POST",
      }),
    ).resolves.toHaveProperty("status", 200);
    expect(methods).toEqual(["POST", "GET"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(
      fetchWithGitHubReleaseAuth(resolver, policy(), apiUrl, {}),
    ).rejects.toMatchObject({ name: "AuthenticationRequiredError" });
    process.env[STAGING_RELEASE_TOKEN_ENV] = "new-token";
    const headers: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL, init: RequestInit | undefined) => {
          headers.push(new Headers(init?.headers));
          return new Response(null, { status: 200 });
        },
      ),
    );
    await fetchWithGitHubReleaseAuth(resolver, policy(), apiUrl, {});
    expect(headers[0]?.get("authorization")).toBe("token new-token");
  });

  it("errors after the redirect limit", async () => {
    process.env[STAGING_RELEASE_TOKEN_ENV] = "env-token";
    const resolver = new GitHubReleaseCredentialResolver();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: apiUrl } }),
      ),
    );
    await expect(
      fetchWithGitHubReleaseAuth(resolver, policy(), apiUrl, {}),
    ).rejects.toThrow(/redirect limit/);
  });
});
