import { describe, expect, it } from "vitest";
import {
  draftProblem,
  emptyDraft,
  type HookDraft,
} from "@/components/settings/panels/notification-hook-draft";

const REFUSAL = "Sandboxes don't take sign-ins";

function commandDraft(overrides: Partial<HookDraft>): HookDraft {
  return {
    ...emptyDraft(),
    actionType: "command",
    command: "/usr/local/bin/notify",
    ...overrides,
  };
}

function httpDraft(overrides: Partial<HookDraft>): HookDraft {
  return {
    ...emptyDraft(),
    actionType: "http",
    url: "https://hooks.example.com/traycer",
    ...overrides,
  };
}

describe("draftProblem without a credential refusal", () => {
  it("accepts a command with an executable and any arguments", () => {
    expect(draftProblem(commandDraft({}), null)).toBeNull();
    expect(
      draftProblem(
        commandDraft({ argsText: "--url\nhttps://alice:token@host/x" }),
        null,
      ),
    ).toBeNull();
  });

  it("asks for a severity, an executable and a URL, in that order of precedence", () => {
    expect(draftProblem(commandDraft({ severities: [] }), null)).toBe(
      "Pick at least one severity.",
    );
    expect(draftProblem(commandDraft({ command: "   " }), null)).toBe(
      "Enter the executable to run.",
    );
    expect(draftProblem(httpDraft({ url: "  " }), null)).toBe("Enter a URL.");
  });

  it("rejects a URL that is not http(s), and one that cannot be parsed", () => {
    expect(draftProblem(httpDraft({ url: "ftp://host/x" }), null)).toBe(
      "The URL must be http(s).",
    );
    expect(draftProblem(httpDraft({ url: "not a url" }), null)).not.toBeNull();
  });

  it("tells a URL with a sign-in to use a header instead", () => {
    expect(
      draftProblem(httpDraft({ url: "https://alice:token@host/x" }), null),
    ).toBe("Put credentials in a header, not the URL.");
    expect(draftProblem(httpDraft({ url: "https://token@host/x" }), null)).toBe(
      "Put credentials in a header, not the URL.",
    );
  });

  it("accepts header values, which are how the credentials are meant to travel", () => {
    expect(
      draftProblem(
        httpDraft({ headersText: "authorization: Bearer $MY_TOKEN" }),
        null,
      ),
    ).toBeNull();
  });
});

describe("draftProblem with a credential refusal", () => {
  it("refuses an http hook with a header value, naming the header values", () => {
    expect(
      draftProblem(
        httpDraft({ headersText: "authorization: Bearer secret" }),
        REFUSAL,
      ),
    ).toBe(`${REFUSAL}: remove the header values to save this hook here.`);
  });

  it("refuses a header value on any line, and one written as an env reference", () => {
    expect(
      draftProblem(
        httpDraft({ headersText: "x-trace:\nauthorization: Bearer $MY_TOKEN" }),
        REFUSAL,
      ),
    ).toBe(`${REFUSAL}: remove the header values to save this hook here.`);
  });

  it("allows header names whose values are empty", () => {
    expect(
      draftProblem(httpDraft({ headersText: "x-trace:\nx-other" }), REFUSAL),
    ).toBeNull();
  });

  it("allows an http hook with a plain URL and no headers", () => {
    expect(draftProblem(httpDraft({}), REFUSAL)).toBeNull();
  });

  it("refuses a URL with a sign-in in the refusal's own words, not the header advice", () => {
    const problem = draftProblem(
      httpDraft({ url: "https://alice:token@host/x" }),
      REFUSAL,
    );
    expect(problem).toBe(
      `${REFUSAL}: remove the sign-in from the URL to save this hook here.`,
    );
    expect(problem).not.toContain("Put credentials in a header");
  });

  it("refuses a command whose arguments contain a URL with a sign-in", () => {
    expect(
      draftProblem(
        commandDraft({ argsText: "--endpoint\nhttps://ghp_x@github.com/o/r" }),
        REFUSAL,
      ),
    ).toBe(
      `${REFUSAL}: remove the sign-in from its URLs to save this hook here.`,
    );
  });

  it("refuses a command that is itself a URL with a sign-in", () => {
    expect(
      draftProblem(
        commandDraft({ command: "https://alice:token@host/run" }),
        REFUSAL,
      ),
    ).toBe(
      `${REFUSAL}: remove the sign-in from its URLs to save this hook here.`,
    );
  });

  it("allows a command with plain arguments, including an ssh URL naming only an account", () => {
    expect(
      draftProblem(
        commandDraft({
          argsText: "--channel\nbuilds\nhttps://host/x\nssh://git@host/repo",
        }),
        REFUSAL,
      ),
    ).toBeNull();
  });

  it("keeps the ordinary problems first: severity and a missing executable or URL", () => {
    expect(draftProblem(commandDraft({ severities: [] }), REFUSAL)).toBe(
      "Pick at least one severity.",
    );
    expect(draftProblem(commandDraft({ command: "" }), REFUSAL)).toBe(
      "Enter the executable to run.",
    );
    expect(draftProblem(httpDraft({ url: "" }), REFUSAL)).toBe("Enter a URL.");
  });
});
