import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  startRpcServer,
  type ListeningRpcServer,
} from "../rpc-server";

const WORKER_ADVERTISE_TIMEOUT_MS = 10_000;

type AdvertisedServer = {
  readonly url: string;
  readonly port: number;
};

export function hasBunServe(): boolean {
  const bunValue: unknown = Reflect.get(globalThis, "Bun");
  if (typeof bunValue !== "object" || bunValue === null) {
    return false;
  }
  return typeof Reflect.get(bunValue, "serve") === "function";
}

export async function startLoopbackRpc(): Promise<ListeningRpcServer> {
  if (hasBunServe()) {
    return startRpcServer({ hostname: "127.0.0.1", port: 0 });
  }
  return startRpcServerInBunWorker();
}

export async function startRpcServerInBunWorker(): Promise<ListeningRpcServer> {
  const rpcServerPath = fileURLToPath(new URL("../rpc-server.ts", import.meta.url));
  const script = [
    `import { startRpcServer } from ${JSON.stringify(rpcServerPath)};`,
    "const listening = startRpcServer({",
    '  hostname: "127.0.0.1",',
    "  port: 0,",
    "});",
    'process.stdout.write(JSON.stringify({ url: listening.url, port: listening.port }) + "\\n");',
  ].join("\n");

  const child = spawn("bun", ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const advertised = await readChildAdvertisement(child);
  return {
    url: advertised.url,
    port: advertised.port,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}

function readChildAdvertisement(child: ChildProcess): Promise<AdvertisedServer> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      reject(new Error("Thanos host worker is missing stdio pipes"));
      return;
    }

    let stdoutText = "";
    let stderrText = "";
    let settled = false;

    const settle = (next: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onStdout);
      stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      next();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => {
        reject(
          new Error(
            `Timed out starting Thanos host worker: ${stderrText.trim()}`,
          ),
        );
      });
    }, WORKER_ADVERTISE_TIMEOUT_MS);

    const onStdout = (chunk: Buffer | string): void => {
      stdoutText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = stdoutText.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = stdoutText.slice(0, newline);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        settle(() => {
          reject(
            new Error(`Invalid Thanos host worker advertisement: ${line}`, {
              cause,
            }),
          );
        });
        return;
      }
      if (!isAdvertisedServer(parsed)) {
        settle(() => {
          reject(
            new Error(`Invalid Thanos host worker advertisement: ${line}`),
          );
        });
        return;
      }
      const advertised = parsed;
      settle(() => {
        resolve(advertised);
      });
    };

    const onStderr = (chunk: Buffer | string): void => {
      stderrText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };

    const onError = (cause: Error): void => {
      settle(() => {
        reject(new Error("Failed to spawn Thanos host worker", { cause }));
      });
    };

    const onExit = (code: number | null, signal: string | null): void => {
      settle(() => {
        reject(
          new Error(
            `Thanos host worker exited before advertising (code=${String(code)}, signal=${String(signal)}): ${stderrText.trim()}`,
          ),
        );
      });
    };

    stdout.on("data", onStdout);
    stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function isAdvertisedServer(value: unknown): value is AdvertisedServer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("url" in value) || !("port" in value)) {
    return false;
  }
  return typeof value.url === "string" && typeof value.port === "number";
}
