import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SECOND needs-reauth marker, and the one doctor could not see.
 *
 * `<host home>/auth/needs-reauth.json` (already probed) says the host's own
 * delegated credential was burned and a connected owner client has to mint a
 * replacement. `<identity home>/identity/needs-reauth.json` says something
 * else entirely: the host's coordination identity paused after a credential
 * refresh was rejected, and it un-pauses on its own the moment a user bearer
 * newer than the marker lands in the shared CLI credentials file - i.e. when
 * somebody signs in again here. Same filename, different plane, opposite
 * repair. A report that folds them together sends half its readers to a fix
 * that cannot work.
 *
 * The harder half is what this probe is NOT allowed to conclude. A host
 * resolves its identity home as `devIdentityHomeOverride ?? <host home>`, and
 * the override is installed inside the host process by the dev identity pool
 * walk - not in a file, not in an env var this CLI is spawned with. So on an
 * ELIGIBLE machine, "no marker in the default identity home" means this probe
 * looked somewhere the host may not be, and an ENOENT-is-clean answer there
 * would report a stranded dev-pool host as healthy. That is the environment
 * the original incident was filed from.
 *
 * "Eligible" is load-bearing in both directions, which is why the scope rows
 * below run on a `dev` fixture and one row deliberately runs on production:
 * the host's own walk is `not-applicable` outside a dev build, so a production
 * doctor is definitive about the default identity home even on a developer's
 * machine that carries a pool.
 */

// `store/paths` binds its home root from `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DEV_DESKTOP_SLOT = process.env.DEV_DESKTOP_SLOT;

const IDENTITY_CODE = "HOST_IDENTITY_NEEDS_REAUTH";
const IDENTITY_DIR_CODE = "HOST_IDENTITY_DIR_INACCESSIBLE";
const UNVERIFIED_CODE = "HOST_IDENTITY_HOME_UNVERIFIED";
const CREDENTIAL_CODE = "HOST_CREDENTIAL_NEEDS_REAUTH";

/**
 * A `make dev-desktop` run slot, for the two rows that exercise one. Chosen so
 * `sanitizeDevDesktopSlot` maps it to itself, which is what lets the fixture
 * spell the resulting paths literally instead of re-deriving them.
 */
const DEV_RUN_SLOT = "doctor-run-slot";

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-identity-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  // A dev-desktop slot moves `hostHomeDir("dev")` to `host/dev-runs/<slot>`
  // and takes the fixture's paths with it. Most rows here are about the plain
  // dev home, so the variable is cleared rather than left to whatever launched
  // the test runner; the two rows that DO exercise a slot set it themselves
  // and are named for it.
  delete process.env.DEV_DESKTOP_SLOT;
  vi.resetModules();
});

afterEach(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("USERPROFILE", ORIGINAL_USERPROFILE);
  restoreEnv("DEV_DESKTOP_SLOT", ORIGINAL_DEV_DESKTOP_SLOT);
  rmSync(workHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
});

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

/**
 * A host whose every OTHER probe reads healthy, so the identity plane is the
 * only thing these rows are looking at. No pid metadata, so no host process is
 * alive - the arm that says the authoritative check could not run at all.
 */
function stageHostNotRunning(environment: string): void {
  stageInstalledHost(environment);
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => null,
  }));
  stageServiceState("stopped");
}

/**
 * The same machine with a LIVE host process, staged the way
 * `engine-layer0-degraded` stages one: a real pid.json read by the real
 * reader, carrying this process's own pid so `isProcessAlive` agrees. The
 * endpoint deliberately points at a port nothing listens on - reachability is
 * not what the identity probe keys on, and the unreachable-endpoint issue that
 * follows is asserted around rather than suppressed.
 */
