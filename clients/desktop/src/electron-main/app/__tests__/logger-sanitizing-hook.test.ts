/**
 * Redaction used to be per-call-site opt-in, which is the wrong shape for a
 * guarantee: it holds only where someone remembered, and the log line that
 * carries a token is written by the site that did NOT remember. `initLogger`
 * installs one `electron-log` hook instead, so a new call site inherits it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: (_key: string): string => "/tmp/traycer-desktop-logger-test",
  },
}));

type LogHook = (message: { level: string; data: unknown[] }) => {
  level: string;
  data: unknown[];
};

// `vi.mock` is hoisted above every top-level binding, so the array the test
// and the factory share has to be hoisted with it.
const { hooks } = vi.hoisted(() => ({ hooks: [] as LogHook[] }));

vi.mock("electron-log", () => ({
  default: {
    hooks,
    transports: {
      file: { level: "info", resolvePathFn: (): string => "" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../desktop-log-level", () => ({
  applyDesktopLogLevel: vi.fn(),
  readDesktopLogLevelSync: (): string => "info",
}));

import { initLogger } from "../logger";

/** What every installed hook does to one log call's arguments. */
function throughHooks(data: unknown[]): unknown[] {
  return hooks.reduce((message, hook) => hook(message), { level: "info", data })
    .data;
}

describe("electron-log sanitizing hook", () => {
  beforeEach(() => {
    hooks.length = 0;
    initLogger();
  });

  it("is installed by initLogger", () => {
    expect(hooks).toHaveLength(1);
  });

  it("redacts a secret inside an object argument no call site remembered to scrub", () => {
    const [message, fields] = throughHooks([
      "[desktop] host attach failed",
      { url: "https://x.com/attach?token=SECRET123", attempt: 2 },
    ]);

    // The developer's own message keeps its wording: the string path redacts
    // but never truncates.
    expect(message).toBe("[desktop] host attach failed");
    expect(JSON.stringify(fields)).not.toContain("SECRET123");
    expect(JSON.stringify(fields)).toContain("<redacted>");
    expect(fields).toMatchObject({ attempt: 2 });
  });

  it("reaches a secret nested under an array and an Error", () => {
    const [, fields] = throughHooks([
      "boom",
      {
        attempts: [{ authorization: "Bearer abcdef123456" }],
        cause: new Error("failed for password: hunter2"),
      },
    ]);

    const rendered = JSON.stringify(fields);
    expect(rendered).not.toContain("abcdef123456");
    expect(rendered).not.toContain("hunter2");
  });

  it("redacts a session cookie in a structured field, which no key pattern matched", () => {
    // `SENSITIVE_KEY_PATTERN` keys on the word "cookie"; the field below is
    // named neither that nor "token", and its value is a full account takeover.
    const [, fields] = throughHooks([
      "boom",
      { requestHeader: "sessionid=9f8e7d6c5b4a; theme=dark" },
    ]);

    const rendered = JSON.stringify(fields);
    expect(rendered).not.toContain("9f8e7d6c5b4a");
    expect(rendered).toContain("<redacted>");
    expect(rendered).toContain("theme=dark");
  });

  it("is idempotent, so a site that already sanitizes is unaffected", () => {
    const once = throughHooks([{ token: "SECRET123" }]);
    const twice = throughHooks(once);

    expect(twice).toEqual(once);
  });

  it("redacts a secret interpolated into the message string itself", () => {
    // The common leak shape: a template literal, not a fields object. Leaving
    // strings alone would exempt exactly the argument that leaks most.
    const [message] = throughHooks([
      "[desktop] attach failed for Cookie: sessionid=abc123def456; theme=dark",
    ]);

    expect(message).not.toContain("abc123def456");
    expect(message).toContain("[desktop] attach failed");
    expect(message).toContain("<redacted>");
  });

  it("does not truncate a long string argument", () => {
    // The 1,000-char cap is `redactLogText`'s policy for a structured field,
    // not something a hook may do to a developer's own message.
    const [message] = throughHooks([`x${"y".repeat(4_000)}`]);

    expect(message).toBe(`x${"y".repeat(4_000)}`);
  });

  it("passes primitive arguments through untouched", () => {
    expect(throughHooks([1, true, null])).toEqual([1, true, null]);
  });
});
