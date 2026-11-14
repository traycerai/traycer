import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FAILURE_BODY_BYTES,
  sendEnvironmentRequestWithBearer,
} from "../environment-cloud";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("environment authn request body limit", () => {
  it("cancels a failure response at the first chunk over the cap", async () => {
    let pulledChunks = 0;
    let cancelled = false;
    const chunks = [
      new Uint8Array(MAX_FAILURE_BODY_BYTES / 2),
      new Uint8Array(MAX_FAILURE_BODY_BYTES / 2),
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

    expect(pulledChunks).toBe(3);
    expect(cancelled).toBe(true);
    expect(sent.answer).toEqual({ status: 500, body: null });
  });

  it("reads and parses a success body larger than the failure cap", async () => {
    const body = { detail: "x".repeat(MAX_FAILURE_BODY_BYTES + 1) };
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
