"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROMOTION_BASE = "main";
const PROMOTION_HEAD = "tgill-release-train";

// These names are deliberately specific to the temporary RootErrorBoundary
// persistence path. The existing report-issue component stacks and Electron's
// crash reporter are permanent features and must not trip this guard.
const FORBIDDEN_MARKERS = [
  "crashTelemetry",
  "rendererCrashPersist",
  "RendererCrashTelemetryInput",
  "getClientBuildRevision",
  "VITE_APP_BUILD_REVISION",
  "renderer-crash-telemetry",
  "[renderer-crash] RootErrorBoundary captured uncaught error",
];

const SCANNED_PATHS = [
  "clients/gui-app/src",
  "clients/desktop/src",
  "clients/shared",
];

const FORBIDDEN_FILES = [
  "clients/desktop/src/ipc-contracts/renderer-crash-telemetry.ts",
  "clients/desktop/src/electron-main/ipc/__tests__/renderer-crash-telemetry-input.test.ts",
];

function isReleaseTrainPromotion(input) {
  return (
    input.baseRef === PROMOTION_BASE &&
    input.headRef === PROMOTION_HEAD &&
    input.repository.length > 0 &&
    input.headRepository === input.repository
  );
}

function walkFiles(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];

  return fs
    .readdirSync(targetPath, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === ".git") return [];
      return walkFiles(path.join(targetPath, entry.name));
    });
}

function findTelemetryResidues(repositoryRoot) {
  const residues = [];

  for (const relativePath of FORBIDDEN_FILES) {
    if (fs.existsSync(path.join(repositoryRoot, relativePath))) {
      residues.push(`${relativePath}: telemetry-only file still exists`);
    }
  }

  for (const relativeRoot of SCANNED_PATHS) {
    for (const filePath of walkFiles(path.join(repositoryRoot, relativeRoot))) {
      const contents = fs.readFileSync(filePath, "utf8");
      for (const marker of FORBIDDEN_MARKERS) {
        if (contents.includes(marker)) {
          residues.push(
            `${path.relative(repositoryRoot, filePath)}: contains ${JSON.stringify(marker)}`,
          );
        }
      }
    }
  }

  return [...new Set(residues)].sort();
}

function runGuard({ environment, repositoryRoot, force }) {
  const promotion = isReleaseTrainPromotion({
    baseRef: environment.GITHUB_BASE_REF ?? "",
    headRef: environment.GITHUB_HEAD_REF ?? "",
    repository: environment.GITHUB_REPOSITORY ?? "",
    headRepository: environment.PR_HEAD_REPOSITORY ?? "",
  });

  if (!force && !promotion) {
    return { checked: false, residues: [] };
  }

  return {
    checked: true,
    residues: findTelemetryResidues(repositoryRoot),
  };
}

function main(argv, environment) {
  const force = argv.includes("--force");
  const rootIndex = argv.indexOf("--root");
  const repositoryRoot =
    rootIndex === -1 ? process.cwd() : path.resolve(argv[rootIndex + 1]);
  const result = runGuard({ environment, repositoryRoot, force });

  if (!result.checked) {
    console.log(
      `Skipping temporary crash telemetry cleanup guard: this is not ${PROMOTION_HEAD} -> ${PROMOTION_BASE}.`,
    );
    return 0;
  }

  if (result.residues.length === 0) {
    console.log(
      "Release-train promotion is free of temporary crash telemetry.",
    );
    return 0;
  }

  console.error(
    "Release-train promotion blocked: remove the temporary RootErrorBoundary crash telemetry and its tests before merging into main.",
  );
  for (const residue of result.residues) console.error(`- ${residue}`);
  return 1;
}

module.exports = {
  findTelemetryResidues,
  isReleaseTrainPromotion,
  main,
  runGuard,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
