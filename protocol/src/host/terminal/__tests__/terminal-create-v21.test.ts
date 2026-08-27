/**
 * `terminal.create@2.1` schema + negotiation coverage.
 *
 * Additive request-side `themeHint` (spawning client's resolved terminal
 * appearance, for host-side OSC 10/11 replies). `null` - the v2.0-upgraded
 * default - means "no spawner theme known" and the host answers with its
 * fixed dark fallback. The response is unchanged from `@2.0`. The major
 * downgrade strips the hint and keeps the independent-scope failure gate.
 */
import { describe, expect, it } from "vitest";
import { upgradeRequestToVersion } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  terminalCreateDowngradeV21ToV10,
  terminalCreateUpgradeV20ToV21,
} from "@traycer/protocol/host/terminal/contracts";
import {
  createTerminalRequestSchema,
  createTerminalRequestSchemaV21,
  type CreateTerminalRequestV20,
  type TerminalThemeHint,
} from "@traycer/protocol/host/terminal/unary-schemas";

const V20 = { major: 2, minor: 0 } as const;
const V21 = { major: 2, minor: 1 } as const;

const createRegistry = hostRpcRegistry["terminal.create"];

const LIGHT_HINT: TerminalThemeHint = {
  appearance: "light",
  foreground: "#252525",
  background: "#ffffff",
};

function epicCreateRequest(
  overrides: Partial<CreateTerminalRequestV20>,
): CreateTerminalRequestV20 {
  return {
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    tuiHarnessId: null,
    cwd: "/work/repo",
    shellCommand: null,
    shellArgs: null,
    cols: 80,
    rows: 24,
    desiredSessionId: "term-1",
    worktreeBusyPaths: [],
    ...overrides,
  };
}

describe("createTerminalRequestSchemaV21", () => {
  it("parses a request carrying a theme hint", () => {
    const fixture = { ...epicCreateRequest({}), themeHint: LIGHT_HINT };
    expect(createTerminalRequestSchemaV21.parse(fixture)).toEqual(fixture);
  });

  it("defaults an absent themeHint to null", () => {
    expect(
      createTerminalRequestSchemaV21.parse(epicCreateRequest({})).themeHint,
    ).toBeNull();
  });

  it("rejects a non-hex theme color", () => {
    // The host interpolates these values into an escape sequence written to
    // the PTY, so nothing wider than `#rrggbb` may parse.
    for (const background of ["#fff", "red", "rgb(0, 0, 0)", "#12345g"]) {
      expect(
        createTerminalRequestSchemaV21.safeParse({
          ...epicCreateRequest({}),
          themeHint: { ...LIGHT_HINT, background },
        }).success,
      ).toBe(false);
    }
  });
});

describe("terminal.create v2.0 → v2.1 upgrade", () => {
  it("fills themeHint: null and preserves every other field", () => {
    const request = epicCreateRequest({});
    expect(terminalCreateUpgradeV20ToV21.upgradeRequest(request)).toEqual({
      ...request,
      themeHint: null,
    });
  });

  it("upgrades through the host registry minor chain", () => {
    expect(createRegistry[2]?.latestMinor).toBe(1);
    const upgraded = upgradeRequestToVersion(
      createRegistry,
      V20,
      V21,
      epicCreateRequest({ scope: { kind: "independent" } }),
    );
    expect(upgraded).toEqual({
      ...epicCreateRequest({ scope: { kind: "independent" } }),
      themeHint: null,
    });
  });
});

describe("terminal.create v2.1 → v1.0 downgrade", () => {
  it("strips themeHint and folds the epic scope", () => {
    const result = terminalCreateDowngradeV21ToV10.downgradeRequest({
      ...epicCreateRequest({}),
      themeHint: LIGHT_HINT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("themeHint");
    expect(result.value).not.toHaveProperty("scope");
    expect(result.value.epicId).toBe("epic-1");
    expect(() => createTerminalRequestSchema.parse(result.value)).not.toThrow();
  });

  it("fails independent-scope create requests", () => {
    const result = terminalCreateDowngradeV21ToV10.downgradeRequest({
      ...epicCreateRequest({ scope: { kind: "independent" } }),
      themeHint: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });
});
