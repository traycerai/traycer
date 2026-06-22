import type { ChatEvent } from "@traycer/protocol/persistence/epic/schemas";

export const SETUP_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "setup.creating",
  "setup.running",
  "setup.succeeded",
  "setup.failed",
  "setup.cancelled",
]);
