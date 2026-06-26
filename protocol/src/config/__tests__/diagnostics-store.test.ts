import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

import { cliConfigPath, cliDiagnosticsConfigPath } from "../paths";
import {
  clearTemporaryDiagnosticsLogLevel,
  clearTemporaryDiagnosticsLogLevels,
  clearTemporaryHostDiagnosticsLogLevel,
  patchDiagnosticsConfig,
  readDiagnosticsRaw,
  resetDiagnosticsConfig,
  resolveDiagnosticsEffective,
  setDiagnosticsLogLevel,
  setHostDiagnosticsLogLevel,
  setTemporaryDiagnosticsLogLevel,
  setTemporaryHostDiagnosticsLogLevel,
} from "../diagnostics-store";
import { EMPTY_DIAGNOSTICS_PATCH } from "../diagnostics-schema";
import { readCliConfig } from "../store";

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-diagnostics-config-"));
});

async function writeDiagnosticsRaw(contents: string): Promise<void> {
  const target = cliDiagnosticsConfigPath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function readDiagnosticsJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(cliDiagnosticsConfigPath(), "utf8"));
}

describe("diagnostics config store", () => {
  it("resolves defaults when the dedicated diagnostics file is missing", async () => {
    const raw = await readDiagnosticsRaw();
    const effective = resolveDiagnosticsEffective(
      raw,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(raw.readStatus).toBe("missing");
    expect(raw.path).toBe(cliDiagnosticsConfigPath());
    expect(effective.general).toMatchObject({
      level: "info",
      source: "default",
      expiresAt: null,
    });
    expect(effective.host).toMatchObject({
      level: "info",
      source: "default",
      expiresAt: null,
    });
  });

  it("writes diagnostics to diagnostics.json without creating config.json", async () => {
    await setDiagnosticsLogLevel("warn");

    expect(await readDiagnosticsJson()).toMatchObject({
      version: 1,
      logLevel: "warn",
    });
    expect(await readCliConfig()).toEqual({
      version: 1,
      shell: { path: null, args: null },
      envOverrides: {},
    });
  });

  it("preserves unknown fields and unknown enum values through unrelated writes", async () => {
    await writeDiagnosticsRaw(
      JSON.stringify({
        version: 1,
        logLevel: "verbose",
        futureRoot: { keep: true },
        temporaryLogLevel: {
          level: "debug",
          expiresAt: "2026-01-01T00:30:00.000Z",
          futureMeta: "kept",
        },
      }),
    );

    await setHostDiagnosticsLogLevel("debug");

    expect(await readDiagnosticsJson()).toEqual({
      version: 1,
      logLevel: "verbose",
      futureRoot: { keep: true },
      temporaryLogLevel: {
        level: "debug",
        expiresAt: "2026-01-01T00:30:00.000Z",
        futureMeta: "kept",
      },
      hostLogLevel: "debug",
    });
  });

  it("does not stamp a future config version back down to the current one", async () => {
    await writeDiagnosticsRaw(
      JSON.stringify({ version: 2, logLevel: "info", futureRoot: { a: 1 } }),
    );

    await setHostDiagnosticsLogLevel("debug");

    // An older binary's write preserves the newer version and its unknown keys
    // instead of re-stamping version 2 -> 1.
    expect(await readDiagnosticsJson()).toEqual({
      version: 2,
      logLevel: "info",
      futureRoot: { a: 1 },
      hostLogLevel: "debug",
    });
  });

  it("falls back for unsupported values without overwriting the raw value", async () => {
    await writeDiagnosticsRaw(
      JSON.stringify({ version: 1, logLevel: "verbose" }),
    );

    const raw = await readDiagnosticsRaw();
    const effective = resolveDiagnosticsEffective(
      raw,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(effective.general).toMatchObject({
      level: "info",
      source: "unsupported-raw",
      configuredValue: "verbose",
    });
    expect(await readDiagnosticsJson()).toMatchObject({ logLevel: "verbose" });
  });

  it("expires temporary general level back to the permanent level without a write", async () => {
    await setDiagnosticsLogLevel("warn");
    await setTemporaryDiagnosticsLogLevel({
      level: "debug",
      expiresAt: "2026-01-01T00:30:00.000Z",
      reason: "support",
    });

    const raw = await readDiagnosticsRaw();
    expect(
      resolveDiagnosticsEffective(raw, new Date("2026-01-01T00:10:00.000Z"))
        .general,
    ).toMatchObject({
      level: "debug",
      source: "temporary",
      expiresAt: "2026-01-01T00:30:00.000Z",
    });
    expect(
      resolveDiagnosticsEffective(raw, new Date("2026-01-01T00:31:00.000Z"))
        .general,
    ).toMatchObject({
      level: "warn",
      source: "expired-ignored",
      expiresAt: "2026-01-01T00:30:00.000Z",
    });
  });

  it("labels host inheritance from an active general temporary override", async () => {
    await setTemporaryDiagnosticsLogLevel({
      level: "debug",
      expiresAt: "2026-01-01T00:30:00.000Z",
      reason: undefined,
    });

    const effective = resolveDiagnosticsEffective(
      await readDiagnosticsRaw(),
      new Date("2026-01-01T00:10:00.000Z"),
    );

    expect(effective.host).toMatchObject({
      level: "debug",
      source: "temporary-inherited",
    });
  });

  it("supports temporary host inheritance from the effective general level", async () => {
    await setDiagnosticsLogLevel("warn");
    await setTemporaryHostDiagnosticsLogLevel({
      level: "inherit",
      expiresAt: "2026-01-01T00:30:00.000Z",
      reason: undefined,
    });

    const effective = resolveDiagnosticsEffective(
      await readDiagnosticsRaw(),
      new Date("2026-01-01T00:10:00.000Z"),
    );

    expect(effective.host).toMatchObject({
      level: "warn",
      source: "temporary-inherited",
      configuredValue: "inherit",
    });
  });

  it("clears temporary overrides without changing permanent settings", async () => {
    await setDiagnosticsLogLevel("warn");
    await setHostDiagnosticsLogLevel("error");
    await setTemporaryDiagnosticsLogLevel({
      level: "debug",
      expiresAt: "2026-01-01T00:30:00.000Z",
      reason: undefined,
    });
    await setTemporaryHostDiagnosticsLogLevel({
      level: "trace",
      expiresAt: "2026-01-01T00:30:00.000Z",
      reason: undefined,
    });

    await clearTemporaryDiagnosticsLogLevels();

    expect(await readDiagnosticsJson()).toMatchObject({
      version: 1,
      logLevel: "warn",
      hostLogLevel: "error",
    });
    expect(await readDiagnosticsJson()).not.toHaveProperty("temporaryLogLevel");
    expect(await readDiagnosticsJson()).not.toHaveProperty(
      "temporaryHostLogLevel",
    );
  });

  it("clears temporary overrides one scope at a time", async () => {
    await setTemporaryDiagnosticsLogLevel({
      level: "debug",
      expiresAt: "2026-01-01T00:30:00.000Z",
      reason: undefined,
    });
    await setTemporaryHostDiagnosticsLogLevel({
      level: "trace",
      expiresAt: "2026-01-01T00:30:00.000Z",
      reason: undefined,
    });

    await clearTemporaryDiagnosticsLogLevel();

    expect(await readDiagnosticsJson()).not.toHaveProperty("temporaryLogLevel");
    expect(await readDiagnosticsJson()).toMatchObject({
      temporaryHostLogLevel: {
        level: "trace",
        expiresAt: "2026-01-01T00:30:00.000Z",
      },
    });

    await clearTemporaryHostDiagnosticsLogLevel();

    expect(await readDiagnosticsJson()).not.toHaveProperty(
      "temporaryHostLogLevel",
    );
  });

  it("preserves unknown temporary metadata when updating the same temporary object", async () => {
    await writeDiagnosticsRaw(
      JSON.stringify({
        version: 1,
        temporaryLogLevel: {
          level: "debug",
          expiresAt: "2026-01-01T00:30:00.000Z",
          reason: "old",
          futureMeta: "kept",
        },
      }),
    );

    await setTemporaryDiagnosticsLogLevel({
      level: "trace",
      expiresAt: "2026-01-01T00:10:00.000Z",
      reason: undefined,
    });

    expect(await readDiagnosticsJson()).toMatchObject({
      temporaryLogLevel: {
        level: "trace",
        expiresAt: "2026-01-01T00:10:00.000Z",
        futureMeta: "kept",
      },
    });
    expect((await readDiagnosticsJson()).temporaryLogLevel).not.toHaveProperty(
      "reason",
    );
  });

  it("surfaces invalid temporary values in effective state", async () => {
    await setDiagnosticsLogLevel("warn");
    await writeDiagnosticsRaw(
      JSON.stringify({
        version: 1,
        logLevel: "warn",
        temporaryLogLevel: {
          level: "debug",
          expiresAt: "not-a-date",
        },
      }),
    );

    const effective = resolveDiagnosticsEffective(
      await readDiagnosticsRaw(),
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(effective.general).toMatchObject({
      level: "warn",
      source: "invalid-raw",
      configuredValue: {
        level: "debug",
        expiresAt: "not-a-date",
      },
    });
  });

  it("preserves invalid inherited general state on the host scope", async () => {
    await writeDiagnosticsRaw(
      JSON.stringify({
        version: 1,
        logLevel: "verbose",
      }),
    );

    const effective = resolveDiagnosticsEffective(
      await readDiagnosticsRaw(),
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(effective.general.source).toBe("unsupported-raw");
    expect(effective.host).toMatchObject({
      level: "info",
      source: "unsupported-raw",
    });
  });

  it("resets both scopes", async () => {
    await setDiagnosticsLogLevel("warn");
    await setHostDiagnosticsLogLevel("error");

    await resetDiagnosticsConfig();

    expect(await readDiagnosticsJson()).toEqual({ version: 1 });
  });

  it("can reset only the host scope", async () => {
    await setDiagnosticsLogLevel("warn");
    await setHostDiagnosticsLogLevel("error");

    await patchDiagnosticsConfig({
      ...EMPTY_DIAGNOSTICS_PATCH,
      resetHost: true,
    });

    expect(await readDiagnosticsJson()).toEqual({
      version: 1,
      logLevel: "warn",
    });
  });

  it("serializes concurrent patches so independent changes are merged", async () => {
    await Promise.all([
      patchDiagnosticsConfig({
        ...EMPTY_DIAGNOSTICS_PATCH,
        logLevel: "debug",
      }),
      patchDiagnosticsConfig({
        ...EMPTY_DIAGNOSTICS_PATCH,
        hostLogLevel: "warn",
      }),
    ]);

    expect(await readDiagnosticsJson()).toMatchObject({
      version: 1,
      logLevel: "debug",
      hostLogLevel: "warn",
    });
  });

  it("treats corrupt diagnostics JSON as defaults without touching shell config", async () => {
    await mkdir(dirname(cliConfigPath()), { recursive: true });
    await writeFile(
      cliConfigPath(),
      JSON.stringify({
        version: 1,
        shell: { path: "/bin/zsh", args: ["-i"] },
        envOverrides: { FOO: "bar" },
      }),
    );
    await writeDiagnosticsRaw("{ invalid");

    const raw = await readDiagnosticsRaw();
    const effective = resolveDiagnosticsEffective(
      raw,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(raw.readStatus).toBe("corrupt");
    expect(effective.general.level).toBe("info");
    expect(await readCliConfig()).toEqual({
      version: 1,
      shell: { path: "/bin/zsh", args: ["-i"] },
      envOverrides: { FOO: "bar" },
    });
  });
});
