import { describe, expect, it } from "vitest";
import {
  redactHomeDirectoryNames,
  redactSensitiveText,
  reduceRequestTargetToPath,
  reduceUrlToOriginAndPath,
} from "../redaction";

describe("redactSensitiveText session cookies", () => {
  /**
   * The reason the pattern is case-sensitive. `sessionId` is Traycer's own
   * camelCase field name and appears on nearly every trace and telemetry
   * line; a case-insensitive cookie pattern redacted all of them, which
   * destroyed support-bundle correlation while protecting nothing - no cookie
   * is ever named `sessionId`.
   */
  it("leaves Traycer's own camelCase sessionId alone", () => {
    expect(redactSensitiveText('{"sessionId":"s-7"}')).toBe(
      '{"sessionId":"s-7"}',
    );
    expect(redactSensitiveText("epic=e1 sessionId=s-7 sessionCount=3")).toBe(
      "epic=e1 sessionId=s-7 sessionCount=3",
    );
  });

  /**
   * One pattern, not a quoted/unquoted pair: both spellings are the same
   * match, so no consumer can apply half the rule.
   */
  it("redacts real cookie names in both the bare and the JSON spelling", () => {
    expect(redactSensitiveText('{"sessionid": "x"}')).toBe(
      '{"sessionid": <redacted>}',
    );
    expect(redactSensitiveText("csrftoken=x")).toBe("csrftoken=<redacted>");
    expect(redactSensitiveText("_acme_session=x")).toBe(
      "_acme_session=<redacted>",
    );
  });
});

