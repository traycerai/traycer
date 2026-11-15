import { writeFileSync } from "node:fs";

// Listed before the run root's setup, so vitest tears it down after the run
// root's teardown has run.
export function setup(): () => void {
  const releaseFile = process.env.CREDENTIALS_RUN_ROOT_RELEASE_FILE;
  if (releaseFile === undefined) throw new Error("no release file in the env");
  return () => {
    writeFileSync(releaseFile, "");
  };
}
