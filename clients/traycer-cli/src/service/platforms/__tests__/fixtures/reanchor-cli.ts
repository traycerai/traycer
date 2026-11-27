import { expect, vi } from "vitest";
import type { CommandContext } from "../../../../runner/runner";

function reAnchorContext(environment: string): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
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

export async function reAnchorCliForWindowsTaskTest(
  environment: string,
  binaryPath: string,
): Promise<void> {
  const { buildCliReAnchorCommand } =
    await import("../../../../commands/cli-re-anchor");
  await buildCliReAnchorCommand({
    binaryPath,
    version: "2.0.0",
  })(reAnchorContext(environment));
  const { readCliManifest } = await import("../../../../manifest/cli-manifest");
  await expect(readCliManifest(environment)).resolves.toMatchObject({
    binaryPath,
  });
}
