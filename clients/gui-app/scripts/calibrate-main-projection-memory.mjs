/**
 * Manual after-GC Node V8 calibration for the structured-cloned main-thread
 * task projection. Run from clients/gui-app:
 *
 *   bunx esbuild scripts/calibrate-main-projection-memory.mjs --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile=/tmp/traycer-main-projection-memory.mjs
 *   node --expose-gc /tmp/traycer-main-projection-memory.mjs
 *
 * Source objects are built before the baseline; only their cloned projection
 * copies and the per-store accounting maps enter the measured delta.
 */
import { Buffer } from "node:buffer";
import process from "node:process";
import { URL } from "node:url";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { createMainProjectionAccount } from "../src/stores/replica-memory/main-projection-account";

const FIXTURES = [
  { name: "small", stores: 200, rows: 1, titleBytes: 24 },
  { name: "many-row", stores: 5, rows: 1000, titleBytes: 24 },
  { name: "large-title", stores: 10, rows: 1, titleBytes: 100_000 },
  {
    name: "shared-chat-rows",
    stores: 5,
    rows: 1000,
    titleBytes: 24,
    sharedRows: true,
  },
];

function afterGc() {
  if (globalThis.gc === undefined) throw new Error("run with node --expose-gc");
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

function title(length, seed) {
  const bytes = Buffer.allocUnsafe(length);
  let value = seed + 1;
  for (let index = 0; index < length; index += 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    bytes[index] = 97 + (value % 26);
  }
  return bytes.toString("latin1");
}

function sourceProjection(fixture, storeIndex) {
  const byId = {};
  const allIds = [];
  for (let rowIndex = 0; rowIndex < fixture.rows; rowIndex += 1) {
    if (fixture.sharedRows) {
      const id = `chat-${storeIndex}-${rowIndex}`;
      allIds.push(id);
      byId[id] = {
        id,
        title: title(fixture.titleBytes, storeIndex * fixture.rows + rowIndex),
        parentId: null,
        createdAt: 1000,
        updatedAt: 1000,
        userId: null,
        hostId: "calibration-host",
        isTitleEditedByUser: false,
        docResident: false,
        settings: null,
        archivedAt: null,
      };
      continue;
    }
    const id = `artifact-${storeIndex}-${rowIndex}`;
    allIds.push(id);
    byId[id] = {
      id,
      kind: "spec",
      title: title(fixture.titleBytes, storeIndex * fixture.rows + rowIndex),
      folderName: id,
      parentId: null,
      artifactRoomId: null,
      createdAt: 1000,
      updatedAt: 1000,
      status: null,
      createdManually: false,
    };
  }
  if (fixture.sharedRows) {
    // unionChatsSlice creates a distinct chats root but retains each row from
    // chatRecords. structuredClone preserves those nested aliases.
    return {
      chatRecords: { byId, allIds },
      chats: { byId: { ...byId }, allIds: [...allIds] },
    };
  }
  return { artifacts: { byId, allIds } };
}

if (isMainThread) {
  const output = await Promise.all(
    FIXTURES.map(
      (fixture) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), {
            workerData: fixture,
          });
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
    ),
  );
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
} else {
  const fixture = workerData;
  const warmup = createMainProjectionAccount();
  warmup.recordPatch(
    structuredClone(sourceProjection({ rows: 1, titleBytes: 8 }, -1)),
  );
  const sources = Array.from({ length: fixture.stores }, (_, index) =>
    sourceProjection(fixture, index),
  );
  const accounts = Array.from({ length: fixture.stores }, () =>
    createMainProjectionAccount(),
  );
  const copies = [];
  globalThis.calibrationHeld = { warmup, sources, accounts, copies };
  const before = afterGc();
  let rawBytes = 0;
  let accountedBytes = 0;
  sources.forEach((source, index) => {
    const copy = structuredClone(source);
    copies.push(copy);
    const charge = accounts[index].recordPatch(copy);
    rawBytes += charge.rawBytes;
    accountedBytes += charge.estimatedHeapBytes;
  });
  const deltaBytes = afterGc() - before;
  parentPort?.postMessage({
    fixture: fixture.name,
    stores: fixture.stores,
    rowsPerStore: fixture.rows,
    rawBytes,
    accountedBytes,
    deltaBytes,
    relativeError: Math.abs(accountedBytes - deltaBytes) / deltaBytes,
  });
}
