import { stat, writeFile } from "node:fs/promises";
import {
  __setCliInvocationTxnObservePauseForTest,
  runServiceRegistrationWithInvocationRecord,
  runServiceUninstallWithInvocationRecord,
} from "../../cli-invocation-record";

const POLL_MS = 20;
const MAX_WAIT_MS = 15_000;

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (
      await stat(path)
        .then(() => true)
        .catch(() => false)
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`cli-invocation-worker: timed out waiting for ${path}`);
}

function installObservePauseFromWorkerEnv(): void {
  const readyPath = process.env.TRAYCER_CLI_INVOCATION_TXN_TEST_READY;
  const releasePath = process.env.TRAYCER_CLI_INVOCATION_TXN_TEST_RELEASE;
  if (
    readyPath === undefined ||
    readyPath.length === 0 ||
    releasePath === undefined ||
    releasePath.length === 0
  ) {
    return;
  }
  __setCliInvocationTxnObservePauseForTest(async () => {
    await writeFile(readyPath, "ready\n");
    await waitForFile(releasePath);
  });
}

async function main(): Promise<void> {
  installObservePauseFromWorkerEnv();
  const hostHomeDir = process.env.WORKER_HOST_HOME;
  const operation = process.env.WORKER_OPERATION;
  const serviceLabel = process.env.WORKER_SERVICE_LABEL;
  const command = process.env.WORKER_COMMAND;
  const argument = process.env.WORKER_ARGUMENT;
  const enteredPath = process.env.WORKER_ENTERED_PATH;
  const configuredReleasePath = process.env.WORKER_RELEASE_PATH;
  const releasePath =
    configuredReleasePath === undefined || configuredReleasePath === ""
      ? undefined
      : configuredReleasePath;
  const resultPath = process.env.WORKER_RESULT_PATH;
  const waitMs = Number(process.env.WORKER_WAIT_MS ?? "0");
  const pollIntervalMs = Number(process.env.WORKER_POLL_MS ?? String(POLL_MS));
  if (
    hostHomeDir === undefined ||
    operation === undefined ||
    serviceLabel === undefined ||
    enteredPath === undefined ||
    resultPath === undefined ||
    !Number.isFinite(waitMs) ||
    !Number.isFinite(pollIntervalMs)
  ) {
    throw new Error("cli-invocation-worker: incomplete configuration");
  }

  const recordOptions = {
    environment: "production" as const,
    hostHomeDir,
    serviceLabel,
    waitMs,
    pollIntervalMs,
  };
  if (operation === "install") {
    if (command === undefined) {
      throw new Error("cli-invocation-worker: install requires command");
    }
    await runServiceRegistrationWithInvocationRecord({
      ...recordOptions,
      cli: { command, args: argument === undefined ? [] : [argument] },
      register: async () => {
        await writeFile(enteredPath, "install\n");
        if (releasePath !== undefined) await waitForFile(releasePath);
      },
    });
  } else if (operation === "uninstall") {
    await runServiceUninstallWithInvocationRecord({
      ...recordOptions,
      uninstall: async () => {
        await writeFile(enteredPath, "uninstall\n");
        if (releasePath !== undefined) await waitForFile(releasePath);
      },
    });
  } else {
    throw new Error(`cli-invocation-worker: unknown operation ${operation}`);
  }
  await writeFile(resultPath, "ok\n");
}

const resultPath = process.env.WORKER_RESULT_PATH;
main().catch(async (error: unknown) => {
  if (resultPath !== undefined) {
    await writeFile(
      resultPath,
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        code:
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : null,
      }),
    );
  }
  process.exitCode = 1;
});