function stageHostRunning(environment: string): void {
  stageInstalledHost(environment);
  const hostRoot = hostHomeFor(environment);
  mkdirSync(hostRoot, { recursive: true });
  writeFileSync(
    join(hostRoot, "pid.json"),
    JSON.stringify({
      pid: process.pid,
      hostId: "host-under-audit",
      version: "1.4.0",
      websocketUrl: "ws://127.0.0.1:1/rpc",
      startedAt: "2026-08-22T00:00:00.000Z",
      processStartTimeMs: 1_700_000_000_000,
    }),
    "utf8",
  );
  stageServiceState("running");
}

function stageInstalledHost(environment: string): void {
  const hostExecutablePath = join(workHome, "host-bin", "host");
  mkdirSync(join(workHome, "host-bin"), { recursive: true });
  writeFileSync(hostExecutablePath, "host-bin");
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.4.0",
      environment,
      executablePath: hostExecutablePath,
      installedAt: "2026-04-01T00:00:00Z",
      source: "registry",
      archiveSha256: "f".repeat(64),
      signatureKeyId: "registry:prod-2026",
    }),
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [],
  }));
}

function stageServiceState(state: string): void {
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state,
        version: "1.4.0",
        listenUrl: null,
        pid: state === "running" ? process.pid : null,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
    }),
    serviceLabelFor: (environment: string) => ({
      id: `ai.traycer.host.${environment}`,
    }),
  }));
}

/** What `store/paths.hostHomeDir` resolves with no dev-desktop slot set. */
function hostHomeFor(environment: string): string {
  const base = join(workHome, ".traycer", "host");
  return environment === "production" ? base : join(base, environment);
}

/**
 * `~/.traycer/host/dev-runs/<slot>` - what `hostHomeDir("dev")` resolves to
 * INSTEAD of the plain dev home while `DEV_DESKTOP_SLOT` is set, and therefore
 * what {@link identityDir}'s slot-less spelling deliberately does not cover.
 */
function devRunHomeFor(slot: string): string {
  return join(workHome, ".traycer", "host", "dev-runs", slot);
}

/** `<run home>/identity` - the identity subtree of one dev-desktop run. */
function devRunIdentityDir(slot: string): string {
  return join(devRunHomeFor(slot), "identity");
}

/** `<host home>/identity` - the DEFAULT identity home's identity subtree. */
function identityDir(environment: string): string {
  return join(hostHomeFor(environment), "identity");
}

/** `<host home>/auth` - the other plane, for the both-markers row. */
function authDir(environment: string): string {
  return join(hostHomeFor(environment), "auth");
}

/**
 * `~/.traycer/host/dev/identities` - one per machine, and deliberately NOT
 * environment-scoped: the pool always sits at the plain `dev` home, which is
 * why a production doctor can see it and must still ignore it.
 */
function devIdentityPoolRoot(): string {
  return join(workHome, ".traycer", "host", "dev", "identities");
}

function writeIdentityMarker(environment: string, marker: unknown): void {
  writeIdentityMarkerInto(identityDir(environment), marker);
}

/** Seats an identity marker in an identity subtree named outright. */
function writeIdentityMarkerInto(
  identityDirPath: string,
  marker: unknown,
): void {
  mkdirSync(identityDirPath, { recursive: true });
  writeFileSync(
    join(identityDirPath, "needs-reauth.json"),
    JSON.stringify(marker),
  );
}

function writeCredentialMarker(environment: string, marker: unknown): void {
  mkdirSync(authDir(environment), { recursive: true });
  writeFileSync(
    join(authDir(environment), "needs-reauth.json"),
    JSON.stringify(marker),
  );
}

/**
 * A dev identity pool with one identity seated in it - the machine shape that
 * makes an overridden identity home possible at all.
 */
function stageDevIdentityPool(name: string): void {
  mkdirSync(join(devIdentityPoolRoot(), name), { recursive: true });
}

async function runDoctorFor(environment: string): Promise<
  readonly {
    readonly code: string;
    readonly severity: string;
    readonly message: string;
    readonly fixAction: string | null;
    readonly terminalCommand: string | null;
    readonly details: Record<string, unknown> | null;
  }[]
