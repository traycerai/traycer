import { describe, expect, it } from "vitest";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import {
  isAmbientProfileId,
  parseProfileArgument,
  parseProviderArgument,
  printable,
} from "../profile-target";

function failureOf(run: () => unknown): CliError {
  let thrown: unknown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  if (!(thrown instanceof CliError)) throw new Error("unreachable");
  return thrown;
}

describe("printable", () => {
  it("leaves plain ASCII, accented letters, emoji and CJK unchanged", () => {
    for (const text of [
      "Work account (me@example.com)",
      "Café Zoë ñandú",
      "build \u{1F680} done",
      "作業アカウント",
      "",
    ]) {
      expect(printable(text)).toBe(text);
    }
  });

  it("renders C0 controls, including newline, carriage return, tab and ESC, as \\xNN", () => {
    expect(printable("a\nb")).toBe("a\\x0ab");
    expect(printable("a\rb")).toBe("a\\x0db");
    expect(printable("a\tb")).toBe("a\\x09b");
    expect(printable("\u001b[31mred\u001b[0m")).toBe("\\x1b[31mred\\x1b[0m");
    expect(printable("\u0000\u001f")).toBe("\\x00\\x1f");
  });

  it("renders DEL and C1 controls as \\xNN", () => {
    expect(printable("\u007f")).toBe("\\x7f");
    expect(printable("\u0080\u009b\u009f")).toBe("\\x80\\x9b\\x9f");
  });

  it("renders the Unicode line and paragraph separators as \\uNNNN", () => {
    expect(printable("a\u2028b\u2029c")).toBe("a\\u2028b\\u2029c");
  });

  it("does not touch the characters just outside the control ranges", () => {
    expect(printable(" ~ ¡")).toBe(" ~ ¡");
  });

  it("leaves no raw control character in the result", () => {
    const result = printable("x\r\n\u001b]0;title\u0007\u2028y");
    expect(result).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  });
});

describe("parseProviderArgument", () => {
  it("accepts a harness id, a provider id, and surrounding whitespace", () => {
    expect(parseProviderArgument("claude")).toBe("claude-code");
    expect(parseProviderArgument("claude-code")).toBe("claude-code");
    expect(parseProviderArgument("  codex  ")).toBe("codex");
  });

  it("rejects an unknown provider naming the value", () => {
    const error = failureOf(() => parseProviderArgument("not-a-provider"));

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.message).toContain("not-a-provider");
  });
});

describe("parseProfileArgument", () => {
  it("trims the value and keeps ambient as the literal sentinel", () => {
    expect(parseProfileArgument("  prof_work ")).toBe("prof_work");
    expect(parseProfileArgument("ambient")).toBe("ambient");
  });

  it("rejects an empty or whitespace-only value", () => {
    for (const value of ["", "   "]) {
      const error = failureOf(() => parseProfileArgument(value));
      expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    }
  });
});

describe("isAmbientProfileId", () => {
  it("is true only for the ambient sentinel", () => {
    expect(isAmbientProfileId("ambient")).toBe(true);
    expect(isAmbientProfileId("prof_work")).toBe(false);
  });
});
