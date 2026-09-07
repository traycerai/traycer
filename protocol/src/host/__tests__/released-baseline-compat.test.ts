import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  checkSurfaceCompatibility,
  parseCompatExceptionsFile,
  protocolSurfaceSchema,
} from "@traycer/protocol/framework/surface-compat";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/**
 * Released baseline surface guard for host→client enum/union growth.
 * When this fails, freeze the shipped line and open a new major with downgrade bridges that drop the new values (amp 003d7586 / devin 407d110 template).
 */

const fixturePath = join(
  import.meta.dirname,
  "__fixtures__/released-baseline-surface.json",
);
const exceptionsPath = join(
  import.meta.dirname,
  "../../../scripts/compat/compat-exceptions.json",
);

describe("released baseline surface (newest release) is wire-compatible", () => {
  it("keeps unreleased browser.screencast out of the released fixture", () => {
    const baseline = protocolSurfaceSchema.parse(
      JSON.parse(readFileSync(fixturePath, "utf8")),
    );
    expect(baseline.stream["browser.screencast"]).toBeUndefined();
  });

  it("live registries have no blocking findings against the committed baseline", () => {
    const theirs = protocolSurfaceSchema.parse(
      JSON.parse(readFileSync(fixturePath, "utf8")),
    );
    const { exceptions } = parseCompatExceptionsFile(
      JSON.parse(readFileSync(exceptionsPath, "utf8")),
    );
    const mine = buildProtocolSurface({
      unary: hostRpcRegistry,
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: hostStreamRpcRegistry,
    });

    const result = checkSurfaceCompatibility({
      mine,
      theirs,
      theirsLabel: "released-baseline-surface.json",
      exceptions,
    });

    if (result.blocking.length > 0) {
      const report = result.blocking
        .map((finding) => {
          const location = [
            finding.family,
            finding.method,
            finding.version === null ? null : `@${finding.version}`,
            finding.payload === null ? null : ` ${finding.payload}`,
            finding.path === null ? null : ` at ${finding.path}`,
          ]
            .filter((part): part is string => part !== null)
            .join("");
          return `  [${finding.severity.toUpperCase()}] ${location}\n      ${finding.detail}`;
        })
        .join("\n");
      expect.fail(
        `${result.blocking.length} blocking finding(s) against the newest released baseline.\n` +
          "Freeze the shipped line and open a new major with downgrade bridges " +
          "(amp 003d7586 / devin 407d110 template).\n" +
          `${report}`,
      );
    }

    expect(result.blocking).toEqual([]);
  });
});
