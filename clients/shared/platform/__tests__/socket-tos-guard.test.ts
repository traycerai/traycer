import * as net from "node:net";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  installSocketTosGuard,
  type SocketTosTarget,
} from "../socket-tos-guard";

// traycerai/traycer#2093: undici calls `setTypeOfService(0)` unguarded, and on
// macOS the system call fails with EINVAL on a connection the peer already
// reset. That throw lands on the socket's connect callback, so it reaches the
// process as an uncaught exception no `try` around the request can see.

function systemCallError(code: string, errno: number): Error {
  return Object.assign(new Error(`setTypeOfService ${code}`), {
    code,
    errno,
    syscall: "setTypeOfService",
  });
}

interface Recorder {
  readonly target: SocketTosTarget;
  readonly calls: { self: unknown; tos: number }[];
}

function targetThat(behave: (tos: number) => unknown): Recorder {
  const calls: { self: unknown; tos: number }[] = [];
  const target: SocketTosTarget = {
    setTypeOfService(this: unknown, tos: number): unknown {
      calls.push({ self: this, tos });
      return behave(tos);
    },
  };
  return { target, calls };
}

const hasNativeTos =
  typeof net.Socket.prototype.setTypeOfService === "function";

describe("installSocketTosGuard", () => {
  it.each([
    ["EINVAL", -22],
    ["ENOTCONN", -57],
  ])(
    "swallows a failed system call (%s) and returns the receiver",
    (code, errno) => {
      const { target } = targetThat(() => {
        throw systemCallError(code, errno);
      });
      installSocketTosGuard(target);

      expect(target.setTypeOfService?.(0)).toBe(target);
    },
  );

  it("passes a working call through untouched", () => {
    const { target, calls } = targetThat(() => "original-result");
    installSocketTosGuard(target);

    expect(target.setTypeOfService?.(8)).toBe("original-result");
    expect(calls).toEqual([{ self: target, tos: 8 }]);
  });

  it("rethrows an argument error that carries no syscall", () => {
    const failure = Object.assign(new RangeError("out of range"), {
      code: "ERR_OUT_OF_RANGE",
    });
    const { target } = targetThat(() => {
      throw failure;
    });
    installSocketTosGuard(target);

    expect(() => target.setTypeOfService?.(256)).toThrow(failure);
  });

  it("rethrows a failure of a different system call", () => {
    const failure = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    const { target } = targetThat(() => {
      throw failure;
    });
    installSocketTosGuard(target);

    expect(() => target.setTypeOfService?.(0)).toThrow(failure);
  });

  it("does not wrap twice", () => {
    const { target, calls } = targetThat(() => undefined);
    installSocketTosGuard(target);
    const wrapped = target.setTypeOfService;
    installSocketTosGuard(target);

    expect(target.setTypeOfService).toBe(wrapped);
    target.setTypeOfService?.(0);
    expect(calls).toHaveLength(1);
  });

  it("leaves a runtime without the method alone", () => {
    const target: SocketTosTarget = { setTypeOfService: undefined };
    installSocketTosGuard(target);

    expect(target.setTypeOfService).toBeUndefined();
  });
});

describe("installSocketTosGuard on net.Socket.prototype", () => {
  const pristine = net.Socket.prototype.setTypeOfService;
  const cleanups: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    net.Socket.prototype.setTypeOfService = pristine;
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it.skipIf(!hasNativeTos)(
    "returns the socket on a healthy connection and still rejects a bad argument",
    async () => {
      const server = net.createServer((socket) => {
        socket.on("error", () => undefined);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      cleanups.push(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      );
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server has no port");
      }
      const socket = net.connect(address.port, "127.0.0.1");
      cleanups.push(async () => {
        socket.destroy();
      });
      await new Promise<void>((resolve) => socket.once("connect", resolve));

      installSocketTosGuard(net.Socket.prototype);

      expect(socket.setTypeOfService(0)).toBe(socket);
      let thrown: unknown;
      try {
        socket.setTypeOfService(256);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown instanceof Error && "code" in thrown && thrown.code).toBe(
        "ERR_OUT_OF_RANGE",
      );
    },
  );

  // The control and the subject share one test so a machine where the repro
  // does not fire fails here instead of passing vacuously.
  it.runIf(process.platform === "darwin" && hasNativeTos)(
    "survives a peer reset that lands before the first setTypeOfService",
    async () => {
      // The worker bumps this counter once it has reset a connection, so the
      // client waits for the reset itself instead of guessing a delay.
      const resets = new Int32Array(new SharedArrayBuffer(4));
      const worker = new Worker(
        `
        const { parentPort, workerData } = require("node:worker_threads");
        const net = require("node:net");
        const server = net.createServer((socket) => {
          socket.on("error", () => {});
          socket.resetAndDestroy();
          Atomics.add(workerData.resets, 0, 1);
          Atomics.notify(workerData.resets, 0);
        });
        server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
        `,
        { eval: true, workerData: { resets } },
      );
      cleanups.push(() => worker.terminate());
      const port = await new Promise<number>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });

      // The peer resets while this thread is blocked, then the first
      // `setTypeOfService` runs on the already-reset connection.
      const attempt = (): Promise<unknown> =>
        new Promise((resolve) => {
          // Captured before connecting: a reset that lands before the wait
          // starts makes `Atomics.wait` return "not-equal", which is success.
          const before = Atomics.load(resets, 0);
          const client = net.connect(port, "127.0.0.1");
          client.on("error", () => undefined);
          client.once("connect", () => {
            try {
              if (Atomics.wait(resets, 0, before, 5000) === "timed-out") {
                resolve(new Error("the peer never reset the connection"));
                return;
              }
              // Let the kernel deliver the reset to this end.
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
              client.setTypeOfService(0);
              resolve(undefined);
            } catch (error) {
              resolve(error);
            } finally {
              client.destroy();
            }
          });
        });

      const control = await attempt();
      expect(control).toBeInstanceOf(Error);
      expect(
        control instanceof Error && "code" in control && control.code,
      ).toBe("EINVAL");
      expect(
        control instanceof Error && "syscall" in control && control.syscall,
      ).toBe("setTypeOfService");

      installSocketTosGuard(net.Socket.prototype);

      expect(await attempt()).toBeUndefined();
    },
    // Worker start-up plus two attempts that may each wait out the 5 s
    // handshake: the default 5 s budget would time out before the reason shows.
    20_000,
  );
});
