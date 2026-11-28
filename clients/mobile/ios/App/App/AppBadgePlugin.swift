import Capacitor
import UIKit
import UserNotifications

/// The number on the app icon (see `src/app-badge.ts`). The app writes the
/// count it shows; while the app is closed the server's count pushes set it.
@objc(AppBadgePlugin)
public class AppBadgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppBadgePlugin"
    public let jsName = "AppBadge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setCount", returnType: CAPPluginReturnPromise),
    ]

    @objc func setCount(_ call: CAPPluginCall) {
        guard let count = call.getInt("count"), count >= 0 else {
            call.reject("count must be a non-negative integer")
            return
        }
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(count) { error in
                if let error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve()
                }
            }
        } else {
            DispatchQueue.main.async {
                UIApplication.shared.applicationIconBadgeNumber = count
                call.resolve()
            }
        }
    }
}
