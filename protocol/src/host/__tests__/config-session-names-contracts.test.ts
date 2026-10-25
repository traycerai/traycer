import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  configSessionNamesGetV10,
  configSessionNamesSetV10,
} from "@traycer/protocol/host/config/contracts";

/**
 * `config.sessionNames.*` carries the Claude terminal session name template.
 * A host that predates it must report the method as missing, because the
 * Settings group hides itself on that answer.
 */
describe("config.sessionNames contracts", () => {
  it("registers get and set at v1.0 with the unsupported degrade", () => {
    for (const method of [
      "config.sessionNames.get",
      "config.sessionNames.set",
    ] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
    }
    expect(
      hostRpcRegistry["config.sessionNames.get"][1].versions[0].contract,
    ).toBe(configSessionNamesGetV10);
    expect(
      hostRpcRegistry["config.sessionNames.set"][1].versions[0].contract,
    ).toBe(configSessionNamesSetV10);
  });

  it("answers the template with the host's default and placeholders, and caps a written template", () => {
    const state = {
      claudeTemplate: "{project}-{date}",
      defaultClaudeTemplate: "Traycer · {project} · {date}",
      placeholders: ["project", "date"],
    };
    expect(configSessionNamesGetV10.responseSchema.parse(state)).toEqual(state);
    expect(
      configSessionNamesSetV10.requestSchema.parse({ claudeTemplate: "" }),
    ).toEqual({ claudeTemplate: "" });
    expect(() =>
      configSessionNamesSetV10.requestSchema.parse({
        claudeTemplate: "x".repeat(201),
      }),
    ).toThrow();
    // The host always states every field; a missing one is a malformed peer.
    expect(() =>
      configSessionNamesGetV10.responseSchema.parse({
        claudeTemplate: "{project}",
      }),
    ).toThrow();
  });
});
