import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ensureHost: vi.fn() }));
vi.mock("../../host/ensure", () => ({ ensureHost: mocks.ensureHost }));

import { config } from "../../config";
import { buildProgram } from "../../index";

let stdout: string[];
let originalPin: string | null;

beforeEach(() => {
  stdout = [];
  originalPin = config.supportedHostVersion;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
});

afterEach(() => {
  config.supportedHostVersion = originalPin;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("bundled CLI entrypoints", () => {
  it.each(["1.5.3", null])(
    "prints the build pin as standalone JSON (%s)",
    async (supportedHostVersion) => {
      config.supportedHostVersion = supportedHostVersion;

      await buildProgram().parseAsync([
        "node",
        "traycer",
        "host",
        "pin",
        "--json",
      ]);

      expect(stdout.join("")).toBe(
        `${JSON.stringify({ supportedHostVersion })}\n`,
      );
    },
  );

  it("rejects --release with --bundled during Commander parsing", async () => {
    await expect(
      buildProgram().parseAsync([
        "node",
        "traycer",
        "host",
        "ensure",
        "--release",
        "1.5.3",
        "--bundled",
        "/tmp/host-runtime.tar.gz",
      ]),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });

    expect(mocks.ensureHost).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
  });
});
