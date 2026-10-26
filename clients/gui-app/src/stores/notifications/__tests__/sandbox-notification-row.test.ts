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
