import { describe, expect, it } from "vitest";
import type { Event, EventHint } from "@sentry/core";
import {
  boundFeedbackEvent,
  FEEDBACK_EVENT_BUDGET_BYTES,
  FEEDBACK_MESSAGE_KEEP_BYTES,
  headOfBytes,
  headOfText,
  REPORT_TEXT_ATTACHMENT_FILENAME,
  REPORT_TEXT_ATTACHMENT_MAX_BYTES,
  REPORT_TRIMMED_TAG,
} from "../support-report-size-guard";

const MIB = 1024 * 1024;

function feedbackEvent(message: string, extra: Partial<Event>): Event {
  return {
    type: "feedback",
    event_id: "8b8bcd4306ab4aa78fb60f3096ded3ae",
    tags: { reportId: "rpt_8b8bcd4306ab4aa78fb60f3096ded3ae" },
    contexts: {
      feedback: { message, contact_email: "anonymous", name: "anonymous" },
      layer0: { status: "unavailable", evidence: "x".repeat(2_000) },
      appMetrics: { "0": { type: "Browser", pid: 1 } },
      processMetrics: { main: { pid: 1 } },
      os: { name: "Windows", version: "10.0.26300" },
    },
    ...extra,
  };
}

function lines(count: number, width: number): string {
  return Array.from(
    { length: count },
    (_, i) => `${String(i).padStart(6, "0")} ${"log ".repeat(width / 4)}`,
  ).join("\n");
}

function bigBreadcrumbs(totalBytes: number): Event["breadcrumbs"] {
  const each = 8 * 1024;
  return Array.from({ length: Math.ceil(totalBytes / each) }, (_, i) => ({
    category: "console",
    message: `${i} ${"b".repeat(each)}`,
    timestamp: 1_791_000_000 + i,
  }));
}

function bytes(event: Event): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function sentMessage(event: Event): string {
  return (event.contexts?.feedback as { message: string }).message;
}