> {
  const { runDoctor } = await import("../engine");
  const result = await runDoctor({
    environment,
    // Deterministic: never shell out to lsof from a unit row.
    portConflictDeps: { runCommand: async () => null, platform: "darwin" },
  });
  return result.issues;
}

describe("runDoctor host identity needs-reauth", () => {
  it("names the paused identity, carrying the marker's own reason and timestamp", async () => {
    stageHostNotRunning("production");
    writeIdentityMarker("production", {
      version: 1,
      reason: "refresh-rejected",
      since: "2026-08-21T15:12:00.000Z",
    });

    const issues = await runDoctorFor("production");

    const issue = issues.find((i) => i.code === IDENTITY_CODE);
    expect(issue).toBeDefined();
    // Error, not warning: the host's remote plane is down right now.
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("refresh-rejected");
    expect(issue?.message).toContain("2026-08-21T15:12:00.000Z");
    expect(issue?.details).toMatchObject({
      reason: "refresh-rejected",
      since: "2026-08-21T15:12:00.000Z",
      markerReadable: true,
      plane: "identity",
      scope: "default-identity-home",
      authoritative: false,
    });
  });

  it("names the recovery that applies to THIS plane, and rules out the other one", async () => {
    // The whole reason this is a separate issue. Signing in again IS the
    // repair here - the pause watches the CLI login file for a bearer issued
    // after the marker - and it is precisely what does NOT repair a burned
    // delegated credential. Asserted rather than left to prose because the
    // message is the entire recovery path a reader gets.
    stageHostNotRunning("production");
    writeIdentityMarker("production", {
      version: 1,
      reason: "refresh-burned",
      since: "2026-08-21T15:12:00.000Z",
    });

    const issues = await runDoctorFor("production");
    const issue = issues.find((i) => i.code === IDENTITY_CODE);

    expect(issue?.message).toContain("traycer login");
    expect(issue?.message).toContain("shared CLI credentials file");
    // Unlike the auth plane's card, this button does the thing the card
    // describes, so it is offered.
    expect(issue?.terminalCommand).toBe("traycer login");
    expect(issue?.fixAction).toBeNull();
    // The disambiguation, in the copy itself.
    expect(issue?.message).toContain("HOST_CREDENTIAL_NEEDS_REAUTH");
  });

  it("reports BOTH planes as two distinct issues when both markers are set", async () => {
    // Never one conflated verdict: two faults, two repairs, and the auth
    // plane's own verdict is untouched by the identity probe running.
    stageHostNotRunning("production");
    writeIdentityMarker("production", {
      version: 1,
      reason: "refresh-rejected",
      since: "2026-08-21T15:12:00.000Z",
    });
    writeCredentialMarker("production", {
      reason: "a freshly refreshed credential was itself rejected",
      recordedAt: "2026-08-20T09:00:00.000Z",
      hostId: "h",
      ownerUserId: "u",
    });

    const issues = await runDoctorFor("production");

    const identity = issues.find((i) => i.code === IDENTITY_CODE);
    const credential = issues.find((i) => i.code === CREDENTIAL_CODE);
    expect(identity).toBeDefined();
    expect(credential).toBeDefined();
    // Each carries its OWN marker's diagnostics, not the other's.
    expect(identity?.details).toMatchObject({
      reason: "refresh-rejected",
      since: "2026-08-21T15:12:00.000Z",
    });
    expect(credential?.details).toMatchObject({
      reason: "a freshly refreshed credential was itself rejected",
      recordedAt: "2026-08-20T09:00:00.000Z",
    });
    // And the recoveries point in opposite directions.
    expect(identity?.terminalCommand).toBe("traycer login");
    expect(credential?.terminalCommand).toBeNull();
    expect(credential?.message).toContain("open the Traycer desktop app");
    // Exactly one of each - substituted nowhere, duplicated nowhere.
    expect(issues.filter((i) => i.code === IDENTITY_CODE)).toHaveLength(1);
    expect(issues.filter((i) => i.code === CREDENTIAL_CODE)).toHaveLength(1);
  });

  it("still reports a present-but-malformed marker, with unknown diagnostics", async () => {
    // Present is the verdict; the contents are diagnostics. Tolerating a
    // truncated or hand-edited marker means "do not crash", not "report
    // clean".
    stageHostNotRunning("production");
    mkdirSync(identityDir("production"), { recursive: true });
    writeFileSync(
      join(identityDir("production"), "needs-reauth.json"),
      "{not json",
    );

    const issues = await runDoctorFor("production");

    const issue = issues.find((i) => i.code === IDENTITY_CODE);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.details).toMatchObject({
      reason: "unknown",
      since: "unknown",
      markerReadable: false,
    });
  });

  it("reads the identity marker's OWN field names, not the auth marker's", async () => {
    // The two markers do not agree on their field names - `since` here,
    // `recordedAt` there - so a shared parser would silently report `unknown`
    // for whichever plane it was not written for, on a marker that is
    // perfectly readable.
    stageHostNotRunning("production");
    writeIdentityMarker("production", {
      version: 1,
      reason: "refresh-burned",
      since: "2026-08-21T15:12:00.000Z",
      recordedAt: "2026-01-01T00:00:00.000Z",
    });

    const issues = await runDoctorFor("production");

    expect(issues.find((i) => i.code === IDENTITY_CODE)?.details).toMatchObject(
      { since: "2026-08-21T15:12:00.000Z", markerReadable: true },
    );
  });

  it("still reports the pause when the directory is fine and only the MARKER is unreadable", async () => {
    // A non-ENOENT read failure over a perfectly searchable directory is a
    // marker we cannot rule out - non-clean, and distinct from the
    // dir-inaccessible answer below. Reproduced with a DIRECTORY standing
    // where the marker file belongs, so the read fails non-ENOENT without
    // chmod (which root and some CI filesystems ignore).
    stageHostNotRunning("production");
    mkdirSync(join(identityDir("production"), "needs-reauth.json"), {
      recursive: true,
    });

    const issues = await runDoctorFor("production");

    const issue = issues.find((i) => i.code === IDENTITY_CODE);
    expect(issue).toBeDefined();
    expect(issue?.details).toMatchObject({
      reason: "unknown",
      since: "unknown",
      markerReadable: false,
    });
    expect(issues.some((i) => i.code === IDENTITY_DIR_CODE)).toBe(false);
    expect(issues.some((i) => i.code === UNVERIFIED_CODE)).toBe(false);
  });

  it("reads the marker from the dev-desktop RUN home when a slot is set", async () => {
    // The first half of the one asymmetry in this feature. The marker path
    // resolves through `hostHomeDir`, so a `make dev-desktop` run moves it to
    // `host/dev-runs/<slot>/identity` - while the pool root the scope caption
    // reads stays at the plain `host/dev/identities` (pinned by the sibling
    // row in the scope suite). The plain dev home is written here too, with a
    // DIFFERENT reason: it is another run's tree, so a marker-path resolution
    // that lost its slot-awareness would find that one and be caught by the
    // reason rather than merely by the absence of an issue.
    //
    // The slot is set here and nowhere else; the suite's `afterEach` restores
    // the launching environment's value and `beforeEach` clears it, so it
    // cannot reach a sibling row even if this one throws.
    process.env.DEV_DESKTOP_SLOT = DEV_RUN_SLOT;
    stageHostNotRunning("dev");
    stageDevIdentityPool("machine");
    writeIdentityMarkerInto(devRunIdentityDir(DEV_RUN_SLOT), {
      version: 1,
      reason: "refresh-rejected",
      since: "2026-08-21T15:12:00.000Z",
    });
    writeIdentityMarker("dev", {
      version: 1,
      reason: "other-run-marker",
      since: "2026-01-01T00:00:00.000Z",
    });

    const issues = await runDoctorFor("dev");

    const issue = issues.find((i) => i.code === IDENTITY_CODE);
    expect(issue).toBeDefined();
    expect(issue?.details).toMatchObject({
      markerPath: join(devRunIdentityDir(DEV_RUN_SLOT), "needs-reauth.json"),
      identityDirPath: devRunIdentityDir(DEV_RUN_SLOT),
      // This run's marker, not the plain dev home's.
      reason: "refresh-rejected",
      since: "2026-08-21T15:12:00.000Z",
      markerReadable: true,
    });
    expect(issue?.message).toContain(devRunIdentityDir(DEV_RUN_SLOT));
    // A marker that WAS found is the answer; the caption is for absence only.
    expect(issues.some((i) => i.code === UNVERIFIED_CODE)).toBe(false);
  });
});

