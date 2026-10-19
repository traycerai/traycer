import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyCredential } from "@traycer/protocol/environment/credential-rule";

interface Case {
  readonly label: string;
  readonly name: string;
  readonly value: string;
}

/** A name that is not a credential name, so only the value is judged. */
const NEUTRAL = "CONFIG";

function neutral(label: string, value: string): Case {
  return { label, name: NEUTRAL, value };
}

describe("classifyCredential: the field decides, whatever the value", () => {
  const fieldTrue: readonly Case[] = [
    {
      label: "OPENAI_API_KEY with a one-char value",
      name: "OPENAI_API_KEY",
      value: "x",
    },
    {
      label: "GITHUB_TOKEN with a short value",
      name: "GITHUB_TOKEN",
      value: "abc",
    },
    {
      label: "DB_PASSWORD with a weak value",
      name: "DB_PASSWORD",
      value: "hunter2",
    },
    { label: "hyphenated api-key", name: "api-key", value: "x" },
    {
      label: "hyphenated X-API-KEY (case folded)",
      name: "X-API-KEY",
      value: "x",
    },
    {
      label: "Authorization header with a Basic value",
      name: "Authorization",
      value: "Basic x",
    },
    { label: "X_AUTH_TOKEN", name: "X_AUTH_TOKEN", value: "x" },
    { label: "SESSION_COOKIE", name: "SESSION_COOKIE", value: "a=b" },
    {
      label: "AWS_SECRET_ACCESS_KEY",
      name: "AWS_SECRET_ACCESS_KEY",
      value: "x",
    },
    { label: "SSH_PRIVATE_KEY", name: "SSH_PRIVATE_KEY", value: "x" },
    { label: "MY_PASSWD", name: "MY_PASSWD", value: "x" },
    { label: "client_secret", name: "client_secret", value: "x" },
    {
      label: "lowercase name openai_api_key",
      name: "openai_api_key",
      value: "x",
    },
    {
      label: "AWS_ACCESS_KEY_ID (access_key stem)",
      name: "AWS_ACCESS_KEY_ID",
      value: "x",
    },
    { label: "SIGNING_KEY", name: "SIGNING_KEY", value: "x" },
    { label: "hyphenated encryption-key", name: "encryption-key", value: "x" },
    { label: "BEARER_VALUE", name: "BEARER_VALUE", value: "x" },
    { label: "GCP_CREDENTIALS", name: "GCP_CREDENTIALS", value: "x" },
    {
      label: "name padded with whitespace",
      name: "  GITHUB_TOKEN  ",
      value: "abc",
    },
  ];

  it.each(fieldTrue)("$label is credential-like", ({ name, value }) => {
    expect(classifyCredential({ name, value })).toEqual({
      credentialLike: true,
    });
  });

  const emptyValue: readonly Case[] = [
    {
      label: "OPENAI_API_KEY with an empty value",
      name: "OPENAI_API_KEY",
      value: "",
    },
    {
      label: "OPENAI_API_KEY with spaces only",
      name: "OPENAI_API_KEY",
      value: "   ",
    },
    {
      label: "OPENAI_API_KEY with tabs and newlines only",
      name: "OPENAI_API_KEY",
      value: "\t\n \r\n",
    },
    { label: "neutral name with an empty value", name: NEUTRAL, value: "" },
  ];

  it.each(emptyValue)("$label is not credential-like", ({ name, value }) => {
    expect(classifyCredential({ name, value })).toEqual({
      credentialLike: false,
    });
  });

  const usageCounts: readonly Case[] = [
    { label: "MAX_TOKENS", name: "MAX_TOKENS", value: "4096" },
    { label: "input_tokens", name: "input_tokens", value: "12" },
    {
      label: "CACHE_READ_INPUT_TOKENS",
      name: "CACHE_READ_INPUT_TOKENS",
      value: "0",
    },
    { label: "hyphenated output-tokens", name: "output-tokens", value: "7" },
  ];

  it.each(usageCounts)(
    "usage count $label is not a credential name",
    ({ name, value }) => {
      expect(classifyCredential({ name, value })).toEqual({
        credentialLike: false,
      });
    },
  );
});

