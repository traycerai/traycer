import AuthenticationServices
import Capacitor

/// The in-app sign-in sheet (see `src/auth-sheet.ts`): an
/// ASWebAuthenticationSession, which shares Safari's cookies, passwords and
/// passkeys and intercepts the `callbackScheme://` return link itself. Not an
/// SFSafariViewController - that has an app-isolated cookie jar since iOS 11.
///
/// `open` resolves when the sheet CLOSES: `callback` if the return link
/// fired, `dismissed` otherwise. `close` cancels a sheet that is still up.
@objc(AuthSessionPlugin)
public class AuthSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AuthSessionPlugin"
    public let jsName = "AuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private var session: ASWebAuthenticationSession?
    private var pendingOpen: CAPPluginCall?
    /// Bumped by `dismiss()`, so a cancelled session's completion - which
    /// arrives asynchronously - cannot settle the sheet that replaced it.
    private var sessionGeneration = 0

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString),
              let callbackScheme = call.getString("callbackScheme") else {
            call.reject("url and callbackScheme are required")
            return
        }
        DispatchQueue.main.async {
            self.dismiss()
            let generation = self.sessionGeneration
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, _ in
                guard let self, self.sessionGeneration == generation else { return }
                self.session = nil
                self.settle(outcome: callbackURL == nil ? "dismissed" : "callback")
            }
            session.presentationContextProvider = self
            // The default, stated: sharing Safari's cookie jar is the point.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            self.pendingOpen = call
            if !session.start() {
                self.session = nil
                self.pendingOpen = nil
                call.reject("The sign-in sheet could not be presented")
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.dismiss()
            call.resolve()
        }
    }

    private func dismiss() {
        sessionGeneration += 1
        session?.cancel()
        session = nil
        settle(outcome: "dismissed")
    }

    private func settle(outcome: String) {
        guard let call = pendingOpen else { return }
        pendingOpen = nil
        call.resolve(["outcome": outcome])
    }
}

extension AuthSessionPlugin: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
