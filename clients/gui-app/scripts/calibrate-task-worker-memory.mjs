/**
 * Manual V8 calibration for retained task rows and one materialized Yjs body.
 * From clients/gui-app:
 *
 *   bunx esbuild scripts/calibrate-task-worker-memory.mjs --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile=/tmp/traycer-task-memory.mjs
 *   node --expose-gc /tmp/traycer-task-memory.mjs
 *
 * The worker isolate measures incremental managed data after a warmed module,
 * not the Electron renderer or a WebKit process. The body uses the same
 * encoded-state byte charge as the hot-doc budget.
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
import * as Y from "yjs";
import { createEpicLaneStateReplica } from "../src/stores/epics/open-epic/runtime/epic-lane-state-replica";

const FIXTURES = [
  { name: "small", replicas: 200, rows: 1, titleBytes: 24, bodyBytes: 0 },
  { name: "many-row", replicas: 5, rows: 1000, titleBytes: 24, bodyBytes: 0 },
  {
    name: "large-body",
    replicas: 10,
    rows: 1,
    titleBytes: 24,
    bodyBytes: 100_000,
  },
];

function usedAfterGc() {
  if (globalThis.gc === undefined) throw new Error("run with node --expose-gc");
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

function uniqueTitle(length, seed) {
  const bytes = Buffer.allocUnsafe(length);
  let value = seed + 1;
  for (let index = 0; index < length; index += 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    bytes[index] = 97 + (value % 26);
  }
  return bytes.toString("latin1");
}

function makeReplica() {
  let charge = { rawBytes: 0, estimatedHeapBytes: 0 };
  const docs = [];
  let docBytes = 0;
  const replica = createEpicLaneStateReplica({
    getCurrentUserId: () => null,
    isDisposed: () => false,
    onChanged: () => undefined,
    onRetainedRowsChanged: (size) => {
      charge = size;
    },
  });
  return {
    replica,
    docs,
    get charge() {
      return {
        rawBytes: charge.rawBytes + docBytes,
        estimatedHeapBytes: charge.estimatedHeapBytes + docBytes,
      };
    },
    addDoc(doc, bytes) {
      docs.push(doc);
      docBytes += bytes;
    },
  };
}

function populate(replica, fixture, replicaIndex) {
  const rows = Array.from({ length: fixture.rows }, (_, rowIndex) => {
    const id = `artifact-${replicaIndex}-${rowIndex}`;
    return {
      rowId: `artifact:${id}`,
      revision: 1,
      row: {
        kind: "artifact",
        record: {
          kind: "spec",
          id,
          folderName: id,
          title: uniqueTitle(
            fixture.titleBytes,
            replicaIndex * fixture.rows + rowIndex,
          ),
          createdAt: 1000,
          updatedAt: 1000,
          createdManually: false,
          parentId: null,
          revision: 1,
        },
      },
    };
  });
  replica.apply({
    kind: "record-snapshot",
    watermark: {
      authorityEpoch: `epoch-${replicaIndex}`,
      lane: "epic.state.subscribe@1",
      position: 1,
    },
    rows,
    trust: "reconciled-with-cloud",
    cause: "initial",
  });
}

if (isMainThread) {
  const output = [];
  for (const fixture of FIXTURES) {
    const samples = [];
    // A fresh V8 isolate's after-GC heap delta can occasionally fall well
    // below its neighboring runs. The median keeps that GC timing noise from
    // deciding whether the estimator clears the 30% calibration gate.
    for (let sample = 0; sample < 5; sample += 1) {
      samples.push(
        await new Promise((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), {
            workerData: fixture,
          });
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
      );
    }
    const median = [...samples].sort(
      (left, right) => left.deltaBytes - right.deltaBytes,
    )[2];
    output.push({
      ...median,
      sampleDeltas: samples.map((sample) => sample.deltaBytes),
    });
  }
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
} else {
  const fixture = workerData;
  // Warm the code paths and hidden classes before measuring retained data.
  const warmup = makeReplica();
  populate(
    warmup.replica,
    { name: "warmup", replicas: 1, rows: 1, titleBytes: 8, bodyBytes: 0 },
    -1,
  );
  const warmupDoc = new Y.Doc();
  warmupDoc.getText("body").insert(0, "warmup");
  Y.encodeStateAsUpdate(warmupDoc);
  const held = Array.from({ length: fixture.replicas }, () => makeReplica());
  globalThis.calibrationHeld = {
    warmup,
    warmupDoc,
    held,
  };
  const before = usedAfterGc();
  held.forEach((item, index) => {
    populate(item.replica, fixture, index);
    if (fixture.bodyBytes > 0) {
      const doc = new Y.Doc();
      doc.getText("body").insert(0, uniqueTitle(fixture.bodyBytes, index));
      item.addDoc(doc, Y.encodeStateAsUpdate(doc).byteLength);
    }
  });
  const after = usedAfterGc();
  const rawBytes = held.reduce((sum, item) => sum + item.charge.rawBytes, 0);
  const accountedBytes = held.reduce(
    (sum, item) => sum + item.charge.estimatedHeapBytes,
    0,
  );
  const deltaBytes = after - before;
  parentPort?.postMessage({
    fixture: fixture.name,
    replicas: fixture.replicas,
    rowsPerReplica: fixture.rows,
    rawBytes,
    accountedBytes,
    deltaBytes,
    relativeError: Math.abs(accountedBytes - deltaBytes) / deltaBytes,
  });
}
