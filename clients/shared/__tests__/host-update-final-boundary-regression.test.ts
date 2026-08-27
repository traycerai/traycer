import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHARED_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ROOT = join(SHARED_ROOT, "..", "traycer-cli", "src");
const DESKTOP_ROOT = join(SHARED_ROOT, "..", "desktop", "src", "electron-main");

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function sliceFrom(sourceText: string, start: string, end: string): string {
  const startAt = sourceText.indexOf(start);
  const endAt = sourceText.indexOf(end, startAt + start.length);
  expect(startAt, `missing source marker: ${start}`).toBeGreaterThan(-1);
  expect(endAt, `missing source marker: ${end}`).toBeGreaterThan(startAt);
  return sourceText.slice(startAt, endAt);
}

function offsets(sourceText: string, pattern: RegExp): number[] {
  return Array.from(sourceText.matchAll(new RegExp(pattern.source, "g"))).map(
    (match) => match.index ?? -1,
  );
}

function expectVerifierBeforeEvery(
  sourceText: string,
  actuator: RegExp,
  verifier: RegExp,
): void {
  const verifierOffsets = offsets(sourceText, verifier);
  let previousActuatorOffset = -1;
  for (const actuatorOffset of offsets(sourceText, actuator)) {
    expect(
      verifierOffsets.some(
        (verifierOffset) =>
          verifierOffset > previousActuatorOffset &&
          verifierOffset < actuatorOffset,
      ),
      `missing verifier before actuator at offset ${actuatorOffset}`,
    ).toBe(true);
    previousActuatorOffset = actuatorOffset;
  }
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
    const promotion = sliceFrom(
      downloadStage,
      "async function replaceStagedDirWithAttempt(",
      "// Phase 0 - brief lock",
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

  it("keeps active-attempt subprocess errors distinct from E_HOST_BUSY", async () => {
    const controller = await source(
      join(DESKTOP_ROOT, "host", "host-controller.ts"),
    );
    expect(controller).toContain('"E_HOST_UPDATE_ATTEMPT_ACTIVE"');
    expect(controller).toContain("attemptId");
    expect(controller).toContain("disposition");
    const activeCode = controller.indexOf('"E_HOST_UPDATE_ATTEMPT_ACTIVE"');
    const hostBusyCode = controller.indexOf('"E_HOST_BUSY"');
    expect(activeCode).toBeGreaterThan(-1);
    expect(hostBusyCode).toBeGreaterThan(-1);
    expect(controller).toContain("HOST_UPDATE_ATTEMPT_ACTIVE_CODE");
  });
});
