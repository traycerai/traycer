import { describe, expect, it } from "vitest";
import { sandboxIdOfNotificationRow } from "@/stores/notifications/merged-notifications";

describe("sandboxIdOfNotificationRow", () => {
  it.each([
    ["sandbox-warning:sbx_9:7d", "sbx_9"],
    ["sandbox-destroyed:sbx_9:done", "sbx_9"],
    ["sandbox-day-30:sbx_9:12", "sbx_9"],
  ])("reads the sandbox id out of %s", (sourceId, id) => {
    expect(sandboxIdOfNotificationRow({ source: "cloud", sourceId })).toBe(id);
  });

  it("reads a sandbox.notice row's payload before its key", () => {
    expect(
      sandboxIdOfNotificationRow({
        source: "cloud",
        sourceId: "0195a1f0-0001-7000-8000-00000000000a",
        sandboxNotice: {
          kind: "sandbox_notice",
          sandboxId: "sbx_notice",
          sandboxName: "build box",
          notice: { kind: "lost" },
        },
      }),
    ).toBe("sbx_notice");
  });

  it("is null for other rows, a local row, or a key with no id segment", () => {
    expect(
      sandboxIdOfNotificationRow({ source: "cloud", sourceId: "entry-1" }),
    ).toBeNull();
    expect(
      sandboxIdOfNotificationRow({ source: "cloud", sourceId: "sandbox-x" }),
    ).toBeNull();
    expect(
      sandboxIdOfNotificationRow({
        source: "app-local",
        sourceId: "sandbox-warning:sbx_9:7d",
      }),
    ).toBeNull();
  });
});
