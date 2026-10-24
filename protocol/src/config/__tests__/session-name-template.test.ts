import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_SESSION_NAME_TEMPLATE,
  SESSION_NAME_PLACEHOLDERS,
  renderSessionName,
  sessionNameClockValues,
  unknownSessionNamePlaceholders,
  type SessionNameValues,
} from "../session-name-template";

const VALUES: SessionNameValues = {
  project: "my-app",
  repository: "traycer",
  branch: "feature/login",
  task: "Fix login timeout",
  agent: "Reviewer",
  agent_id: "1a2b3c4d",
  date: "2026-10-24",
  time: "09-05",
};

function withValues(
  overrides: Partial<Record<keyof SessionNameValues, string>>,
): SessionNameValues {
  return { ...VALUES, ...overrides };
}

describe("renderSessionName", () => {
  it("fills every placeholder", () => {
    expect(
      renderSessionName(
        "{project} {repository} {branch} {task} {agent} {agent_id} {date} {time}",
        VALUES,
      ),
    ).toBe(
      "my-app traycer feature/login Fix login timeout Reviewer 1a2b3c4d 2026-10-24 09-05",
    );
  });

  it("drops an empty value with the separator it would leave doubled", () => {
    const folderless = withValues({ project: "" });
    expect(
      renderSessionName(DEFAULT_CLAUDE_SESSION_NAME_TEMPLATE, folderless),
    ).toBe("Traycer · 2026-10-24");
    expect(renderSessionName("{task} - {date}", withValues({ task: "" }))).toBe(
      "2026-10-24",
    );
    expect(
      renderSessionName("{project}-{branch}", withValues({ branch: "" })),
    ).toBe("my-app");
  });

  it("keeps a separator a value starts with", () => {
    expect(
      renderSessionName("{project} {branch}", withValues({ branch: "-wip" })),
    ).toBe("my-app -wip");
  });

  it("leaves an unknown placeholder as written", () => {
    expect(renderSessionName("{project} {nope}", VALUES)).toBe("my-app {nope}");
  });

  it("turns control characters into spaces, C1 included, in values and in the template", () => {
    expect(
      renderSessionName("{task}", withValues({ task: "line one\nline two" })),
    ).toBe("line one line two");
    // U+0085 (next line) and U+009B (control sequence introducer) are C1.
    expect(
      renderSessionName("{task}", withValues({ task: "line one\u0085two" })),
    ).toBe("line one two");
    expect(renderSessionName("{project}\u009bnext", VALUES)).toBe(
      "my-app next",
    );
  });

  it("drops format characters, so no bidi override reorders the name", () => {
    expect(
      renderSessionName("{task}", withValues({ task: "abc\u202edef\u200b" })),
    ).toBe("abcdef");
  });

  it("caps the name at 100 code points without a trailing separator", () => {
    const long = `${"a".repeat(99)} ${"b".repeat(20)}`;
    expect(renderSessionName("{task}", withValues({ task: long }))).toBe(
      "a".repeat(99),
    );
    const emoji = "😀".repeat(150);
    expect(
      Array.from(renderSessionName("{task}", withValues({ task: emoji }))),
    ).toHaveLength(100);
  });

  it("renders the default when the template comes out empty, down to Traycer alone", () => {
    expect(renderSessionName("{task}", withValues({ task: "" }))).toBe(
      "Traycer · my-app · 2026-10-24",
    );
    expect(renderSessionName("", withValues({ project: "", date: "" }))).toBe(
      "Traycer",
    );
  });
});

describe("unknownSessionNamePlaceholders", () => {
  it("lists each name outside the known list once", () => {
    expect(
      unknownSessionNamePlaceholders(
        "{project} {nope} {nope} {Branch}",
        SESSION_NAME_PLACEHOLDERS,
      ),
    ).toEqual(["nope", "Branch"]);
  });

  it("checks against the list it is given", () => {
    expect(
      unknownSessionNamePlaceholders("{project} {time}", ["project"]),
    ).toEqual(["time"]);
  });
});

describe("sessionNameClockValues", () => {
  it("pads the local date and time", () => {
    expect(sessionNameClockValues(new Date(2026, 0, 5, 7, 3))).toEqual({
      date: "2026-01-05",
      time: "07-03",
    });
  });
});
