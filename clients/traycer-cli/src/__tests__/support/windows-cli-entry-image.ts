import { captureWindowsCliEntryImage } from "../../store/windows-cli-entry-image";

export function captureWindowsCliFixture(path: string): void {
  const execPath = Object.getOwnPropertyDescriptor(process, "execPath");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const builtin = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
  if (
    execPath === undefined ||
    platform === undefined ||
    builtin === undefined
  ) {
    throw new Error("missing Node process properties");
  }
  Object.defineProperty(process, "execPath", { ...execPath, value: path });
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "getBuiltinModule", {
    ...builtin,
    value: () => ({ isSea: () => true }),
  });
  try {
    captureWindowsCliEntryImage();
  } finally {
    Object.defineProperty(process, "getBuiltinModule", builtin);
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "execPath", execPath);
  }
}
