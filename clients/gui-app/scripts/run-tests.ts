import { spawnSync } from "node:child_process";

const testArgs = process.argv.slice(2);

function runVitest(configPath: string, filePath: string | undefined): void {
  const args = ["x", "vitest", "run", "--config", configPath];
  if (filePath !== undefined) {
    args.push(filePath);
  }

  if (configPath === "vitest.config.ts") {
    args.push(...testArgs);
  }

  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readShardValue(args: string[]): string | undefined {
  const equalsForm = args.find((arg) => arg.startsWith("--shard="));
  if (equalsForm !== undefined) {
    return equalsForm.slice("--shard=".length);
  }

  const flagIndex = args.indexOf("--shard");
  return flagIndex === -1 ? undefined : args[flagIndex + 1];
}

const shard = readShardValue(testArgs);
const runsFirstShard = shard === undefined || shard.split("/", 1)[0] === "1";

runVitest("vitest.config.ts", undefined);
if (runsFirstShard) {
  runVitest(
    "vitest.react-compiler.config.ts",
    "src/components/epic-canvas/comm-graph/__tests__/use-comm-graph-snapshot-cloud-authority.test.tsx",
  );
}
