import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { ProgressInfo } from "../../runner/output";
import type {
  CommandContext,
  CommandFn,
  CommandResult,
} from "../../runner/runner";
import type {
  HostPlatformAsset,
  HostVersionsManifest,
  RegistryClient,
} from "../../registry";
import type { HostInstallRecord } from "../../manifest/host-install";

/**
 * `host available`'s three flag states, driven through the REAL commander
 * tree.
 *
 * The derive state is spelled as an ABSENT commander option, which makes it
 * the one state no source line asserts: it exists only because commander
 * leaves `includePreReleases` unset when a command declares both `--x` and
 * `--no-x` and neither is passed. That is a library rule, and it has not been
 * stable across majors - commander 9.5.0 lets a `--no-x` declared FIRST
 * install an implicit `true` default, so on that version the declaration order
 * in `index.ts` is load-bearing. The CLI resolves 15.0.0, where neither order
 * does that (verified both ways). A dependency bump is therefore the live
 * risk, not a source edit: if the 9.x rule ever returns, "neither flag"
 * silently becomes `true` and every default listing on every host starts
 * including release candidates.
 *
 * So these assert BEHAVIOUR, not registration. The structural suite next door
 * only checks the flag exists; these parse real argv and pin the value that
 * comes out the far end, so a regression anywhere along commander ->
 * `index.ts`'s mapping -> `resolveIncludePreReleases` lands here. Confirmed by
 * mutation: collapsing the mapping back to a plain boolean fails two of them.
 *
 * Deliberately its own file: it has to mock the registry client and the
 * install-record reader to keep the command off the network and off disk, and
 * `cli-entrypoint-registration.test.ts` walks the whole command tree - those
 * mocks have no business being in scope there.
 */
const mocks = vi.hoisted(() => ({
  results: [] as CommandResult[],
  fetchManifestMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
}));

vi.mock("../../registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../registry")>();
  return {
    ...actual,
    createDefaultRegistryClient: async (): Promise<RegistryClient> => ({
      fetchManifest: mocks.fetchManifestMock,
      resolveAsset: vi.fn(),
      downloadAndVerify: vi.fn(),
    }),
    currentHostPlatformKey: () => "darwin-arm64",
  };
});

vi.mock("../../manifest/host-install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../manifest/host-install")>();
  return {
    ...actual,
    readHostInstallRecord: mocks.readHostInstallRecordMock,
  };
});

// Same shape as `cli-entrypoint-registration.test.ts`: replace only
// `runCommand`, which owns `process.exit`, so `parseAsync` can drive the real
// command wiring to completion inside the test process.
vi.mock("../../runner/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runner/runner")>();
  return {
    ...actual,
    runCommand: async (fn: CommandFn) => {
      const ctx: CommandContext = {
        runtime: {
          json: true,
          quiet: false,
          noProgress: true,
          noBootstrap: false,
          nonInteractive: true,
          environment: "production",
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
        },
        output: {
          progress: () => undefined,
          human: () => undefined,
          humanRequired: () => undefined,
          emitResult: () => undefined,
          emitError: () => undefined,
        },
        progress: (_info: ProgressInfo) => undefined,
      };
      mocks.results.push(await fn(ctx));
    },
  };
});

import { buildProgram } from "../../index";

const AVAILABLE_ASSET: HostPlatformAsset = {
  available: true,
  unavailableReason: null,
  url: "https://example.com/traycer-host-macos-arm64.tar.gz",
  sizeBytes: 123,
  sha256: "a".repeat(64),
  signatureUrl: "https://example.com/traycer-host-macos-arm64.tar.gz.minisig",
  signatureAlgorithm: "minisign",
  publicKeyId: "test-key",
};

const MANIFEST: HostVersionsManifest = {
  schemaVersion: 1,
  generatedAt: "2026-06-22T01:00:00.000Z",
  latest: "1.2.0",
  versions: ["2.0.0-rc.2", "1.2.0"].map((version) => ({
    version,
    releasedAt: "2026-06-22T00:00:00.000Z",
    releaseNotesUrl: `https://example.com/${version}`,
    yanked: false,
    deprecationReason: null,
    requiredCliVersion: null,
    minimumEpoch: null,
    platforms: { "darwin-arm64": AVAILABLE_ASSET },
  })),
};