/**
 * The scope caption, and why silence is not always available here.
 *
 * The caption is owed only to a host that could ACTUALLY have taken a pool
 * identity, and two independent negatives rule that out. Either one alone is
 * enough to make the absence just read the whole answer:
 *
 *   1. the environment is not `dev` - the host's own walk opens with
 *      `config.environment !== "dev" -> not-applicable`, so a production host
 *      always falls back to its own host home; and
 *   2. there is no pool - nothing has been seated under the pool root, so
 *      there is no other identity home to have taken.
 *
 * Both directions are the same failure wearing different clothes: captioning
 * an ineligible host is permanent false noise, and staying silent for an
 * eligible one reports a stranded host clean. These rows pin both.
 */
describe("runDoctor identity-home scope", () => {
  it("stays silent on a dev machine with no identity pool", async () => {
    // Eligible environment, but nothing to be uncertain about: with no pool,
    // no host here can hold an overridden identity home, so the default one is
    // the only one and this probe just answered for it.
    stageHostNotRunning("dev");

    const issues = await runDoctorFor("dev");

    expect(issues.some((i) => i.code === UNVERIFIED_CODE)).toBe(false);
    expect(issues.some((i) => i.code === IDENTITY_CODE)).toBe(false);
    expect(issues.some((i) => i.code === IDENTITY_DIR_CODE)).toBe(false);
  });

  it("stays silent when the pool root exists but is empty", async () => {
    // The directory outlives the identities in it. A pool holding nothing
    // cannot have given a host an identity home, so it proves nothing and must
    // not manufacture a caption.
    stageHostNotRunning("dev");
    mkdirSync(devIdentityPoolRoot(), { recursive: true });

    const issues = await runDoctorFor("dev");

    expect(issues.some((i) => i.code === UNVERIFIED_CODE)).toBe(false);
  });

  it("stays silent for a PRODUCTION doctor even when the machine carries a dev pool", async () => {
    // The regression this gate's second half exists for. One developer's
    // internal `make dev-desktop` pool sits in the same `~/.traycer` tree as
    // their production host - but a production host's pool walk is
    // `not-applicable` before it looks at anything, so it always falls back to
    // its own host home. Captioning here would tell every such machine,
    // forever, that a home it definitively answered for was not verified.
    stageHostNotRunning("production");
    stageDevIdentityPool("machine");

    const issues = await runDoctorFor("production");

    expect(issues.some((i) => i.code === UNVERIFIED_CODE)).toBe(false);
    // ...and the probe is still doing its job on that same machine: the
    // definitive answer is silence, not absence of a check.
    expect(issues.some((i) => i.code === IDENTITY_CODE)).toBe(false);
  });

  it("refuses to read clean on an eligible dev-pool machine with no host running", async () => {
    // The acceptance case, negative half: the marker this probe cannot see
    // would be under the pool identity's own home, and no host is up to ask.
    stageHostNotRunning("dev");
    stageDevIdentityPool("machine");

    const issues = await runDoctorFor("dev");

    const issue = issues.find((i) => i.code === UNVERIFIED_CODE);
    expect(issue).toBeDefined();
    // Info: nothing is claimed to be wrong. It is a caption on the report's
    // coverage, so it must not flip `traycer host doctor`'s exit code.
    expect(issue?.severity).toBe("info");
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
    expect(issue?.message).toContain(devIdentityPoolRoot());
    expect(issue?.message).toContain("No host process is running");
    expect(issue?.details).toMatchObject({
      devIdentityPoolRoot: devIdentityPoolRoot(),
      environment: "dev",
      hostProcessAlive: false,
      plane: "identity",
      scope: "default-identity-home",
      authoritative: false,
    });
    // Emphatically NOT the assertion: nothing here says the identity is
    // paused, only that this check cannot say it is not.
    expect(issues.some((i) => i.code === IDENTITY_CODE)).toBe(false);
  });

  it("defers to the running host's own answer when one is up", async () => {
    // The acceptance case, positive half. The authority exists and only it
    // resolves the live identity home, so the caption points the reader at it
    // rather than at a location this probe already knows may be the wrong one.
    stageHostRunning("dev");
    stageDevIdentityPool("aux-0");

    const issues = await runDoctorFor("dev");

    const issue = issues.find((i) => i.code === UNVERIFIED_CODE);
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("host.doctor");
    expect(issue?.details).toMatchObject({
      environment: "dev",
      hostProcessAlive: true,
    });
  });

  it("captions rather than falls silent when the pool root cannot be read at all", async () => {
    // The fail-safe direction, and the one a later cleanup is most likely to
    // soften: this gate decides whether the CLI may stay QUIET, so "I could
    // not tell whether a pool exists" must never resolve to quiet. Reproduced
    // with a regular FILE standing where the pool root belongs, so `readdir`
    // fails ENOTDIR - non-ENOENT, exactly as it does on an unreadable
    // directory, and unlike chmod it cannot be ignored by root or by a
    // permission-flattening CI filesystem.
    stageHostNotRunning("dev");
    mkdirSync(join(workHome, ".traycer", "host", "dev"), { recursive: true });
    writeFileSync(devIdentityPoolRoot(), "not a directory");

    const issues = await runDoctorFor("dev");

    const issue = issues.find((i) => i.code === UNVERIFIED_CODE);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("info");
  });

  it("still finds the machine-wide pool from inside a dev-desktop run slot", async () => {
    // The second half of the asymmetry, and the half nothing else pins. The
    // two paths this row spans resolve through DIFFERENT rules on purpose:
    // `hostIdentityNeedsReauthPath` follows `hostHomeDir` into
    // `host/dev-runs/<slot>/identity`, while `hostDevIdentityPoolRoot` is
    // fixed at `host/dev/identities` because the pool is one per MACHINE, not
    // one per run. Routing the pool root through `hostHomeDir` too - the
    // tidying this deliberate split invites - would send it looking inside
    // this run's own tree, find nothing, and drop the caption: a stranded
    // dev-pool host reported clean, which is the exact regression the caption
    // exists to prevent. Asserted through the issue's own details so it is
    // production's resolution being pinned, not the fixture's.
    //
    // Slot handling as in the marker row above: set here only, cleared and
    // restored by the suite's hooks.
    process.env.DEV_DESKTOP_SLOT = DEV_RUN_SLOT;
    stageHostNotRunning("dev");
    stageDevIdentityPool("machine");

    const issues = await runDoctorFor("dev");

    const issue = issues.find((i) => i.code === UNVERIFIED_CODE);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("info");
    expect(issue?.details).toMatchObject({
      // Probed inside the run...
      probedIdentityDirPath: devRunIdentityDir(DEV_RUN_SLOT),
      probedMarkerPath: join(
        devRunIdentityDir(DEV_RUN_SLOT),
        "needs-reauth.json",
      ),
      // ...but the pool it weighed that absence against is the machine's.
      devIdentityPoolRoot: devIdentityPoolRoot(),
      environment: "dev",
      hostProcessAlive: false,
    });
    expect(issue?.message).toContain(devIdentityPoolRoot());
    // Nothing was found, so nothing is asserted about the identity itself.
    expect(issues.some((i) => i.code === IDENTITY_CODE)).toBe(false);
  });

  it("reports the marker it DID find even on an eligible pool machine, rather than only the caption", async () => {
    // A marker in the default identity home is real evidence and is not
    // downgraded by the pool's existence; the scope statement rides along in
    // the message instead.
    stageHostNotRunning("dev");
    stageDevIdentityPool("machine");
    writeIdentityMarker("dev", {
      version: 1,
      reason: "refresh-rejected",
      since: "2026-08-21T15:12:00.000Z",
    });

    const issues = await runDoctorFor("dev");

    expect(issues.some((i) => i.code === IDENTITY_CODE)).toBe(true);
    expect(issues.some((i) => i.code === UNVERIFIED_CODE)).toBe(false);
    expect(issues.find((i) => i.code === IDENTITY_CODE)?.message).toContain(
      "host.doctor",
    );
  });
});

