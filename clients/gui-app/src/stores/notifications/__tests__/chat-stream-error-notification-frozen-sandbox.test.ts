import { afterEach, describe, expect, it } from "vitest";
import {
  SANDBOX_FROZEN_MESSAGE,
  SANDBOX_OUT_OF_CREDITS,
} from "@traycer-clients/shared/host-client/sandbox-control";
import { refusedFrozenSandboxFatal } from "@traycer-clients/shared/test-fixtures/frozen-sandbox-fatal";
import {
  installHostDirectoryRows,
  resetHostDirectoryRows,
  sandboxHostEntry,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import { chatStreamErrorNotification } from "@/stores/notifications/app-local-notifications-store";

const HOST_ID = "sandbox-host-1";

afterEach(() => {
  resetHostDirectoryRows();
});

describe("the chat stream-error notification on a refused frozen sandbox", () => {
  it.each([
    [
      "a team's sandbox",
      sandboxHostEntry(HOST_ID, { id: "team-1", name: "Acme" }),
      SANDBOX_OUT_OF_CREDITS,
    ],
    [
      "the reader's own sandbox",
      sandboxHostEntry(HOST_ID, null),
      SANDBOX_FROZEN_MESSAGE,
    ],
  ])(
    "prints the reason the fatal carries for %s",
    async (_label, row, reason) => {
      installHostDirectoryRows([row]);
      const details = await refusedFrozenSandboxFatal(HOST_ID);
      expect(details).toMatchObject({ code: "SANDBOX_FROZEN", reason });

      const notification = chatStreamErrorNotification({
        hostId: HOST_ID,
        epicId: "epic-1",
        chatId: "chat-1",
        details,
      });

      expect(notification.message).toBe("Agent stream closed unexpectedly.");
      expect(notification.detail).toBe(reason);
    },
  );
});
