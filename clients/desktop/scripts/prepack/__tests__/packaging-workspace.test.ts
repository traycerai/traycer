// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPackagingWorkspace,
  type PackagingWorkspace,
} from "../__integration_tests__/packaging-workspace";

type Stage = (dir: string) => void;

interface Layout {
  readonly releaseDir: string;
  readonly parkDir: string;
  readonly cliA: string;
  readonly cliB: string;
}

const REAL_A = "real-a";
const REAL_B = "real-b";
const STAGED = "staged";
const MARKER = "marker";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function backupOf(dir: string): string {
  return `${dir}.packaging-test-backup`;
}

function writeFileDeep(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function seedDir(dir: string, content: string): void {
  writeFileDeep(path.join(dir, MARKER), content);
}

function markerOf(dir: string): string {
  return readFileSync(path.join(dir, MARKER), "utf8");
}

function stageMarker(dir: string): void {
  seedDir(dir, STAGED);
}

// Both CLI dirs start with a developer's real content, as a local install
// build leaves them.
function layoutWithRealClis(): Layout {
  const root = mkdtempSync(path.join(tmpdir(), "packaging-workspace-"));
  roots.push(root);
  const layout: Layout = {
    releaseDir: path.join(root, "release"),
    parkDir: path.join(root, "park"),
    cliA: path.join(root, "cli-a"),
    cliB: path.join(root, "cli-b"),
  };
  seedDir(layout.cliA, REAL_A);
  seedDir(layout.cliB, REAL_B);
  return layout;
}

function workspaceFor(
  layout: Layout,
  stageA: Stage,
  stageB: Stage,
): PackagingWorkspace {
  return createPackagingWorkspace({
    releaseDir: layout.releaseDir,
    parkDir: layout.parkDir,
    cliDirs: [
      { dir: layout.cliA, stage: stageA },
      { dir: layout.cliB, stage: stageB },
    ],
  });
}

function expectRealClisInPlace(layout: Layout): void {
  expect(markerOf(layout.cliA)).toBe(REAL_A);
  expect(markerOf(layout.cliB)).toBe(REAL_B);
  expect(existsSync(backupOf(layout.cliA))).toBe(false);
  expect(existsSync(backupOf(layout.cliB))).toBe(false);
}

describe("packaging workspace", () => {
  it("deletes the previous run's parked output and the release dir before staging", () => {
    const layout = layoutWithRealClis();
    writeFileDeep(path.join(layout.parkDir, "old"), "parked");
    writeFileDeep(path.join(layout.releaseDir, "old"), "released");
    const leftoverAtStaging: boolean[] = [];
    const stage: Stage = (dir) => {
      leftoverAtStaging.push(
        existsSync(layout.parkDir) || existsSync(layout.releaseDir),
      );
      stageMarker(dir);
    };

    workspaceFor(layout, stage, stage).prepare();

    expect(leftoverAtStaging).toEqual([false, false]);
    expect(markerOf(layout.cliA)).toBe(STAGED);
    expect(markerOf(layout.cliB)).toBe(STAGED);
    expect(markerOf(backupOf(layout.cliA))).toBe(REAL_A);
    expect(markerOf(backupOf(layout.cliB))).toBe(REAL_B);
  });

  it("parks the release dir this run produced and restores every CLI dir", () => {
    const layout = layoutWithRealClis();
    const workspace = workspaceFor(layout, stageMarker, stageMarker);
    workspace.prepare();
    writeFileDeep(
      path.join(layout.releaseDir, "mac", "App.app", "payload"),
      "packed",
    );

    workspace.teardown();

    expect(
      readFileSync(
        path.join(layout.parkDir, "mac", "App.app", "payload"),
        "utf8",
      ),
    ).toBe("packed");
    expect(existsSync(layout.releaseDir)).toBe(false);
    expectRealClisInPlace(layout);
  });

  it("a second teardown parks and restores nothing", () => {
    const layout = layoutWithRealClis();
    const workspace = workspaceFor(layout, stageMarker, stageMarker);
    workspace.prepare();
    writeFileDeep(path.join(layout.releaseDir, "x"), "packed");
    workspace.teardown();

    workspace.teardown();

    expect(readFileSync(path.join(layout.parkDir, "x"), "utf8")).toBe("packed");
    expectRealClisInPlace(layout);
  });

  it("parks nothing when this run produced no release dir", () => {
    const layout = layoutWithRealClis();
    const workspace = workspaceFor(layout, stageMarker, stageMarker);
    workspace.prepare();

    workspace.teardown();

    expect(existsSync(layout.parkDir)).toBe(false);
    expectRealClisInPlace(layout);
  });

  it("touches nothing when teardown runs without a prepare", () => {
    const layout = layoutWithRealClis();
    writeFileDeep(path.join(layout.releaseDir, "dev-build"), "mine");

    workspaceFor(layout, stageMarker, stageMarker).teardown();

    expect(
      readFileSync(path.join(layout.releaseDir, "dev-build"), "utf8"),
    ).toBe("mine");
    expect(existsSync(layout.parkDir)).toBe(false);
    expectRealClisInPlace(layout);
  });

  it("undoes only the CLI dirs it took over when a staging step fails", () => {
    const layout = layoutWithRealClis();
    const failingStage: Stage = () => {
      throw new Error("stage failed");
    };
    const workspace = workspaceFor(layout, failingStage, stageMarker);

    expect(() => workspace.prepare()).toThrow("stage failed");
    expect(markerOf(layout.cliB)).toBe(REAL_B);
    expect(existsSync(backupOf(layout.cliB))).toBe(false);

    workspace.teardown();

    expectRealClisInPlace(layout);
  });

  it("restores the CLI dirs, deletes nothing and throws when parking fails", () => {
    const layout = layoutWithRealClis();
    const workspace = workspaceFor(layout, stageMarker, stageMarker);
    workspace.prepare();
    writeFileDeep(path.join(layout.releaseDir, "x"), "packed");
    writeFileDeep(path.join(layout.parkDir, "blocker"), "held");

    expect(() => workspace.teardown()).toThrow(/ENOTEMPTY|EEXIST/);

    expect(readFileSync(path.join(layout.releaseDir, "x"), "utf8")).toBe(
      "packed",
    );
    expect(readFileSync(path.join(layout.parkDir, "blocker"), "utf8")).toBe(
      "held",
    );
    expectRealClisInPlace(layout);
  });

  it("prefers a backup left by a crashed run over the dir's stale content", () => {
    const layout = layoutWithRealClis();
    seedDir(layout.cliA, "stale-staged");
    seedDir(backupOf(layout.cliA), REAL_A);
    const workspace = workspaceFor(layout, stageMarker, stageMarker);

    workspace.prepare();

    expect(markerOf(backupOf(layout.cliA))).toBe(REAL_A);
    expect(markerOf(layout.cliA)).toBe(STAGED);

    workspace.teardown();

    expectRealClisInPlace(layout);
  });
});