/**
 * The third answer, on the identity plane: doctor could not look.
 *
 * Kept apart from both the assertion and the scope caption, because an issue
 * that names a repair must name the one that applies - "I could not read this
 * directory" is a filesystem permission, not a paused identity and not a
 * question about which home the host took.
 */
describe("runDoctor when the host identity directory cannot be inspected", () => {
  it("does NOT claim the identity is paused, and does not report clean either", async () => {
    // A regular FILE where the identity directory belongs: reads under it fail
    // ENOTDIR - non-ENOENT, exactly as they do inside an unsearchable
    // directory - and unlike chmod it cannot be ignored by root or by a
    // permission-flattening CI filesystem.
    stageHostNotRunning("production");
    mkdirSync(join(workHome, ".traycer", "host"), { recursive: true });
    writeFileSync(identityDir("production"), "not a directory");

    const issues = await runDoctorFor("production");

    expect(issues.some((i) => i.code === IDENTITY_CODE)).toBe(false);
    const issue = issues.find((i) => i.code === IDENTITY_DIR_CODE);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
    expect(issue?.message).toContain(identityDir("production"));
    expect(issue?.message).toContain("permissions");
    expect(issue?.details).toMatchObject({
      identityDirPath: identityDir("production"),
      plane: "identity",
    });
  });

  it("answers for the directory even where the caption would not apply", async () => {
    // "Could not look" is not an eligibility question. The environment gate
    // suppresses the SCOPE caption on production; it must not suppress a real
    // filesystem fault, which is why the two are separate codes reached by
    // separate paths.
    stageHostNotRunning("dev");
    mkdirSync(join(workHome, ".traycer", "host", "dev"), { recursive: true });
    writeFileSync(identityDir("dev"), "not a directory");

    const issues = await runDoctorFor("dev");

    expect(issues.some((i) => i.code === IDENTITY_DIR_CODE)).toBe(true);
    expect(issues.some((i) => i.code === UNVERIFIED_CODE)).toBe(false);
  });

  it("leaves the AUTH plane's verdict untouched", async () => {
    // The planes share a filename and nothing else. An identity directory that
    // cannot be read says nothing about the delegated credential, and the
    // auth-plane probe must go on answering for itself.
    stageHostNotRunning("production");
    mkdirSync(join(workHome, ".traycer", "host"), { recursive: true });
    writeFileSync(identityDir("production"), "not a directory");
    writeCredentialMarker("production", {
      reason: "a freshly refreshed credential was itself rejected",
      recordedAt: "2026-08-20T09:00:00.000Z",
      hostId: "h",
      ownerUserId: "u",
    });

    const issues = await runDoctorFor("production");

    expect(issues.some((i) => i.code === IDENTITY_DIR_CODE)).toBe(true);
    expect(issues.some((i) => i.code === CREDENTIAL_CODE)).toBe(true);
    expect(issues.some((i) => i.code === "HOST_AUTH_DIR_INACCESSIBLE")).toBe(
      false,
    );
  });
});