describe("classifyCredential: a neutral name is judged by its value", () => {
  const tokenPrefixes: readonly Case[] = [
    neutral("sk-ant- key", "sk-ant-api03-" + "A".repeat(24)),
    neutral("sk- key", "sk-" + "A".repeat(24)),
    neutral("ghp_ token", "ghp_" + "A".repeat(30)),
    neutral("gho_ token", "gho_" + "A".repeat(30)),
    neutral("ghs_ token", "ghs_" + "A".repeat(30)),
    neutral("ghu_ token", "ghu_" + "A".repeat(30)),
    neutral("ghr_ token", "ghr_" + "A".repeat(30)),
    neutral("github_pat_ token", "github_pat_" + "A".repeat(30)),
    neutral("xoxb- Slack token", "xoxb-" + "1".repeat(12)),
    neutral("xoxa- Slack token", "xoxa-" + "1".repeat(12)),
    neutral("xoxp- Slack token", "xoxp-" + "1".repeat(12)),
    neutral("xoxr- Slack token", "xoxr-" + "1".repeat(12)),
    neutral("xoxs- Slack token", "xoxs-" + "1".repeat(12)),
    neutral("AKIA access key id", "AKIA" + "X".repeat(16)),
    neutral("AIza Google key", "AIza" + "A".repeat(35)),
    neutral("sk_live_ Stripe key", "sk_live_" + "A".repeat(24)),
    neutral("rk_live_ Stripe key", "rk_live_" + "A".repeat(24)),
    neutral("npm_ token", "npm_" + "A".repeat(24)),
    neutral(
      "JWT-shaped three-segment value",
      "eyJ" + "A".repeat(10) + "." + "B".repeat(10) + "." + "C".repeat(10),
    ),
    neutral("token embedded after Bearer", "Bearer ghp_" + "A".repeat(30)),
    neutral(
      "token embedded in a sentence",
      "use sk-ant-" + "A".repeat(24) + " for the build",
    ),
    neutral(
      "token embedded in a KEY=value list",
      "a=1;b=ghp_" + "A".repeat(30) + ";c=2",
    ),
  ];

  it.each(tokenPrefixes)("$label is credential-like", ({ name, value }) => {
    expect(classifyCredential({ name, value })).toEqual({
      credentialLike: true,
    });
  });

  const urlsWithPassword: readonly Case[] = [
    neutral("postgres URL with a password", "postgres://user:p4ss@db:5432/app"),
    neutral("https URL with a password", "https://user:pw@example.com/x"),
    neutral(
      "mixed-case scheme with a password",
      "Redis://default:pw@cache:6379",
    ),
  ];

  it.each(urlsWithPassword)("$label is credential-like", ({ name, value }) => {
    expect(classifyCredential({ name, value })).toEqual({
      credentialLike: true,
    });
  });

  const highEntropy: readonly Case[] = [
    neutral(
      "random-looking 32-char mixed alnum string",
      "aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xY",
    ),
    neutral(
      "random-looking 24-char string at the length floor",
      "aB3dE5fG7hJ9kL2mN4pQ6rS8",
    ),
    neutral(
      "base64-style run with + / =",
      "aB3dE5fG7hJ9kL2mN4pQ6r+/S8tU1vW0==",
    ),
  ];

  it.each(highEntropy)("$label is credential-like", ({ name, value }) => {
    expect(classifyCredential({ name, value })).toEqual({
      credentialLike: true,
    });
  });

  const surroundingWhitespace: readonly Case[] = [
    neutral(
      "token with leading and trailing spaces",
      "  ghp_" + "A".repeat(30) + "  ",
    ),
    neutral("token with a trailing newline", "ghp_" + "A".repeat(30) + "\n"),
    neutral(
      "high-entropy run with surrounding whitespace",
      "\t aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xY \n",
    ),
    neutral(
      "password URL with trailing newline",
      "https://user:pw@example.com/x\n",
    ),
  ];

  it.each(surroundingWhitespace)(
    "$label is still credential-like (trimmed)",
    ({ name, value }) => {
      expect(classifyCredential({ name, value })).toEqual({
        credentialLike: true,
      });
    },
  );

  const notCredentials: readonly Case[] = [
    neutral("UUID", "123e4567-e89b-12d3-a456-426614174000"),
    neutral("40-hex git SHA", "da39a3ee5e6b4b0d3255bfef95601890afd80709"),
    neutral(
      "64-hex sha256",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ),
    neutral("PATH list", "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"),
    neutral(
      "absolute path",
      "/Users/someone/projects/some-long-directory-name-1234567",
    ),
    neutral(
      "home-relative path",
      "~/projects/some-long-directory-name-1234567/app",
    ),
    neutral(
      "dot-relative path",
      "./node_modules/.cache/some-long-directory-name-1234567",
    ),
    neutral("NODE_OPTIONS flag", "--max-old-space-size=4096"),
    neutral("version", "1.2.3"),
    neutral("boolean", "true"),
    neutral("plain URL without userinfo", "https://example.com/a/b"),
    neutral("URL with a user and no password", "https://user@example.com"),
    neutral(
      "23-char random string (below the length floor)",
      "aB3dE5fG7hJ9kL2mN4pQ6rS",
    ),
    neutral(
      "long all-letters string with no digit",
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
    ),
    neutral(
      "long all-digits string with no letter",
      "1234567890123456789012345678",
    ),
    neutral(
      "sentence with spaces",
      "this is a perfectly ordinary sentence with words",
    ),
    neutral("low-entropy long run", "a1".repeat(20)),
    neutral("short sk- lookalike inside a word", "task-force-sk-short"),
  ];

  it.each(notCredentials)(
    "$label is not credential-like",
    ({ name, value }) => {
      expect(classifyCredential({ name, value })).toEqual({
        credentialLike: false,
      });
    },
  );
});

describe("classifyCredential: purity", () => {
  it("answers the same on repeated calls (no shared /g regex state)", () => {
    const input = { name: NEUTRAL, value: "ghp_" + "A".repeat(30) };
    const answers = [
      classifyCredential(input),
      classifyCredential(input),
      classifyCredential(input),
    ];
    expect(answers).toEqual([
      { credentialLike: true },
      { credentialLike: true },
      { credentialLike: true },
    ]);
  });

  it("does not let one input's answer leak into the next", () => {
    const token = { name: NEUTRAL, value: "sk-ant-api03-" + "A".repeat(24) };
    const plain = { name: NEUTRAL, value: "1.2.3" };
    const sequence = [token, plain, token, plain, token].map(
      (input) => classifyCredential(input).credentialLike,
    );
    expect(sequence).toEqual([true, false, true, false, true]);
  });
});

describe("credential-rule module", () => {
  it("imports nothing from node: and does not use require", () => {
    const source = readFileSync(
      new URL("../credential-rule.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('from "node:');
    expect(source).not.toContain("from 'node:");
    expect(source).not.toContain("require(");
  });
});
