import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The state this probe exists for is the one where every OTHER probe reads
// healthy. The host is installed, the service is running, the port answers -
// and the host's own delegated credential was refused by the cloud in a way
// refreshing cannot repair, so it burned the credential and fell back to
// whatever bearer a connected client carries. The user sees sign-in-flavoured
// failures on work the host does for them, and neither reloading nor signing
// in again changes what the host spends. Before this, `traycer host doctor`
// said clean.
//
// The marker is the only durable trace, and it is on disk the whole time.

// `store/paths` binds its home root from `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-credential-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
});

/** A fully healthy host, so the credential issue is the only thing reported. */
function stageHealthyHostMocks(): void {
  const hostExecutablePath = join(workHome, "host-bin", "host");
  mkdirSync(join(workHome, "host-bin"), { recursive: true });
  writeFileSync(hostExecutablePath, "host-bin");
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.4.0",
      environment: "production",
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
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => null,
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "stopped",
        version: "1.4.0",
        listenUrl: null,
        pid: null,
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

function hostAuthDir(): string {
  return join(workHome, ".traycer", "host", "auth");
}

/**
 * The host's IDENTITY subtree - the OTHER credential lineage, which this probe
 * deliberately does not read.
 *
 * `host-enroll`'s registration-time device-bound credential lives at
 * `identity/device-credentials.json`
 * (`traycer-host/src/coordination/on-box-credentials.ts:38-50`) and serves the
 * coordination control plane. The delegated `host-delegate` credential this
 * probe reports on lives under `auth/`. The fixture builds BOTH so a probe
 * that confused the two - which a round of this ticket did, on a filename
 * match - cannot pass here.
 */
function hostIdentityDir(): string {
  return join(workHome, ".traycer", "host", "identity");
}

/**
 * A box laid out the way a real one is: the DELEGATED credential under
 * `auth/credentials.json` beside the `jwks.json` that always shares that
 * directory, and the unrelated device-bound credential of the other lineage
 * under `identity/`.
 *
 * Written as a LAYOUT rather than as one file because the near-miss was a
 * layout confusion, and a fixture that creates only the file the code expects
 * can never catch that class - it has to create what the HOST creates,
 * decoys included.
 */
function writeRealBoxCredentialLayout(): void {
  mkdirSync(hostAuthDir(), { recursive: true });
  writeFileSync(
    join(hostAuthDir(), "credentials.json"),
    JSON.stringify({ hostId: "h", ownerUserId: "u" }),
  );
  writeFileSync(join(hostAuthDir(), "jwks.json"), JSON.stringify({ keys: [] }));
  mkdirSync(hostIdentityDir(), { recursive: true });
  writeFileSync(
    join(hostIdentityDir(), "device-credentials.json"),
    JSON.stringify({ hostId: "h", ownerUserId: "u" }),
  );
}

function writeNeedsReauthMarker(marker: unknown): void {
  mkdirSync(hostAuthDir(), { recursive: true });
  writeFileSync(
    join(hostAuthDir(), "needs-reauth.json"),
    JSON.stringify(marker),
  );
}

async function runProductionDoctor() {
  const { runDoctor } = await import("../engine");
  return runDoctor({ environment: "production", portConflictDeps: null });
}

describe("runDoctor host credential needs-reauth", () => {
  it("names the burned credential, carrying the marker's own reason and timestamp", async () => {
    stageHealthyHostMocks();
    writeNeedsReauthMarker({
      reason: "a freshly refreshed credential was itself rejected",
      recordedAt: "2026-08-21T15:12:00.000Z",
      hostId: "11111111-2222-3333-4444-555555555555",
      ownerUserId: "user-a",
    });

    const result = await runProductionDoctor();

    const issue = result.issues.find(
      (i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH",
    );
    expect(issue).toBeDefined();
    // Error, not warning: work the user asked for is failing right now.
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain(
      "a freshly refreshed credential was itself rejected",
    );
    expect(issue?.message).toContain("2026-08-21T15:12:00.000Z");
    // NEITHER, and the terminal command especially: Desktop renders "Open in
    // Terminal" for any non-null `terminalCommand`, and `traycer login` signs
    // the HUMAN in - it cannot provision the HOST's credential, so the button
    // could only ever look like it had failed.
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
    // ...which is exactly why the message has to carry the repair itself, and
    // why that is asserted rather than left to the prose. With both action
    // fields null this text is the whole recovery path the CLI report and
    // Desktop's card can show, and it once ruled out signing in again without
    // ever saying what does work - a dead end that no test noticed, because
    // only a comment claimed the instruction was there.
    expect(issue?.message).toContain("open the Traycer desktop app");
    expect(issue?.message).toContain("provisions a new credential");
    expect(issue?.details).toMatchObject({
      reason: "a freshly refreshed credential was itself rejected",
      recordedAt: "2026-08-21T15:12:00.000Z",
      // The credential file is gone in the ordinary burn: the host deletes it
      // and THEN writes the marker. Carried so a support bundle can tell this
      // apart from the delete-failed shape.
      credentialFilePresent: false,
      markerReadable: true,
    });
  });

  it("reports it on the marker alone, which is the only state a burned host is ever in", async () => {
    // Pins the correction to the ticket's original wording. Requiring the
    // credential FILE alongside the marker would have made this probe
    // unreachable: the host removes the credential before recording the
    // verdict, so the two coexist only when that delete failed - a state the
    // host already self-repairs at its next startup.
    stageHealthyHostMocks();
    writeNeedsReauthMarker({
      reason: "burned",
      recordedAt: "2026-08-21T15:12:00.000Z",
      hostId: "h",
      ownerUserId: "u",
    });

    const result = await runProductionDoctor();

    expect(
      result.issues.some((i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH"),
    ).toBe(true);
  });

  it("reads the DELEGATED credential, not the device-bound one of the other lineage", async () => {
    // Q21 was filed as a defect here and WITHDRAWN: the host has two credential
    // lineages by design, and the report compared this path for one against the
    // host's path for the other. `auth/credentials.json` is correct
    // (`traycer-host/src/auth/host-credential-store.ts:28-29`).
    //
    // The pin stays because the path was unpinned when that happened, and the
    // near-miss is the argument for pinning it: a fixture asserting only the
    // file the code expects could not have told the two lineages apart. This
    // one builds both, so a probe re-pointed at `identity/` - the change the
    // withdrawn report asked for - fails here instead of shipping.
    //
    // Worth knowing for the next reader of the box: `auth/` holding ONLY
    // `jwks.json` is not evidence of a wrong path. It means no connected owner
    // client has ever provisioned a delegated credential, which is the expected
    // state for an unprovisioned host - and mistaking that absence for a defect
    // is the other half of the same error.
    // Falsification (the ablation, run): point `HOST_CREDENTIAL_SUBDIR` /
    // `HOST_CREDENTIAL_FILENAME` at `identity` / `device-credentials.json` and
    // this reddens, while every other pin in this file stays green.
    stageHealthyHostMocks();
    writeRealBoxCredentialLayout();
    writeNeedsReauthMarker({
      reason: "burned",
      recordedAt: "2026-08-21T15:12:00.000Z",
      hostId: "h",
      ownerUserId: "u",
    });

    const result = await runProductionDoctor();

    const issue = result.issues.find(
      (i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH",
    );
    expect(issue?.details).toMatchObject({ credentialFilePresent: true });
  });

  it("control: with the OTHER lineage's credential only, this one reads absent", async () => {
    // What stops the pin above from passing on a probe that simply answered
    // `true`. The device-bound credential is present under `identity/` and the
    // delegated one is not, which is a real state - a host enrolled but never
    // visited by a connected owner client - and the probe must report the
    // delegated credential absent rather than borrowing the other lineage's.
    stageHealthyHostMocks();
    mkdirSync(hostIdentityDir(), { recursive: true });
    writeFileSync(
      join(hostIdentityDir(), "device-credentials.json"),
      JSON.stringify({ hostId: "h" }),
    );
    writeNeedsReauthMarker({
      reason: "burned",
      recordedAt: "2026-08-21T15:12:00.000Z",
      hostId: "h",
      ownerUserId: "u",
    });

    const result = await runProductionDoctor();

    const issue = result.issues.find(
      (i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH",
    );
    expect(issue?.details).toMatchObject({ credentialFilePresent: false });
  });

  it("stays silent for a host with no marker", async () => {
    // The overwhelmingly common case, and the one that must never become
    // noise: a host that has never held a credential, or holds a healthy one,
    // has no marker at all.
    stageHealthyHostMocks();

    const result = await runProductionDoctor();

    expect(
      result.issues.some((i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH"),
    ).toBe(false);
  });

  it("still reports a present-but-malformed marker, with unknown diagnostics", async () => {
    // PRESENT IS THE VERDICT. Tolerating a truncated or hand-edited marker
    // means "do not crash", not "report clean" - the file existing is what
    // says this host burned a credential, and its contents are only ever
    // diagnostics. Reading a malformed marker as ABSENT inverted the contract
    // and hid exactly the fault this probe exists to surface, on the machines
    // most likely to have something wrong with them.
    stageHealthyHostMocks();
    mkdirSync(hostAuthDir(), { recursive: true });
    writeFileSync(join(hostAuthDir(), "needs-reauth.json"), "{not json");

    const result = await runProductionDoctor();

    const issue = result.issues.find(
      (i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH",
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.details).toMatchObject({
      reason: "unknown",
      recordedAt: "unknown",
      // Names which of the two shapes a support bundle is looking at.
      markerReadable: false,
    });
  });

  it("still reports a marker whose JSON is valid but carries no fields", async () => {
    stageHealthyHostMocks();
    mkdirSync(hostAuthDir(), { recursive: true });
    writeFileSync(join(hostAuthDir(), "needs-reauth.json"), "{}");

    const result = await runProductionDoctor();

    const issue = result.issues.find(
      (i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH",
    );
    expect(issue).toBeDefined();
    expect(issue?.details).toMatchObject({
      reason: "unknown",
      recordedAt: "unknown",
    });
  });
});

/**
 * The THIRD answer, and why two were not enough.
 *
 * `readFile(markerPath)` failing for any reason other than ENOENT was read as
 * "the marker is there and we cannot read it" - i.e. as a burn. That inference
 * silently assumes the marker's PARENT was inspectable. On a host whose auth
 * directory is unsearchable (damaged ownership, an ACL, a stray file standing
 * where the directory belongs), every read inside it fails the same way
 * WHETHER OR NOT the file exists - so doctor asserted a burned credential over
 * a directory that may well be empty, and pointed the reader at re-provisioning
 * the host, which does nothing about a filesystem permission.
 *
 * "Only ENOENT is clean" was right about the MARKER. It was wrong to assume the
 * marker's parent is always probeable.
 */
describe("runDoctor when the host auth directory cannot be inspected", () => {
  it("does NOT claim the credential was burned when the directory is unprobeable", async () => {
    // The negative direction, and the whole point: the absence of a readable
    // marker here is not evidence of anything.
    //
    // The fixture puts a regular FILE where the auth directory belongs, which
    // reproduces the shape without chmod - reads under it fail ENOTDIR rather
    // than ENOENT, exactly as they do inside an unsearchable directory, and
    // root and permission-ignoring CI filesystems cannot paper over it.
    stageHealthyHostMocks();
    mkdirSync(join(workHome, ".traycer", "host"), { recursive: true });
    writeFileSync(hostAuthDir(), "not a directory");

    const result = await runProductionDoctor();

    expect(
      result.issues.some((i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH"),
    ).toBe(false);
    const issue = result.issues.find(
      (i) => i.code === "HOST_AUTH_DIR_INACCESSIBLE",
    );
    expect(issue).toBeDefined();
    // Warning, not error: nothing is known to be broken - but nothing is known
    // to be working either, which is why it is not silence.
    expect(issue?.severity).toBe("warning");
    // The repair named must be the one that applies. `fixAction` /
    // `terminalCommand` stay null because no CLI subcommand fixes a
    // permission, and the message has to carry the instruction instead.
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
    expect(issue?.message).toContain(hostAuthDir());
    expect(issue?.message).toContain("permissions");
    expect(issue?.details).toMatchObject({ authDirPath: hostAuthDir() });
  });

  // NOTE ON WHAT IS NOT TESTED HERE, and why. The reviewer's literal case is an
  // EACCES directory, and there is no honest way to reach that errno in this
  // suite: chmod is ignored by root and by several CI filesystems (so the test
  // would pass vacuously exactly where it would otherwise run), and injecting
  // it means mocking `node:fs/promises` for a suite whose engine touches the
  // filesystem for a dozen unrelated probes. The fixture above reaches the SAME
  // branch through ENOTDIR, and that branch is errno-agnostic by construction -
  // `isFileNotFoundError(err) ? "absent" : "unprobeable"` - so EACCES and
  // ENOTDIR cannot diverge without the classifier itself changing, which these
  // cases would catch.

  it("still reports the burn when the directory is fine and only the MARKER is unreadable", async () => {
    // The behaviour the fix must not cost: a probeable directory holding a
    // marker we cannot read is still a burn, with unknown diagnostics.
    // Reproduced with a DIRECTORY standing where the marker file belongs, so
    // the read fails non-ENOENT while its parent is perfectly searchable.
    stageHealthyHostMocks();
    mkdirSync(join(hostAuthDir(), "needs-reauth.json"), { recursive: true });

    const result = await runProductionDoctor();

    const issue = result.issues.find(
      (i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH",
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.details).toMatchObject({
      reason: "unknown",
      recordedAt: "unknown",
      markerReadable: false,
    });
    expect(
      result.issues.some((i) => i.code === "HOST_AUTH_DIR_INACCESSIBLE"),
    ).toBe(false);
  });

  it("stays clean when the auth directory simply does not exist", async () => {
    // A host that has never held a credential has no auth directory at all.
    // That must read as clean, not as "cannot inspect" - the overwhelmingly
    // common case must never become noise.
    stageHealthyHostMocks();

    const result = await runProductionDoctor();

    expect(
      result.issues.some((i) => i.code === "HOST_AUTH_DIR_INACCESSIBLE"),
    ).toBe(false);
    expect(
      result.issues.some((i) => i.code === "HOST_CREDENTIAL_NEEDS_REAUTH"),
    ).toBe(false);
  });
});
