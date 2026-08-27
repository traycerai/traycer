import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectVerifierBeforeEvery,
  sliceFrom,
} from "./source-scan-test-support";

const SHARED_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ROOT = join(SHARED_ROOT, "..", "traycer-cli", "src");
const DESKTOP_ROOT = join(SHARED_ROOT, "..", "desktop", "src", "electron-main");

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("host update final actuator regression boundaries", () => {
  it("revalidates every atomic-swap rename, including rollback", async () => {
    const install = await source(join(CLI_ROOT, "installer", "install.ts"));
    const atomicSwap = sliceFrom(
      install,
      "async function atomicSwap(",
      "// Reads the `version.json` sidecar",
    );

    expect(atomicSwap).toContain("verifyMutationCapability");
    expect(atomicSwap).toMatch(
      /const swapRenamePlan = \{[\s\S]*verifyBeforeAttempt: opts\.verifyMutationCapability/,
    );
    expect(atomicSwap).toContain(
      "await renameWithRetryPlan(target, trash, swapRenamePlan);",
    );
    expect(atomicSwap).toContain(
      "await renameWithRetryPlan(opts.stagingDir, target, swapRenamePlan);",
    );
    expect(atomicSwap).toMatch(
      /await renameWithRetryPlan\(trash, target, \{[\s\S]*verifyBeforeAttempt: opts\.verifyMutationCapability,/,
    );
  });

  it("revalidates each stage-promotion rename and aside invalidation", async () => {
    const downloadStage = await source(
      join(CLI_ROOT, "installer", "download-stage.ts"),
    );
    // `replaceStagedDirWithAttempt` is a thin wrapper (contender options in,
    // one delegated call out) - the actual renames and the aside invalidation
    // it exists to guard live in `replaceStagedDir`, which it calls. The
    // non-empty-actuator-offsets guard in `expectVerifierBeforeEvery` is what
    // caught this suite pointing at the wrong function: the wrapper's body
    // contains no `renameWithRetry(`/`invalidateAsideDir(` calls at all, so
    // the old (pre-guard) version of this test passed vacuously on zero
    // matches.
    const promotion = sliceFrom(
      downloadStage,
      "async function replaceStagedDir(",
      "// The one shape every stage-maintenance leg shares.",
    );

    expect(promotion).toContain("verifyMutationCapability");
    expectVerifierBeforeEvery(
      promotion,
      /(?:renameWithRetry|invalidateAsideDir)\(/,
      /await (?:requireCliUpdateMutationCapability|verifyMutationCapability)\(/,
    );
  });

  it("keeps purge, stamp, and free-port raw actuators behind a final verifier", async () => {
    const commands = await Promise.all(
      ["host-purge-stage.ts", "host-stamp-runtime.ts", "host-free-port.ts"].map(
        (name) =>
          source(join(CLI_ROOT, "commands", name)).then(
            (text) => [name, text] as const,
          ),
      ),
    );

    for (const [name, text] of commands) {
      expect(
        text.includes("requireCliUpdateMutationCapability") ||
          text.includes("withCliAttemptMutation"),
        `${name} has no final capability boundary`,
      ).toBe(true);
    }
  });

  it("guards every Desktop registration and unregistration actuator", async () => {
    const loginItem = await source(
      join(DESKTOP_ROOT, "app", "host-login-item.ts"),
    );
    const register = sliceFrom(
      loginItem,
      "async function registerHostLoginItemUnserialized(",
      "async function retireLegacyLabelRegistrations",
    );
    const retireLegacy = sliceFrom(
      loginItem,
      "async function retireLegacyLabelRegistrations(",
      "// Whether the competing CLI manifest is there",
    );
    const unregister = sliceFrom(
      loginItem,
      "async function unregisterHostLoginItemUnserialized(",
      "async function setLoginItemSettingsWithGuard(",
    );
    const bootout = sliceFrom(
      loginItem,
      "async function bootoutStaleAgent(",
      "export function runLaunchctlBootout(",
    );
    const settingsGuard = sliceFrom(
      loginItem,
      "async function setLoginItemSettingsWithGuard(",
      "async function pollRegisterStatusUntilSettled(",
    );

    expect(register).toMatch(
      /revalidateBefore[A-Za-z]+|verifyMutationCapability/,
    );
    expect(unregister).toMatch(
      /revalidateBefore[A-Za-z]+|verifyMutationCapability/,
    );
    for (const body of [register, retireLegacy, unregister]) {
      expect(body).toMatch(
        /setLoginItemSettingsWithGuard\([\s\S]*revalidateBefore[A-Za-z]+/,
      );
    }
    expect(retireLegacy).toMatch(
      /revalidateBefore(?:Bootout|Mutation)|mutationAllowed|verifyMutationCapability/,
    );
    expect(settingsGuard).toMatch(/await mutationAllowed\(/);
    expect(settingsGuard.indexOf("await mutationAllowed(")).toBeLessThan(
      settingsGuard.indexOf("app.setLoginItemSettings("),
    );
    expectVerifierBeforeEvery(
      bootout,
      /runLaunchctlBootout\(/,
      /await mutationAllowed\(/,
    );
  });

  it("keeps active-attempt subprocess errors distinct from E_HOST_BUSY, inside the one classifier every mutation route shares", async () => {
    const controller = await source(
      join(DESKTOP_ROOT, "host", "host-controller.ts"),
    );
    expect(controller).toContain('"E_HOST_UPDATE_ATTEMPT_ACTIVE"');
    expect(controller).toContain("HOST_UPDATE_ATTEMPT_ACTIVE_CODE");

    // Narrowed to the classifier's OWN body (rather than whole-file
    // `toContain` checks, which pass on a match anywhere in the file and
    // prove nothing about this specific function): the active-attempt code
    // must be classified BEFORE the generic host-busy code, so a durable
    // coordination refusal is never mistaken for an ordinary workload-busy
    // condition a Force action could retry.
    const classifier = sliceFrom(
      controller,
      "private classifyMutationSubprocessError<",
      "// ---- stageLatest",
    );
    expect(classifier).toContain("HOST_UPDATE_ATTEMPT_ACTIVE_CODE");
    expect(classifier).toContain("HOST_BUSY_CODE");
    expect(classifier.indexOf("HOST_UPDATE_ATTEMPT_ACTIVE_CODE")).toBeLessThan(
      classifier.indexOf("HOST_BUSY_CODE"),
    );
    expect(classifier).toContain("activeUpdateAttemptOutcome");
    expect(classifier).toContain("hostBusyOutcome");

    // The `host restart` catch (inside `runCliRecoveryServiceCycle`, which
    // `respawn` drives) must route through this one classifier rather than
    // re-inlining its own CLI_LOCK_BUSY/HOST_UPDATE_ATTEMPT_ACTIVE/HOST_BUSY
    // branches - the shape a prior review round removed.
    const recoveryCycle = sliceFrom(
      controller,
      "private async runCliRecoveryServiceCycle(",
      "const result = parseServiceStartResult(raw);",
    );
    expect(recoveryCycle).toContain(
      'classifyMutationSubprocessError(err, "retry-with-force")',
    );
  });
});