describe("redactSensitiveText union coverage", () => {
  /**
   * These three shapes existed in exactly one of the four former copies (the
   * host's provider redactor), which is what "the detection set must not
   * differ by call site" was about.
   */
  it("redacts Cookie headers, Digest response= and AWS4 Signature=", () => {
    expect(redactSensitiveText("Cookie: a=1; b=2")).toBe("Cookie: <redacted>");
    expect(redactSensitiveText('response="deadbeef"')).toBe(
      "response=<redacted>",
    );
    expect(redactSensitiveText("Credential=AKIA, Signature=abc123")).toBe(
      "Credential=<redacted>, Signature=<redacted>",
    );
  });

  /** Fix 1: the value class excludes quotes, so an unquoted key with a
   * quoted value used to fall through both auth patterns entirely. */
  it("redacts a quoted value under an unquoted Authorization key", () => {
    expect(redactSensitiveText('authorization: "abc def"')).toBe(
      "authorization: <redacted>",
    );
    expect(redactSensitiveText("authorization: 'abc def'")).toBe(
      "authorization: <redacted>",
    );
    expect(redactSensitiveText('authorization: "abcdef"')).toBe(
      "authorization: <redacted>",
    );
  });

  it("is idempotent on the quoted-JSON authorization form", () => {
    const once = redactSensitiveText('{"authorization":"Bearer abc.def"}');
    expect(once).toBe('{"authorization":"Bearer <redacted>"}');
    expect(redactSensitiveText(once)).toBe(once);
  });

  it("redacts a quoted authorization key with an unquoted value", () => {
    expect(
      redactSensitiveText('{"authorization": ghs_aaaaaaaaaaaaaaaaaaaaaaaa}'),
    ).toBe('{"authorization": <redacted>}');
  });

  it("redacts the quoted-JSON cookie form", () => {
    expect(redactSensitiveText('{"Set-Cookie":"sid=abc"}')).toBe(
      '{"Set-Cookie":<redacted>}',
    );
  });

  it("redacts a Basic credential but leaves ordinary prose alone", () => {
    expect(redactSensitiveText("Basic dXNlcjpwYXNzd29yZDEyMw==")).toBe(
      "Basic <redacted>",
    );
    expect(redactSensitiveText("Basic setup fails")).toBe("Basic setup fails");
  });

  it("redacts a naked provider token with no key around it", () => {
    expect(
      redactSensitiveText("pasted sk-ant-abcdefghijklmnopqrstuvwxyz here"),
    ).toBe("pasted <redacted> here");
    expect(redactSensitiveText("AKIAIOSFODNN7EXAMPLE")).toBe("<redacted>");
  });

  it("keeps the auth scheme and drops the credential", () => {
    expect(
      redactSensitiveText("Authorization: token ghs_aaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe("Authorization: token <redacted>");
    expect(redactSensitiveText("Bearer abc.def-ghi")).toBe("Bearer <redacted>");
  });

  it("strips URL userinfo and signed query parameters", () => {
    expect(redactSensitiveText("https://u:p@example.com/a?token=t")).toBe(
      "https://<redacted>@example.com/a?token=<redacted>",
    );
  });
});

describe("URL reduction", () => {
  it("keeps origin and pathname only", () => {
    expect(
      reduceUrlToOriginAndPath("https://x.test:8443/a/b?sig=s#access_token=t"),
    ).toBe("https://x.test:8443/a/b");
  });

  /** The one defined non-URL fallback the three former copies disagreed on. */
  it("redacts non-URL text rather than passing it through", () => {
    expect(reduceUrlToOriginAndPath("not a url token=secret1")).toBe(
      "not a url token=<redacted>",
    );
  });

  it("cuts a relative request target at its query", () => {
    expect(reduceRequestTargetToPath("/v1/pay?token=abc")).toBe("/v1/pay");
  });
});

describe("arbitrary-key stem classifier", () => {
  /**
   * The one capability no enumerated key list has: the key is classified by
   * stem, so any prefix or suffix around it still redacts.
   */
  it("redacts an arbitrarily prefixed sensitive key", () => {
    expect(redactSensitiveText("OPENAI_API_KEY=sk-live-x")).toBe(
      "OPENAI_API_KEY=<redacted>",
    );
    expect(redactSensitiveText("GITHUB_TOKEN=abc123")).toBe(
      "GITHUB_TOKEN=<redacted>",
    );
    expect(redactSensitiveText('{"MY_SECRET_TOKEN": "abc123"}')).toBe(
      '{"MY_SECRET_TOKEN": <redacted>}',
    );
  });

  /** A `*_tokens` usage COUNT is the most common number in CLI diagnostics. */
  it("leaves token counts alone", () => {
    expect(redactSensitiveText("max_tokens=4096")).toBe("max_tokens=4096");
    expect(redactSensitiveText("cache_read_input_tokens: 12")).toBe(
      "cache_read_input_tokens: 12",
    );
  });

  it("does not eat the auth scheme the header pattern kept", () => {
    expect(redactSensitiveText("Authorization: token ghs_x")).toBe(
      "Authorization: token <redacted>",
    );
  });
});

describe("redactHomeDirectoryNames", () => {
  it.each([
    [
      "/Users/synthetic-user/.traycer/host/install/host-main.cjs",
      "/Users/<redacted>/.traycer/host/install/host-main.cjs",
    ],
    [
      "/home/synthetic-user/.traycer/host/install/host-runtime/spawn-broker-worker.cjs",
      "/home/<redacted>/.traycer/host/install/host-runtime/spawn-broker-worker.cjs",
    ],
    [
      "C:\\Users\\SyntheticUser\\.traycer\\host\\install\\host-main.cjs",
      "C:\\Users\\<redacted>\\.traycer\\host\\install\\host-main.cjs",
    ],
    ["C:/Users/SyntheticUser/x", "C:/Users/<redacted>/x"],
    ["C:\\\\Users\\\\SyntheticUser\\\\x", "C:\\\\Users\\\\<redacted>\\\\x"],
    ["file:///Users/synthetic-user/x.js", "file:///Users/<redacted>/x.js"],
    ["/Users/Synthetic User/.traycer/x", "/Users/<redacted>/.traycer/x"],
    ["/Users/Synthetic  User/.traycer/x", "/Users/<redacted>/.traycer/x"],
    ["/Users/Synthetic\tUser/.traycer/x", "/Users/<redacted>/.traycer/x"],
    [
      "C:\\Users\\Synthetic  User\\.traycer\\cli\\main.js",
      "C:\\Users\\<redacted>\\.traycer\\cli\\main.js",
    ],
    ["/home/synthetic-user", "/home/<redacted>"],
    ["open '/home/synthetic-user'", "open '/home/<redacted>'"],
    ["/var/home/synthetic-user/x", "/var/home/<redacted>/x"],
    ["c:\\users\\SyntheticUser\\x", "c:\\users\\<redacted>\\x"],
    ["/homework/x", "/homework/x"],
    ["/myhome/x", "/myhome/x"],
    ["/opt/traycer/x", "/opt/traycer/x"],
    ["/Users", "/Users"],
    ["/Users/<redacted>/x", "/Users/<redacted>/x"],
    // Windows folder names may carry an apostrophe or parentheses; a
    // following separator ends the name, so all of it goes.
    [
      "C:\\Users\\Syn'thetic\\.traycer\\x",
      "C:\\Users\\<redacted>\\.traycer\\x",
    ],
    [
      "C:\\Users\\Synthetic (Work)\\.traycer\\x",
      "C:\\Users\\<redacted>\\.traycer\\x",
    ],
    ["/Users/Syn'thetic/.traycer/x", "/Users/<redacted>/.traycer/x"],
    ["/home/Syn'thetic", "/home/<redacted>"],
    // Leading whitespace is part of a separator-closed name.
    ["/Users/ Synthetic/.traycer/x", "/Users/<redacted>/.traycer/x"],
    ["/home/\tSynthetic/.traycer/x", "/home/<redacted>/.traycer/x"],
    [
      "C:\\Users\\ Synthetic\\.traycer\\x",
      "C:\\Users\\<redacted>\\.traycer\\x",
    ],
    [
      "C:\\Users\\\tSynthetic\\.traycer\\x",
      "C:\\Users\\<redacted>\\.traycer\\x",
    ],
    // A home root in prose with no name after it is left alone.
    ["under /Users/ and /home/ only", "under /Users/ and /home/ only"],
    // Prose after a quoted home path is not taken for the name.
    [
      "open '/home/synthetic-user' failed, see /tmp/x",
      "open '/home/<redacted>' failed, see /tmp/x",
    ],
    // Home roots behind a mount, drive or volume prefix, and after a delimiter.
    ["/mnt/c/Users/Syn/x", "/mnt/c/Users/<redacted>/x"],
    ["/c/Users/Syn/x", "/c/Users/<redacted>/x"],
    ["/cygdrive/c/Users/Syn/x", "/cygdrive/c/Users/<redacted>/x"],
    [
      "/System/Volumes/Data/Users/Syn/x",
      "/System/Volumes/Data/Users/<redacted>/x",
    ],
    [
      "/Volumes/Macintosh HD/Users/Syn/x",
      "/Volumes/Macintosh HD/Users/<redacted>/x",
    ],
    ["/usr/home/syn/x", "/usr/home/<redacted>/x"],
    ["\\\\wsl$\\Ubuntu\\home\\syn\\x", "\\\\wsl$\\Ubuntu\\home\\<redacted>\\x"],
    [
      "\\\\wsl.localhost\\Ubuntu\\home\\syn\\x",
      "\\\\wsl.localhost\\Ubuntu\\home\\<redacted>\\x",
    ],
    ["    at f (/Users/syn/x.js:1:1)", "    at f (/Users/<redacted>/x.js:1:1)"],
    ["    at /home/syn/x.js:1:1", "    at /home/<redacted>/x.js:1:1"],
    ['{"cwd":"/home/syn/x"}', '{"cwd":"/home/<redacted>/x"}'],
    ["cwd=/home/syn/x", "cwd=/home/<redacted>/x"],
    ["file:///C:/Users/Syn/x.js", "file:///C:/Users/<redacted>/x.js"],
    ["file:///mnt/c/Users/Syn/x.js", "file:///mnt/c/Users/<redacted>/x.js"],
    [
      '{"p":"C:\\\\Users\\\\Syn\\\\x"}',
      '{"p":"C:\\\\Users\\\\<redacted>\\\\x"}',
    ],
    ["\\\\?\\C:\\Users\\Syn\\x", "\\\\?\\C:\\Users\\<redacted>\\x"],
    ["PATH=/usr/bin:/home/syn/bin", "PATH=/usr/bin:/home/<redacted>/bin"],
    ["null/Users/syn/x.html", "null/Users/<redacted>/x.html"],
    ["[/home/syn/x]", "[/home/<redacted>/x]"],
    ["a\n/home/syn/x", "a\n/home/<redacted>/x"],
    // A users or home segment inside a web route, a URL path or a module id is
    // no home root.
    [
      "https://credit.test/api/collab/users/lookup",
      "https://credit.test/api/collab/users/lookup",
    ],
    ["POST /api/collab/users/lookup", "POST /api/collab/users/lookup"],
    ["/api/collab/users/lookup", "/api/collab/users/lookup"],
    ["https://api.test/users/42", "https://api.test/users/42"],
    ["http://localhost:3000/users/42", "http://localhost:3000/users/42"],
    ["/x/users/42", "/x/users/42"],
    ["/a/home/feed", "/a/home/feed"],
    ["https://home/feed", "https://home/feed"],
    [
      "@/components/home/landing-draft-surface",
      "@/components/home/landing-draft-surface",
    ],
  ])("rewrites %j to %j", (input, expected) => {
    expect(redactHomeDirectoryNames(input)).toBe(expected);
    expect(redactHomeDirectoryNames(expected)).toBe(expected);
  });
});
