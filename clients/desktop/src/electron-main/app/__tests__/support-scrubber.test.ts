import { describe, expect, it } from "vitest";
import { deepScrubSupportValue, scrubSupportText } from "../support-scrubber";

describe("scrubSupportText", () => {
  it("redacts a Bearer token", () => {
    expect(scrubSupportText("Bearer abc123.def456-ghi")).toBe(
      "Bearer <redacted>",
    );
  });

  it("redacts only the token query value in a URL, preserving structure", () => {
    // The Windows-drive-letter path regex must not match the "s:" of "https:"
    // (negative lookbehind). Only the token value is redacted.
    expect(
      scrubSupportText("url: https://x.com/oauth?token=SECRET123&foo=bar"),
    ).toBe("url: https://x.com/oauth?token=<redacted>&foo=bar");
  });

  it("redacts an inline password assignment", () => {
    expect(scrubSupportText('password: "hunter2"')).toBe(
      "password: <redacted>",
    );
  });

  it("pseudonymizes a POSIX path including trailing :line:col in one token", () => {
    expect(
      scrubSupportText(
        "at ChatRuntime.subscribe (/Users/anurag/Desktop/acme-corp/src/chat-runtime.ts:42:10)",
      ),
    ).toBe("at ChatRuntime.subscribe (<path-1>)");
  });

  it("pseudonymizes a quoted POSIX path, preserving surrounding quotes", () => {
    expect(
      scrubSupportText(
        "Cannot find module '/Applications/Traycer.app/Contents/Resources/lifecycle_lock.node'",
      ),
    ).toBe("Cannot find module '<path-1>'");
  });

  it("pseudonymizes a Windows drive path", () => {
    expect(
      scrubSupportText(
        "windows path C:\\Users\\anurag\\AppData\\Local\\Traycer\\log.txt end",
      ),
    ).toBe("windows path <path-1> end");
  });

  it("pseudonymizes a UNC path", () => {
    expect(
      scrubSupportText("unc path \\\\server\\share\\folder\\file.txt end"),
    ).toBe("unc path <path-1> end");
  });

  it("leaves API-route-looking text alone (not a recognized filesystem root)", () => {
    const input = "GET /api/v1/host/status 200";
    expect(scrubSupportText(input)).toBe(input);
  });

  it("does not partially replace words that merely begin with a POSIX root name", () => {
    const input = "notes /homework/notes.txt and /dataset stay intact";
    expect(scrubSupportText(input)).toBe(input);
  });

  it("reuses the same path pseudonym for identical paths within one call", () => {
    const input =
      "first /Users/anurag/project/a.ts then again /Users/anurag/project/a.ts";
    expect(scrubSupportText(input)).toBe("first <path-1> then again <path-1>");
  });

  it("assigns distinct path pseudonyms for different paths within one call", () => {
    const input = "see /Users/anurag/one.ts and /Users/anurag/two.ts";
    expect(scrubSupportText(input)).toBe("see <path-1> and <path-2>");
  });

  it("does not truncate a long match-free string (no 1000-char cap)", () => {
    const input = "x".repeat(5000);
    const result = scrubSupportText(input);
    expect(result).toBe(input);
    expect(result.length).toBe(5000);
  });

  it("does not truncate a multi-line log-tail-sized input", () => {
    // ~2000 lines, well past the old redactLogText whole-string 1000-char cap.
    const lines = Array.from({ length: 2000 }, (_, i) => `log-line-${i}-ok`);
    const input = lines.join("\n");
    const result = scrubSupportText(input);
    expect(result).toBe(input);
    expect(result.split("\n")).toHaveLength(2000);
  });

  it("redacts sensitive patterns line-wise across a multi-line block", () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) => `line ${i}: Bearer token${i}.abc`,
    );
    const result = scrubSupportText(lines.join("\n"));
    const resultLines = result.split("\n");
    expect(resultLines).toHaveLength(12);
    for (const [i, line] of resultLines.entries()) {
      expect(line).toBe(`line ${i}: Bearer <redacted>`);
    }
  });

  // Code-review findings (ticket 09 follow-up): the reviewer's exact failing
  // strings, verified by executing the scrubber directly before and after
  // the fix - not re-derived from reading the regex.
  describe("code review findings", () => {
    it("redacts a POSIX path whole even when a segment contains a single space (finding #2)", () => {
      // Was: "<path-1> Doe/acme-secret/x.ts" - the space terminated the
      // match early and leaked everything after it.
      expect(scrubSupportText("/Users/John Doe/acme-secret/x.ts")).toBe(
        "<path-1>",
      );
    });

    it("redacts a Windows path whole even when a segment contains a single space (finding #2)", () => {
      expect(scrubSupportText("C:\\Users\\John Doe\\project\\x.ts")).toBe(
        "<path-1>",
      );
    });

    it("redacts a path whole with a run of 2+ spaces in a segment (finding #2)", () => {
      expect(scrubSupportText("/Users/John    Doe/x.ts")).toBe("<path-1>");
    });

    it("redacts a three-word capitalized name segment whole, not just the first two words (finding #2)", () => {
      // An earlier fix allowed only ONE embedded-space continuation, which
      // still leaked " Watson/x.ts" for a three-word name.
      expect(scrubSupportText("/Users/Mary Jane Watson/x.ts")).toBe("<path-1>");
    });

    it("redacts a ~/ home-relative path (finding #2 - previously passed through unchanged)", () => {
      expect(scrubSupportText("~/project/secret.ts")).toBe("<path-1>");
    });

    it("leaves a bare ~ with no following path alone", () => {
      const input = "cd ~ && ls";
      expect(scrubSupportText(input)).toBe(input);
    });

    it("redacts /workspace and /Volumes roots (finding #2 - previously unlisted)", () => {
      expect(scrubSupportText("/workspace/acme-corp/x.ts")).toBe("<path-1>");
      expect(scrubSupportText("/Volumes/External/acme/x.ts")).toBe("<path-1>");
    });

    it("redacts a JSON-stringified Windows path whole, not leaving a bare drive letter (finding #2)", () => {
      // Was: `{"path":"C:<path-1>"}` - the doubled backslashes JSON.stringify
      // produces between each level were matched one-at-a-time, leaving the
      // second backslash of each pair (and the bare "C:") for a later
      // pattern to mis-claim instead.
      const jsonStringified = JSON.stringify({
        path: "C:\\Users\\anurag\\file.txt",
      });
      expect(scrubSupportText(jsonStringified)).toBe('{"path":"<path-1>"}');
    });

    it("does not merge two separate path mentions on one line into one match", () => {
      // A path with no trailing quote/paren/EOL must still stop before the
      // NEXT path mention, not swallow the connecting prose and the second
      // path into a single token.
      const result = scrubSupportText(
        "first /Users/anurag/project/a.ts then again /Users/anurag/project/a.ts",
      );
      expect(result).toBe("first <path-1> then again <path-1>");
    });

    it("redacts a quoted-key password assignment (finding #3)", () => {
      // Plain SENSITIVE_INLINE_VALUE_PATTERN requires `\s*[:=]` right after
      // the key word; a JSON key's closing quote sits in between and broke
      // the match entirely, so this used to pass through verbatim.
      expect(scrubSupportText('{"password":"hunter2"}')).toBe(
        '{"password":<redacted>}',
      );
    });

    it("redacts a quoted-key api_key assignment (finding #3)", () => {
      expect(scrubSupportText('{"api_key":"sk-secret"}')).toBe(
        '{"api_key":<redacted>}',
      );
    });

    it("redacts a quoted-key camelCase clientSecret with a spaced value (finding #3)", () => {
      expect(scrubSupportText('{"clientSecret":"value with spaces"}')).toBe(
        '{"clientSecret":<redacted>}',
      );
    });

    it("redacts a quoted-key authorization Basic-auth value (finding #3)", () => {
      expect(scrubSupportText('{"authorization":"Basic dXNlcjpwYXNz"}')).toBe(
        '{"authorization":<redacted>}',
      );
    });

    it("redacts an unquoted Basic-auth header value in full, not just the word Basic (finding #3)", () => {
      // The bare-value branch of the inline patterns stops at the first
      // whitespace, so without a dedicated Basic-auth pattern only the word
      // "Basic" was redacted and the base64 credential right after it
      // survived untouched.
      const result = scrubSupportText(
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      );
      expect(result).not.toContain("dXNlcjpwYXNzd29yZA==");
    });

    it("preserves ordinary prose that starts with Basic", () => {
      expect(scrubSupportText("Basic setup fails on launch")).toBe(
        "Basic setup fails on launch",
      );
    });
  });

  // Live E2E verification (finding N2, P1): a naked, high-entropy API key
  // pasted directly into free text - no surrounding key=value/quoted-key
  // context at all - matched none of the patterns above. This is the exact
  // planted fixture from that run, plus one fixture per token family, each
  // checked in both an "intent text" position (a plain user sentence) and a
  // "log line" position (the shape a host.log/desktop.log line takes).
  describe("token-shape redaction (finding N2)", () => {
    const ANTHROPIC_KEY =
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABCDEFGH";

    it("redacts the exact planted Anthropic key from the live E2E run, in intent-text position", () => {
      const result = scrubSupportText(
        `I was using my key ${ANTHROPIC_KEY} to test the feature`,
      );
      expect(result).not.toContain(ANTHROPIC_KEY);
      expect(result).toBe("I was using my key <redacted> to test the feature");
    });

    it("redacts the same Anthropic key in log-line position", () => {
      const result = scrubSupportText(
        `2026-07-31T00:00:00Z [info] provider auth using ${ANTHROPIC_KEY}`,
      );
      expect(result).not.toContain(ANTHROPIC_KEY);
    });

    it.each([
      [
        "generic sk- (OpenAI-style sk-proj-...)",
        "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
      ],
      ["GitHub ghp_", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz12345678"],
      [
        "GitHub github_pat_",
        "github_pat_11ABCDEFG0AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABCDEFGHIJKLMNOP",
      ],
      [
        "Slack xoxb-",
        ["xox", "b-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrSt"].join(""),
      ],
      ["AWS AKIA (access key id)", "AKIAIOSFODNN7EXAMPLE"],
      ["Google AIza", "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567"],
      [
        "Stripe sk_live_",
        ["sk_", "live_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"].join(""),
      ],
      [
        "Stripe rk_live_",
        ["rk_", "live_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"].join(""),
      ],
      [
        "JWT shape",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ],
      ["npm_ token", "npm_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"],
    ])(
      "redacts a %s token in both intent-text and log-line position",
      (_label, token) => {
        const intentResult = scrubSupportText(
          `Here is what happened: I pasted ${token} into the field by mistake`,
        );
        expect(intentResult).not.toContain(token);

        const logLineResult = scrubSupportText(
          `2026-07-31T00:00:00Z [debug] request header token=${token}`,
        );
        expect(logLineResult).not.toContain(token);
      },
    );

    it("does not touch ordinary words that merely contain a token-prefix-shaped substring", () => {
      const input = "risk-adjusted task-runner desk-check-something";
      expect(scrubSupportText(input)).toBe(input);
    });

    it("does not touch a short benign string that starts with a token prefix but is too short to be one", () => {
      const input = "sk-ai is a cool product name";
      expect(scrubSupportText(input)).toBe(input);
    });
  });
});

