import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  findTelemetryResidues,
  isReleaseTrainPromotion,
  runGuard,
} = require("../release-train-promotion-guard.cjs");

const temporaryRoots = [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "release-train-guard-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("release-train promotion selection", () => {
  it("only selects a same-repository tgill-release-train promotion to main", () => {
    expect(
      isReleaseTrainPromotion({
        baseRef: "main",
        headRef: "tgill-release-train",
        repository: "traycerai/traycer",
        headRepository: "traycerai/traycer",
      }),
    ).toBe(true);
    expect(
      isReleaseTrainPromotion({
        baseRef: "tgill-release-train",
        headRef: "feature",
        repository: "traycerai/traycer",
        headRepository: "traycerai/traycer",
      }),
    ).toBe(false);
    expect(
      isReleaseTrainPromotion({
        baseRef: "main",
        headRef: "tgill-release-train",
        repository: "traycerai/traycer",
        headRepository: "fork/traycer",
      }),
    ).toBe(false);
  });
});

describe("temporary crash telemetry residue detection", () => {
  it("finds production wiring and telemetry test files", () => {
    const root = fixture({
      "clients/gui-app/src/root.tsx": "runner.crashTelemetry.persist(input);",
      "clients/desktop/src/ipc-contracts/renderer-crash-telemetry.ts":
        "export const parser = true;",
      "clients/desktop/src/electron-main/ipc/__tests__/renderer-crash-telemetry-input.test.ts":
        "test('parser', () => {});",
    });

    expect(findTelemetryResidues(root)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("crashTelemetry"),
        expect.stringContaining("telemetry-only file still exists"),
      ]),
    );
  });

  it("passes a cleaned tree and ignores non-promotion PRs", () => {
    const root = fixture({
      "clients/gui-app/src/root.tsx": "export const permanentBoundary = true;",
    });
    expect(findTelemetryResidues(root)).toEqual([]);
    expect(
      runGuard({
        environment: {
          GITHUB_BASE_REF: "tgill-release-train",
          GITHUB_HEAD_REF: "feature",
          GITHUB_REPOSITORY: "traycerai/traycer",
          PR_HEAD_REPOSITORY: "traycerai/traycer",
        },
        repositoryRoot: root,
        force: false,
      }),
    ).toEqual({ checked: false, residues: [] });
  });
});
