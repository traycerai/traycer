import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { waitForWriterDrain } from "../fetch-resource";

describe("waitForWriterDrain", () => {
  it("rejects and removes listeners when the writer errors before drain", async () => {
    const writer = new PassThrough();
    const pending = waitForWriterDrain(
      writer,
      "https://example.invalid/host.tgz",
    );
    const error = new Error("disk write failed");

    writer.emit("error", error);

    await expect(pending).rejects.toBe(error);
    expect(writer.listenerCount("drain")).toBe(0);
    expect(writer.listenerCount("error")).toBe(0);
    expect(writer.listenerCount("close")).toBe(0);
  });
});
