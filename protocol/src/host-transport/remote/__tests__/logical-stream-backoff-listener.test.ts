import { describe, expect, it } from "vitest";
import { QosClass } from "../../mux";
import { LogicalStream, type LogicalStreamPort } from "../logical-stream";

/**
 * A listener told of a backoff is the caller's code. One that throws must not
 * escape into the session's dispatch, where it would end the whole session,
 * nor keep the listeners after it from hearing.
 */

const PORT: LogicalStreamPort = {
  sendStreamFrame: () => undefined,
  closeStream: () => undefined,
  requestSessionReconnect: () => undefined,
  streamOutboundDebtBytes: () => 0,
};

function logicalStream(): LogicalStream {
  return new LogicalStream({
    streamId: 1,
    method: "git.subscribeStatus",
    paramsProvider: () => ({}),
    schemaVersion: { major: 1, minor: 0 },
    requiredSchemaVersion: null,
    qos: QosClass.INTERACTIVE,
    port: PORT,
  });
}

describe("a logical stream's backoff listener that throws", () => {
  it("does not throw out of the session's notification, and a later listener still hears", () => {
    const stream = logicalStream();
    const heard: string[] = [];
    stream.onBackoffEntered(() => {
      heard.push("throwing");
      throw new Error("the listener's own fault");
    });
    stream.onBackoffEntered(() => {
      heard.push("later");
    });

    expect(() => stream.notifyBackoffEntered()).not.toThrow();

    expect(heard).toEqual(["throwing", "later"]);
  });
});
