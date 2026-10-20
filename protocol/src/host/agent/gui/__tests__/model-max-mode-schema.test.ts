import { describe, expect, it } from "vitest";

import {
  guiAgentModelMaxModeSchema,
  guiAgentModelOptionSchema,
} from "../unary-schemas";

const VALID = {
  chat: [{ reasoningEffort: "high", fast: true }],
  judge: [{ reasoningEffort: null }],
  fastServiceTierId: "fast",
};

describe("guiAgentModelMaxModeSchema", () => {
  it("parses the recognized keys", () => {
    const parsed = guiAgentModelMaxModeSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(VALID);
  });

  it("accepts empty lists and a null fast tier id", () => {
    expect(
      guiAgentModelMaxModeSchema.safeParse({
        chat: [],
        judge: [],
        fastServiceTierId: null,
      }).success,
    ).toBe(true);
  });

  it("tolerates and strips unknown keys at the top level and inside entries", () => {
    const parsed = guiAgentModelMaxModeSchema.safeParse({
      ...VALID,
      futureField: 1,
      chat: [{ reasoningEffort: "high", fast: true, futureEntryField: "x" }],
      judge: [{ reasoningEffort: null, other: true }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(VALID);
    expect(parsed.data).not.toHaveProperty("futureField");
    expect(parsed.data?.chat[0]).not.toHaveProperty("futureEntryField");
    expect(parsed.data?.judge[0]).not.toHaveProperty("other");
  });

  it.each([
    [
      "fast as a string",
      { ...VALID, chat: [{ reasoningEffort: "high", fast: "true" }] },
    ],
    [
      "chat not an array",
      { ...VALID, chat: { reasoningEffort: "high", fast: true } },
    ],
    ["judge not an array", { ...VALID, judge: null }],
    ["numeric effort", { ...VALID, judge: [{ reasoningEffort: 1 }] }],
    ["non-string fast tier id", { ...VALID, fastServiceTierId: true }],
  ])("rejects a wrong type: %s", (_name, value) => {
    expect(guiAgentModelMaxModeSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["fastServiceTierId", { chat: VALID.chat, judge: VALID.judge }],
    ["chat", { judge: VALID.judge, fastServiceTierId: "fast" }],
    ["judge", { chat: VALID.chat, fastServiceTierId: "fast" }],
    ["chat entry fast", { ...VALID, chat: [{ reasoningEffort: "high" }] }],
    ["chat entry reasoningEffort", { ...VALID, chat: [{ fast: true }] }],
  ])("rejects a missing recognized key: %s", (_name, value) => {
    expect(guiAgentModelMaxModeSchema.safeParse(value).success).toBe(false);
  });

  it("leaves the model option's open metadata record unchanged", () => {
    const option = guiAgentModelOptionSchema.parse({
      harnessId: "cursor",
      slug: "m",
      label: "M",
      description: null,
      contextWindow: null,
      maxOutputTokens: null,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      metadata: { maxMode: { wrong: "shape" }, other: 1 },
    });
    expect(option.metadata).toEqual({ maxMode: { wrong: "shape" }, other: 1 });
  });
});
