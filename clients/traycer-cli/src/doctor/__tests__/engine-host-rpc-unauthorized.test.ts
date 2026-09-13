import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";

// A host `UNAUTHORIZED` covers two failures with OPPOSITE remedies, and this
// probe used to report only one of them.
//
//   - the stored bearer is dead          → signing in again fixes it
//   - the host holds no credential of
//     its own and refuses every client   → signing in again fixes NOTHING
//
// The second one was reported as "Sign in again", which closes a loop for a
// user who is already signed in: sign in, still rejected, run doctor, be told
// to sign in. That is the same trap `HOST_CREDENTIAL_NEEDS_REAUTH` documents
// on the neighbouring state (a credential that was provisioned and then
// burned), and it is decided the same way - by the presence of the host's
// credential file.

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
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-rpc-unauth-test-"));
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
});

/** The verbatim refusal a host with no delegated credential sends. */
const NOT_PROVISIONED_MESSAGE =
  "Host is not provisioned - run `traycer login` on the host machine to authorize it";

function unauthorizedError(message: string): HostRpcError {
  return new HostRpcError({
    code: "UNAUTHORIZED",
    message,
    requestId: "req-1",
    method: "host.status",
    fatalDetails: null,
  });
}

/** Writes a host credential file, so the host counts as provisioned. */
function writeHostCredential(): void {
  const dir = join(workHome, ".traycer", "host", "auth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credentials.json"), "{}");
}

async function runIssue(err: HostRpcError) {
  const { hostRpcUnauthorizedIssue } = await import("../engine");
  return hostRpcUnauthorizedIssue("ws://127.0.0.1:1234/rpc", err, "production");
}

describe("hostRpcUnauthorizedIssue", () => {
  it("names the unprovisioned host and offers no sign-in command", async () => {
    // No credential file: the host never held one, which is the state where
    // `traycer login` is the one thing that cannot help.
    const issue = await runIssue(unauthorizedError(NOT_PROVISIONED_MESSAGE));

    expect(issue.severity).toBe("error");
    expect(issue.title).toContain("no credential of its own");
    // The whole point of the correction. Desktop renders "Open in Terminal"
    // for any non-null `terminalCommand`, so leaving `traycer login` here
    // would keep offering the button that restarts the loop.
    expect(issue.fixAction).toBeNull();
    expect(issue.terminalCommand).toBeNull();
    // ...which is why the message must carry the repair itself, exactly as
    // HOST_CREDENTIAL_NEEDS_REAUTH does: with both action fields null this
    // text is the entire recovery path a reader gets.
    expect(issue.message).toContain("open the Traycer desktop app");
    // Says plainly that the user's session is not the fault, because the
    // reader has usually just signed in and been rejected anyway.
    expect(issue.message).toContain("signing in again does not change it");
    expect(issue.details).toMatchObject({
      hostCredential: "absent",
      rpcCode: "UNAUTHORIZED",
    });
  });

  it("carries the host's own refusal through instead of dropping it", async () => {
    // The reason was thrown away for the bare status code, which is what left
    // the report unable to tell the two failures apart - and left a support
    // bundle with `outcome: UNAUTHORIZED` and nothing else.
    const issue = await runIssue(unauthorizedError(NOT_PROVISIONED_MESSAGE));

    expect(issue.message).toContain(NOT_PROVISIONED_MESSAGE);
    expect(issue.details).toMatchObject({
      hostMessage: NOT_PROVISIONED_MESSAGE,
    });
  });

  it("keeps the sign-in reading when the host does hold a credential", async () => {
    // The other half of the split, pinned so the correction cannot quietly
    // swallow the case `traycer login` genuinely does repair.
    writeHostCredential();

    const issue = await runIssue(
      unauthorizedError("bearer rejected after refresh"),
    );

    expect(issue.title).toBe("Host rejected the stored credentials");
    expect(issue.terminalCommand).toBe("traycer login");
    expect(issue.details).toMatchObject({ hostCredential: "present" });
  });

  it("reads an unprobeable credential path as 'cannot tell' and keeps the sign-in reading", async () => {
    // Safe direction: a signed-out user is in the sign-in state, so an
    // unreadable path must not be reported as "your session is fine".
    // `hostCredentialPath` resolves under the home root, and pointing the
    // root at a file makes every path beneath it unstattable.
    const notADirectory = join(workHome, "not-a-directory");
    writeFileSync(notADirectory, "");
    osHome.current = notADirectory;
    process.env.HOME = notADirectory;
    process.env.USERPROFILE = notADirectory;

    const issue = await runIssue(unauthorizedError("unreadable"));

    expect(issue.terminalCommand).toBe("traycer login");
    // Reported as "could not look", never as a provisioning verdict.
    expect(issue.details).toMatchObject({ hostCredential: "unprobeable" });
  });
});
