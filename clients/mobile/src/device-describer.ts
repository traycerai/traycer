import { Device, type DeviceInfo } from "@capacitor/device";
import type { IDeviceDescriber } from "@traycer-clients/shared/platform/runner-host";

/**
 * iOS reports its family, never a model.
 * Apple exposes no marketing-name API: the native model is a hardware identifier ("iPhone17,3"), and iOS 16+ returns a generic name from the user-visible device-name API without a special entitlement.
 */
function describeDevice(info: DeviceInfo): string | null {
  if (info.model.startsWith("iPad")) {
    return "iPad";
  }
  // The platform check catches an iOS device whose identifier is not
  // hardware-shaped, such as a simulator reporting its host architecture.
  if (info.model.startsWith("iPhone") || info.platform === "ios") {
    return "iPhone";
  }
  return info.model.length > 0 ? info.model : null;
}

/**
 * `IRunnerHost.deviceDescriber` for the mobile app: what the approve prompt and the session row call this device.
 * Best-effort and never throws - a failed native call just leaves the caller on its UA fallback.
 */
export class MobileDeviceDescriber implements IDeviceDescriber {
  async describe(): Promise<string | null> {
    try {
      return describeDevice(await Device.getInfo());
    } catch {
      return null;
    }
  }
}
