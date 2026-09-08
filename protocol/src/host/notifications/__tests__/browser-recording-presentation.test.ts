import { describe, expect, it } from "vitest";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV21,
  hostOperationKnownCopy,
  parseKnownHostNotificationPayloadForKind,
} from "@traycer/protocol/host/notifications/contracts";

const RECORDING_ID = "3f2d0a2c-0000-4000-8000-000000000000";

function entryFor(payload: Record<string, unknown>) {
  return hostNotificationEntrySchemaV21.parse({
    id: `browser.recording:${RECORDING_ID}`,
    updatedAt: 1_700_000_000_000,
    readAt: null,
    sourceRef: RECORDING_ID,
    severity: "info",
    epicId: "epic-1",
    chatId: "chat-1",
    kind: "host.operation.finished",
    outcome: "completed",
    payload,
  });
}

function payloadFor(
  phase: "started" | "saved" | "ended",
  path: string | null,
): Record<string, unknown> {
  return {
    kind: "browser_recording",
    operation: "browser.recording",
    title: "Browser recording",
    message: phase === "saved" ? "Recording saved" : "Recording started",
    epicId: "epic-1",
    chatId: "chat-1",
    recordingId: RECORDING_ID,
    tabId: "tab-1",
    phase,
    ...(path === null ? {} : { path }),
  };
}

describe("browser recording host-operation presentation", () => {
  it("titles a saved row by the clip and keeps the operation copy as the body", () => {
    const payload = payloadFor("saved", `files/recordings/${RECORDING_ID}.mp4`);
    const known = parseKnownHostNotificationPayloadForKind(
      "host.operation.finished",
      payload,
    );
    expect(known?.kind).toBe("browser_recording");
    if (known === null) throw new Error("expected a browser recording payload");
    expect(hostOperationKnownCopy(known)).toEqual({
      title: `${RECORDING_ID}.mp4`,
      body: "Browser recording • Recording saved",
    });
    expect(formatHostNotificationPresentation(entryFor(payload))).toEqual({
      title: `${RECORDING_ID}.mp4`,
      body: "Browser recording • Recording saved",
    });
  });

  it("leaves every other phase on the host-composed operation tier", () => {
    const payload = payloadFor("started", null);
    const known = parseKnownHostNotificationPayloadForKind(
      "host.operation.finished",
      payload,
    );
    if (known === null) throw new Error("expected a browser recording payload");
    expect(hostOperationKnownCopy(known)).toBeNull();
    expect(formatHostNotificationPresentation(entryFor(payload))).toEqual({
      title: "Browser recording",
      body: "Recording started",
    });
  });

  it("refuses the payload under any other notification kind", () => {
    expect(
      parseKnownHostNotificationPayloadForKind(
        "agent.stopped",
        payloadFor("saved", "files/recordings/x.mp4"),
      ),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind(
        "browser.human.needed",
        payloadFor("saved", "files/recordings/x.mp4"),
      ),
    ).toBeNull();
  });

  it("degrades a saved row with no clip path rather than inventing a title", () => {
    const known = parseKnownHostNotificationPayloadForKind(
      "host.operation.finished",
      payloadFor("saved", null),
    );
    if (known === null) throw new Error("expected a browser recording payload");
    expect(hostOperationKnownCopy(known)).toBeNull();
  });
});
