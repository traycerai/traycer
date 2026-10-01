// Focused Node V8 retained-heap regression for the chat accountant's streamed
// text path. Run from any directory with: node scripts/verify-live-block-retention.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const source = resolve(
  scriptDir,
  "../src/stores/replica-memory/chat-owned-state-account.ts",
);
const tempDir = mkdtempSync(join(tmpdir(), "chat-stream-retention-"));
const bundle = join(tempDir, "account.mjs");
const childCode = `
  const { createChatOwnedStateAccount, noteLiveTextAppend } = await import(process.env.ACCOUNTANT_BUNDLE);
  const steps = Number(process.env.STREAM_STEPS);
  const delta = 'x'.repeat(512);
  const account = createChatOwnedStateAccount();
  let blocks = [{ type: 'text', blockId: 'live', status: 'streaming', timestamp: 1, text: '', providerNotice: null }];
  const live = (nextBlocks) => ({ turnId: 'turn', sender: { type: 'agent' }, startedAt: 1, blocksVersion: 0, imageResolutionOwnerMessageId: null, imageResolutionsVersion: 0, imageResolutions: [], timestamp: 1, reasoningEffort: null, serviceTier: null, blocks: nextBlocks });
  account.update({ liveAssistantMessage: live(blocks) });
  for (let i = 0; i < steps; i++) {
    const next = [{ ...blocks[0], text: blocks[0].text + delta }];
    noteLiveTextAppend(blocks, next, 'live', delta);
    account.update({ liveAssistantMessage: live(next) });
    blocks = next;
  }
  for (let i = 0; i < 5; i++) global.gc();
  console.log(JSON.stringify({ heapUsed: process.memoryUsage().heapUsed, charged: account.size().estimatedHeapBytes, textLength: blocks[0].text.length }));
`;

try {
  execFileSync(
    "bun",
    ["build", source, "--target=node", "--format=esm", `--outfile=${bundle}`],
    {
      stdio: "pipe",
    },
  );
  const measure = (steps) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--expose-gc", "--input-type=module", "-e", childCode],
        {
          env: {
            ...process.env,
            ACCOUNTANT_BUNDLE: pathToFileURL(bundle).href,
            STREAM_STEPS: String(steps),
          },
        },
      ).toString(),
    );
  const empty = measure(0);
  const half = measure(400);
  const full = measure(800);
  const halfRetained = half.heapUsed - empty.heapUsed;
  const fullRetained = full.heapUsed - empty.heapUsed;
  assert(halfRetained > 0 && fullRetained > 0);
  console.log(
    JSON.stringify({
      empty,
      half,
      full,
      retainedRatio: fullRetained / halfRetained,
    }),
  );
  assert(
    fullRetained < halfRetained * 2.5,
    "doubling streamed text retained superlinear heap after GC",
  );
  assert.equal(
    full.charged - empty.charged,
    2 * (half.charged - empty.charged),
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