describe("deepScrubSupportValue", () => {
  it("scrubs string leaves", () => {
    expect(deepScrubSupportValue({ a: "token: abc" })).toEqual({
      a: "token: <redacted>",
    });
  });

  it("recurses into nested objects", () => {
    expect(
      deepScrubSupportValue({
        nested: { stack: "at foo (/Users/anurag/x.ts:1:1)" },
      }),
    ).toEqual({ nested: { stack: "at foo (<path-1>)" } });
  });

  it("fully redacts values whose key matches SENSITIVE_KEY_PATTERN", () => {
    expect(
      deepScrubSupportValue({ apiKey: "should-be-fully-redacted-by-key-name" }),
    ).toEqual({ apiKey: "<redacted>" });
  });

  it("recurses into arrays", () => {
    expect(
      deepScrubSupportValue({ arr: ["/Users/anurag/one.ts", "plain"] }),
    ).toEqual({ arr: ["<path-1>", "plain"] });
  });

  it("passes numbers, booleans, and null through unchanged", () => {
    expect(
      deepScrubSupportValue({
        n: 42,
        b: true,
        z: false,
        empty: null,
      }),
    ).toEqual({
      n: 42,
      b: true,
      z: false,
      empty: null,
    });
  });

  it("fully scrubs a realistic depth-3/4 nested object (bounds do not fire)", () => {
    const input = {
      cause: {
        type: "Error",
        message: "boom at /Users/anurag/secret/x.ts:1:1",
        stack: "at run (/Users/anurag/secret/x.ts:1:1)",
        nested: {
          layer0: {
            note: "path /Users/anurag/secret/y.ts seen",
          },
        },
      },
      processMetrics: {
        cpu: 12.5,
        mem: 1024,
      },
    };
    expect(deepScrubSupportValue(input)).toEqual({
      cause: {
        type: "Error",
        message: "boom at <path-1>",
        stack: "at run (<path-1>)",
        nested: {
          layer0: {
            note: "path <path-2> seen",
          },
        },
      },
      processMetrics: {
        cpu: 12.5,
        mem: 1024,
      },
    });
  });

  it("shares path pseudonyms across every string leaf in one value", () => {
    expect(
      deepScrubSupportValue({
        first: "/Users/anurag/one.ts",
        repeated: "again /Users/anurag/one.ts",
        second: "/Users/anurag/two.ts",
      }),
    ).toEqual({
      first: "<path-1>",
      repeated: "again <path-1>",
      second: "<path-2>",
    });
  });

  it("drops containers beyond the depth bound instead of leaking their strings", () => {
    const input = {
      one: {
        two: {
          three: {
            four: {
              five: {
                six: {
                  seven: {
                    secret: "/Users/anurag/private/token.txt",
                  },
                },
              },
            },
          },
        },
      },
    };
    const scrubbed = deepScrubSupportValue(input);
    expect(JSON.stringify(scrubbed)).not.toContain("/Users/anurag");
    expect(scrubbed).toEqual({
      one: {
        two: {
          three: {
            four: {
              five: {
                six: "<depth-limit>",
              },
            },
          },
        },
      },
    });
  });
});
