import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEnvironmentRequestWithBearer } from "../environment-cloud";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("environment authn request body limit", () => {
  it("cancels a failure response at the first chunk over the cap", async () => {
    let pulledChunks = 0;
    let pulledBytes = 0;
    let cancelled = false;
    const chunks = [
      new Uint8Array(131_072),
      new Uint8Array(131_072),
      new Uint8Array(1),
      new Uint8Array(1),
    ];
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[pulledChunks];
            if (chunk === undefined) {
              controller.close();
              return;
            }
            pulledChunks += 1;
            pulledBytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 500 },
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const sent = await sendEnvironmentRequestWithBearer(
      createEnvironmentCloud("test-bearer"),
      "settings",
      "GET",
      "api/v3/environments/team-a/items",
      null,
    );

    expect(pulledBytes).toBe(262_145);
    expect(pulledChunks).toBe(3);
    expect(cancelled).toBe(true);
    expect(sent.answer).toEqual({ status: 500, body: null });
  });

  it("reads and parses a success body larger than the failure cap", async () => {
    const body = { detail: "x".repeat(262_145) };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const sent = await sendEnvironmentRequestWithBearer(
      createEnvironmentCloud("test-bearer"),
      "settings",
      "GET",
      "api/v3/environments/team-a/revision",
      null,
    );

    expect(sent.answer).toEqual({ status: 200, body });
  });
});
