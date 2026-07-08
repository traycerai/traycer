import { vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

// Shared fixtures for the provider-hook command tests (activity-from-hook /
// session-observed-from-hook), which drive the same command shape: a mocked
// runner context, a stubbed `process.stdin`, and TRAYCER_* env save/restore.

export function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

export function makeCtx(): CommandContext {
  return {
    runtime: makeRuntime(),
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");

export function stubStdin(value: {
  isTTY: boolean;
  chunks: ReadonlyArray<string>;
}): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: {
      isTTY: value.isTTY,
      async *[Symbol.asyncIterator]() {
        for (const chunk of value.chunks) yield Buffer.from(chunk);
      },
    },
  });
}

export function restoreStdin(): void {
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
}

// Snapshot the agent-identity env once at import, then set test values on
// `beforeEach` and restore the snapshot on `afterEach`, so a test that mutates
// or clears these vars cannot leak into the surrounding process env.
const PREV_ENV = {
  epic: process.env.TRAYCER_EPIC_ID,
  agent: process.env.TRAYCER_AGENT_ID,
};

export function setAgentIdentityEnv(): void {
  process.env.TRAYCER_EPIC_ID = "epic-1";
  process.env.TRAYCER_AGENT_ID = "agent-1";
}

export function restoreAgentIdentityEnv(): void {
  if (PREV_ENV.epic === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = PREV_ENV.epic;
  if (PREV_ENV.agent === undefined) delete process.env.TRAYCER_AGENT_ID;
  else process.env.TRAYCER_AGENT_ID = PREV_ENV.agent;
}
