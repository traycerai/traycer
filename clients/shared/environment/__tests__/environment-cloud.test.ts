import { describe, expect, it, vi } from "vitest";
import {
  MAX_ENVIRONMENT_BODY_BYTES,
  sendEnvironmentRequest,
} from "../environment-cloud";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

describe("environment authn request body limit", () => {
  it("does not read more than 256 KB of a failure response", async () => {
    let pulledChunks = 0;
    let cancelled = false;
    const chunks = [
      new Uint8Array(MAX_ENVIRONMENT_BODY_BYTES / 2),
      new Uint8Array(MAX_ENVIRONMENT_BODY_BYTES / 2),
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

    const answer = await sendEnvironmentRequest(
      createEnvironmentCloud("test-bearer"),
      "settings",
      "GET",
      "api/v3/environments/team-a/items",
      null,
    );

    expect(pulledChunks).toBe(3);
    expect(cancelled).toBe(true);
    expect(answer.body).toBeNull();
  });
});
