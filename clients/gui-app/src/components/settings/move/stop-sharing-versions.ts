import type { RequiredHostMethodVersion } from "@traycer-clients/shared/host-transport/host-messenger";

export const STOP_OWNERSHIP_PREVIEW_FLOOR = {
  method: "environment.move.stopPreview",
  version: { major: 1, minor: 5 },
} as const satisfies RequiredHostMethodVersion;

export const STOP_OWNERSHIP_CONFIRM_FLOOR = {
  method: "environment.move.stop",
  version: { major: 1, minor: 4 },
} as const satisfies RequiredHostMethodVersion;