function rcInstallRecord(): HostInstallRecord {
  return {
    installId: "install-1",
    version: "2.0.0-rc.1",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-06-22T00:00:00.000Z",
    source: { kind: "registry", value: "https://example.com/host.tar.gz" },
    archiveSha256: null,
    signatureVerifiedAt: "2026-06-22T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/opt/traycer/host",
    executableSha256: null,
  };
}

function findHostAvailable(program: Command): Command {
  const host = program.commands.find((child) => child.name() === "host");
  expect(host, "'host' command is not registered").toBeDefined();
  const available = host?.commands.find(
    (child) => child.name() === "available",
  );
  expect(available, "'host available' is not registered").toBeDefined();
  if (available === undefined) throw new Error("unreachable");
  return available;
}

/** Runs `host available` with the given extra argv and returns what it emitted. */
async function runHostAvailable(argv: readonly string[]): Promise<{
  readonly parsedOption: unknown;
  readonly data: Record<string, unknown>;
}> {
  mocks.results.length = 0;
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["host", "available", ...argv], { from: "user" });
  expect(mocks.results).toHaveLength(1);
  const data = mocks.results[0].data;
  expect(data).toBeTypeOf("object");
  return {
    parsedOption: findHostAvailable(program).opts().includePreReleases,
    data: data as Record<string, unknown>,
  };
}

function listedVersions(data: Record<string, unknown>): readonly string[] {
  const manifest = data.manifest as HostVersionsManifest;
  return manifest.versions.map((entry) => entry.version);
}

describe("host available flag states through the real commander tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchManifestMock.mockResolvedValue(MANIFEST);
    mocks.readHostInstallRecordMock.mockResolvedValue(rcInstallRecord());
  });

  it("leaves the option undefined with neither flag, and derives from the RC install", async () => {
    // The load-bearing assertion. If commander ever defaults this to `true`,
    // `parsedOption` catches it before the provenance does - and the
    // provenance proves the CLI did not merely guess right by accident.
    const { parsedOption, data } = await runHostAvailable([]);

    expect(parsedOption).toBe(undefined);
    expect(data.includePreReleases).toBe(true);
    expect(data.includePreReleasesSource).toBe("installed-rc");
    expect(listedVersions(data)).toEqual(["2.0.0-rc.2", "1.2.0"]);
  });

  it("parses the positive flag as an explicit include", async () => {
    const { parsedOption, data } = await runHostAvailable([
      "--include-pre-releases",
    ]);

    expect(parsedOption).toBe(true);
    expect(data.includePreReleases).toBe(true);
    expect(data.includePreReleasesSource).toBe("explicit-include");
    expect(mocks.readHostInstallRecordMock).not.toHaveBeenCalled();
  });

  it("parses the negative flag as an explicit exclude that beats the RC install", async () => {
    // Critique finding 7's remedy, end to end: on an RC host, whose derived
    // default includes RCs, the negative flag must still produce a
    // stable-only listing.
    const { parsedOption, data } = await runHostAvailable([
      "--no-include-pre-releases",
    ]);

    expect(parsedOption).toBe(false);
    expect(data.includePreReleases).toBe(false);
    expect(data.includePreReleasesSource).toBe("explicit-exclude");
    expect(listedVersions(data)).toEqual(["1.2.0"]);
    expect(mocks.readHostInstallRecordMock).not.toHaveBeenCalled();
  });

  it("keeps all three states distinct - none collapses into another", async () => {
    // The regression this file exists for is a COLLAPSE: two of the three
    // states quietly becoming one. Asserted together so a reorder that makes
    // "neither" behave like "--include-pre-releases" cannot pass by fixing
    // each case's expectation in isolation.
    const neither = await runHostAvailable([]);
    const positive = await runHostAvailable(["--include-pre-releases"]);
    const negative = await runHostAvailable(["--no-include-pre-releases"]);

    expect([
      neither.parsedOption,
      positive.parsedOption,
      negative.parsedOption,
    ]).toEqual([undefined, true, false]);
    expect([
      neither.data.includePreReleasesSource,
      positive.data.includePreReleasesSource,
      negative.data.includePreReleasesSource,
    ]).toEqual(["installed-rc", "explicit-include", "explicit-exclude"]);
  });

  it("exposes both flags in help so the negative one is discoverable", () => {
    const help = findHostAvailable(buildProgram()).helpInformation();
    expect(help).toContain("--include-pre-releases");
    expect(help).toContain("--no-include-pre-releases");
  });
});