describe("boundFeedbackEvent", () => {
  it("returns an event that fits as given, with no attachment added", () => {
    const event = feedbackEvent(
      "Type: bug\n\nWhat they were trying to do:\nshort",
      {},
    );
    const hint: EventHint = { attachments: [] };
    const result = boundFeedbackEvent(event, hint);
    expect(result.event).toBe(event);
    expect(result.trimmed).toBeNull();
    expect(result.sentBytes).toBe(result.originalBytes);
    expect(result.droppedContexts).toEqual([]);
    expect(hint.attachments).toEqual([]);
  });

  it("moves an oversize report text into an attachment and keeps its head inline", () => {
    const text = lines(20_000, 100); // about 2 MiB of pasted log excerpts
    expect(Buffer.byteLength(text)).toBeGreaterThan(2 * MIB);
    const event = feedbackEvent(text, {});
    const hint: EventHint = {
      attachments: [{ filename: "local-host.log", data: "tail" }],
    };
    const result = boundFeedbackEvent(event, hint);

    expect(result.trimmed).toBe("message");
    expect(result.sentBytes).toBeLessThanOrEqual(FEEDBACK_EVENT_BUDGET_BYTES);
    expect(bytes(result.event)).toBe(result.sentBytes);
    // The full text travels as an attachment, appended after the existing ones.
    expect(hint.attachments?.map((a) => a.filename)).toEqual([
      "local-host.log",
      REPORT_TEXT_ATTACHMENT_FILENAME,
    ]);
    expect(hint.attachments?.[1]?.data).toBe(text);
    expect(hint.attachments?.[1]?.contentType).toBe("text/plain");
    // The inline message is the head, cut on a line, plus the marker.
    const sent = sentMessage(result.event);
    expect(Buffer.byteLength(sent)).toBeLessThan(
      FEEDBACK_MESSAGE_KEEP_BYTES + 256,
    );
    expect(sent.startsWith("000000 log ")).toBe(true);
    expect(sent).toContain(
      `[Report text continues in the attachment ${REPORT_TEXT_ATTACHMENT_FILENAME} (${Buffer.byteLength(text)} bytes in total).]`,
    );
    const head = sent.slice(0, sent.indexOf("\n\n[Report text continues"));
    expect(text.startsWith(head)).toBe(true);
    expect(text.charAt(head.length)).toBe("\n");
    // Breadcrumbs and the app's contexts survive: the text alone was the overflow.
    expect(result.event.contexts?.layer0).toBeDefined();
    expect(result.droppedContexts).toEqual([]);
    expect(result.event.tags?.[REPORT_TRIMMED_TAG]).toBe("message");
    // `reportSize.sentBytes` names the size of the event as returned.
    expect(result.event.contexts?.reportSize).toEqual({
      originalBytes: result.originalBytes,
      sentBytes: result.sentBytes,
    });
    // The input event was not mutated.
    expect(sentMessage(event)).toBe(text);
  });

  it("caps the report-text attachment and says so in the marker", () => {
    const text = lines(60_000, 100); // about 6 MiB
    expect(Buffer.byteLength(text)).toBeGreaterThan(
      REPORT_TEXT_ATTACHMENT_MAX_BYTES,
    );
    const hint: EventHint = { attachments: [] };
    const result = boundFeedbackEvent(feedbackEvent(text, {}), hint);

    const attached = hint.attachments?.[0]?.data;
    if (typeof attached !== "string") {
      throw new Error("expected the report text to be attached as a string");
    }
    const attachedBytes = Buffer.byteLength(attached, "utf8");
    expect(attachedBytes).toBeLessThanOrEqual(REPORT_TEXT_ATTACHMENT_MAX_BYTES);
    expect(attachedBytes).toBeGreaterThan(
      REPORT_TEXT_ATTACHMENT_MAX_BYTES - 256,
    );
    expect(text.startsWith(attached)).toBe(true);
    expect(sentMessage(result.event)).toContain(
      `which holds the first ${attachedBytes} of ${Buffer.byteLength(text)} bytes.]`,
    );
  });

  it("drops breadcrumbs when they are the overflow and keeps a short message intact", () => {
    const message = "Type: bug\n\nWhat they were trying to do:\nclick";
    const event = feedbackEvent(message, {
      breadcrumbs: bigBreadcrumbs(MIB),
    });
    const hint: EventHint = { attachments: [] };
    const result = boundFeedbackEvent(event, hint);

    expect(result.trimmed).toBe("breadcrumbs");
    expect(result.sentBytes).toBeLessThanOrEqual(FEEDBACK_EVENT_BUDGET_BYTES);
    expect(result.event.breadcrumbs).toBeUndefined();
    expect(sentMessage(result.event)).toBe(message);
    expect(hint.attachments).toEqual([]);
    expect(result.event.tags?.[REPORT_TRIMMED_TAG]).toBe("breadcrumbs");
  });

  it("drops an oversize errorCause with no breadcrumbs present and names only what it dropped", () => {
    // traycer#2467 review: the diagnostics cause chain carries an error's
    // message and stack with no bound, and an event captured before any
    // breadcrumb exists has no `breadcrumbs` field at all.
    const event = feedbackEvent("short", {
      contexts: {
        feedback: { message: "short" },
        errorCause: { type: "Error", stack: "at ".repeat(400_000) },
        registry: { hostId: "h", hostVersion: "1.5.1" },
        layer0: { status: "ok" },
        os: { name: "Windows" },
      },
    });
    const result = boundFeedbackEvent(event, { attachments: [] });

    expect(result.trimmed).toBe("contexts");
    expect(result.sentBytes).toBeLessThanOrEqual(FEEDBACK_EVENT_BUDGET_BYTES);
    expect(bytes(result.event)).toBe(result.sentBytes);
    expect(result.droppedContexts).toEqual(["errorCause"]);
    expect(result.event.contexts?.errorCause).toBeUndefined();
    expect(result.event.contexts?.registry).toEqual({
      hostId: "h",
      hostVersion: "1.5.1",
    });
    expect(result.event.contexts?.layer0).toBeDefined();
    expect(result.event.contexts?.os).toEqual({ name: "Windows" });
    expect(result.event.tags?.[REPORT_TRIMMED_TAG]).toBe("contexts");
    expect(result.event.contexts?.reportSize).toEqual({
      originalBytes: result.originalBytes,
      sentBytes: result.sentBytes,
      droppedContexts: "errorCause",
    });
  });

  it("drops contexts largest first, whatever their names, until the event fits", () => {
    const event = feedbackEvent("short", {
      breadcrumbs: bigBreadcrumbs(16 * 1024),
      contexts: {
        feedback: { message: "short" },
        layer0: { evidence: "e".repeat(600 * 1024) },
        somethingNew: { blob: "n".repeat(500 * 1024) },
        errorCause: { stack: "s".repeat(300 * 1024) },
        appMetrics: { "0": { pid: 1 } },
        os: { name: "Windows" },
      },
    });
    const result = boundFeedbackEvent(event, { attachments: [] });

    expect(result.trimmed).toBe("breadcrumbs+contexts");
    expect(result.sentBytes).toBeLessThanOrEqual(FEEDBACK_EVENT_BUDGET_BYTES);
    // 1.4 MiB of contexts: the two largest go, the 300 KiB one fits.
    expect(result.droppedContexts).toEqual(["layer0", "somethingNew"]);
    expect(result.event.contexts?.errorCause).toBeDefined();
    expect(result.event.contexts?.appMetrics).toBeDefined();
    expect(result.event.contexts?.os).toEqual({ name: "Windows" });
    expect(result.event.contexts?.feedback).toEqual({ message: "short" });
  });

  it("fits whatever is thrown at it once every droppable field is gone", () => {
    const text = lines(20_000, 100);
    const event = feedbackEvent(text, {
      breadcrumbs: bigBreadcrumbs(MIB),
      contexts: {
        feedback: { message: text },
        errorCause: { stack: "s".repeat(MIB) },
        registry: { blob: "r".repeat(MIB) },
        os: { name: "o".repeat(MIB) },
      },
    });
    const hint: EventHint = { attachments: [] };
    const result = boundFeedbackEvent(event, hint);

    expect(result.trimmed).toBe("message+breadcrumbs+contexts");
    expect(result.sentBytes).toBeLessThanOrEqual(FEEDBACK_EVENT_BUDGET_BYTES);
    expect(result.droppedContexts).toEqual(["errorCause", "registry", "os"]);
    expect(Object.keys(result.event.contexts ?? {}).sort()).toEqual([
      "feedback",
      "reportSize",
    ]);
    expect(hint.attachments?.[0]?.data).toBe(text);
  });

  it("keeps the first 4 MiB of a one-line blob in the attachment, not just the lines before it", () => {
    // Round 2 of #2467: the attachment cut must not snap to a line break.
    const header = "Type: bug\n\nWhat they were trying to do:\n";
    const blob = '{"k":"v"}'.repeat(600_000); // about 5.7 MiB, one line
    const text = header + blob;
    const hint: EventHint = { attachments: [] };
    boundFeedbackEvent(feedbackEvent(text, {}), hint);

    const attached = hint.attachments?.[0]?.data;
    if (typeof attached !== "string") {
      throw new Error("expected the report text to be attached as a string");
    }
    const attachedBytes = Buffer.byteLength(attached, "utf8");
    expect(attachedBytes).toBeGreaterThan(
      REPORT_TEXT_ATTACHMENT_MAX_BYTES - 16,
    );
    expect(attachedBytes).toBeLessThanOrEqual(REPORT_TEXT_ATTACHMENT_MAX_BYTES);
    expect(text.startsWith(attached)).toBe(true);
  });

  it("stays under budget when a step lands just under it and the metadata is added", () => {
    // Build an event that, once its breadcrumbs are gone, sits 40 bytes under
    // the budget: the trim tag and reportSize context must not push it over.
    const probe = feedbackEvent("short", {
      contexts: { feedback: { message: "short" }, layer0: { evidence: "" } },
    });
    const pad = FEEDBACK_EVENT_BUDGET_BYTES - 40 - bytes(probe);
    const event = feedbackEvent("short", {
      breadcrumbs: bigBreadcrumbs(64 * 1024),
      contexts: {
        feedback: { message: "short" },
        layer0: { evidence: "e".repeat(pad) },
      },
    });
    const { breadcrumbs: _b, ...withoutBreadcrumbs } = event;
    expect(bytes(withoutBreadcrumbs)).toBe(FEEDBACK_EVENT_BUDGET_BYTES - 40);
    const result = boundFeedbackEvent(event, { attachments: [] });

    expect(result.event.breadcrumbs).toBeUndefined();
    expect(result.sentBytes).toBeLessThanOrEqual(FEEDBACK_EVENT_BUDGET_BYTES);
    expect(bytes(result.event)).toBe(result.sentBytes);
    expect(result.event.tags?.[REPORT_TRIMMED_TAG]).toBeDefined();
  });

  it("measures an undefined context as empty instead of throwing", () => {
    const event = feedbackEvent("short", {
      breadcrumbs: bigBreadcrumbs(MIB),
      contexts: {
        feedback: { message: "short" },
        weird: undefined,
        big: { blob: "b".repeat(MIB) },
      },
    });
    const result = boundFeedbackEvent(event, { attachments: [] });
    expect(result.sentBytes).toBeLessThanOrEqual(FEEDBACK_EVENT_BUDGET_BYTES);
    expect(result.droppedContexts).toEqual(["big"]);
  });

  it("leaves a non-feedback event alone whatever its size", () => {
    const event: Event = {
      type: undefined,
      message: "x".repeat(2 * MIB),
      breadcrumbs: bigBreadcrumbs(MIB),
    };
    const hint: EventHint = {};
    const result = boundFeedbackEvent(event, hint);
    expect(result.event).toBe(event);
    expect(result.trimmed).toBeNull();
    expect(hint.attachments).toBeUndefined();
  });
});

describe("headOfBytes", () => {
  it("cuts by bytes only and keeps a split character whole", () => {
    expect(headOfBytes("one two three", 9)).toBe("one two t");
    expect(headOfBytes("aéé", 4)).toBe("aé");
    expect(headOfBytes("a😀😀b", 6)).toBe("a😀");
    expect(headOfBytes("short", 100)).toBe("short");
  });
});

describe("headOfText", () => {
  it("returns short text unchanged", () => {
    expect(headOfText("a\nb", 100)).toBe("a\nb");
  });

  it("cuts on the last line break inside the byte budget", () => {
    expect(headOfText("one\ntwo\nthree", 9)).toBe("one\ntwo");
  });

  it("falls back to the last space when the head has no line break", () => {
    expect(headOfText("one two three", 9)).toBe("one two");
  });

  it("drops a multi-byte character split by the byte cut", () => {
    // "é" is two bytes; a 4-byte cut lands inside the second "é".
    expect(headOfText("aéé", 4)).toBe("aé");
  });
});
