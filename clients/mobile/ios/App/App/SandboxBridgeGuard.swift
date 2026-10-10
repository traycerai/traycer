import Capacitor
import WebKit

/// Keeps the native bridge to the app's own top-level document.
///
/// Agent pages, wireframes and MCP Apps render in the bundled sandbox loader
/// (`/sandbox/index.html`) inside an opaque `<iframe sandbox>`. WebKit exposes
/// `window.webkit.messageHandlers.bridge` to every frame regardless of origin,
/// and Capacitor's handler never asks which frame a message came from - so
/// without this, any page could call any plugin.
///
/// iOS links Capacitor from the `capacitor-swift-pm` binary package, so this is
/// app-target code rather than a patch of Capacitor's sources.
final class SandboxBridgeGuard: NSObject, WKScriptMessageHandler {
    static let handlerName = "bridge"

    private weak var target: WKScriptMessageHandler?
    private let appOrigin: URL

    init(target: WKScriptMessageHandler, appOrigin: URL) {
        self.target = target
        self.appOrigin = appOrigin
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, Self.isSameOrigin(origin, appOrigin) else {
            CAPLog.print("⚡️  Sandbox bridge guard dropped a message from a non-app frame")
            return
        }
        target?.userContentController(userContentController, didReceive: message)
    }

    static func isSameOrigin(_ origin: WKSecurityOrigin, _ url: URL) -> Bool {
        guard let scheme = url.scheme, let host = url.host else { return false }
        return origin.protocol == scheme && origin.host == host && origin.port == (url.port ?? 0)
    }

    /// Replace Capacitor's `bridge` handler on `contentController` with a guard
    /// in front of it.
    static func install(
        on contentController: WKUserContentController,
        forwardingTo handler: WKScriptMessageHandler,
        appOrigin: URL
    ) -> SandboxBridgeGuard {
        let guarded = SandboxBridgeGuard(target: handler, appOrigin: appOrigin)
        contentController.removeScriptMessageHandler(forName: handlerName)
        contentController.add(guarded, name: handlerName)
        return guarded
    }
}

/// Cancels a subframe navigation to any app-origin URL other than the sandbox
/// loader, before the request. The shell's `frame-src 'self'` keeps the
/// sandbox frame on the app origin; this keeps it on the loader. Everything
/// else - every main-frame decision included - is Capacitor's own delegate.
final class SandboxNavigationGuard: NSObject, WKNavigationDelegate {
    static let loaderPath = "/sandbox/index.html"
    private static let decideActionSelector = NSSelectorFromString(
        "webView:decidePolicyForNavigationAction:decisionHandler:"
    )
    /// WebKit prefers this variant when a delegate answers to it, which would
    /// route around the guard above, so it is never forwarded.
    private static let decideActionWithPreferencesSelector = NSSelectorFromString(
        "webView:decidePolicyForNavigationAction:preferences:decisionHandler:"
    )

    private weak var inner: WKNavigationDelegate?
    private let appOrigin: URL

    init(inner: WKNavigationDelegate, appOrigin: URL) {
        self.inner = inner
        self.appOrigin = appOrigin
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if Self.isBlockedSubframeNavigation(navigationAction, appOrigin: appOrigin) {
            CAPLog.print("⚡️  Sandbox navigation guard blocked a subframe navigation")
            decisionHandler(.cancel)
            return
        }
        guard let inner, inner.responds(to: Self.decideActionSelector) else {
            decisionHandler(.allow)
            return
        }
        inner.webView?(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    static func isBlockedSubframeNavigation(_ action: WKNavigationAction, appOrigin: URL) -> Bool {
        guard let target = action.targetFrame, !target.isMainFrame else { return false }
        guard let url = action.request.url else { return true }
        let sameOrigin = url.scheme == appOrigin.scheme && url.host == appOrigin.host && url.port == appOrigin.port
        return sameOrigin && url.path != loaderPath
    }

    // Every other delegate method goes to Capacitor's handler untouched.
    override func responds(to aSelector: Selector!) -> Bool {
        if aSelector == Self.decideActionWithPreferencesSelector { return false }
        if super.responds(to: aSelector) { return true }
        return inner?.responds(to: aSelector) ?? false
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if aSelector == Self.decideActionWithPreferencesSelector { return nil }
        if let inner, inner.responds(to: aSelector) { return inner }
        return super.forwardingTarget(for: aSelector)
    }
}

/// Refuses every request for a Capacitor native route (`/_capacitor_*`: the
/// native HTTP proxy, the file route) that lacks this launch's token, before
/// any native I/O. WebKit hands this handler every `capacitor:` load from any
/// frame, so a page framed inside a sandbox page (an open page's iframe, an MCP
/// App's declared frame domain) could otherwise reach the proxy and make native
/// HTTP requests outside CORS.
///
/// Only the app's top-level document holds the token (`mainFrameScript`, a
/// main-frame-only user script), and the app attaches it to Capacitor's own
/// proxy requests (`src/web/native-http-token.ts`). It rides as a query
/// parameter because Capacitor builds the outgoing request from `u` alone and
/// forwards every request header.
///
/// Capacitor creates its asset handler inside a `final` `loadView`, so this
/// class is swapped onto that instance (`install`). It adds no stored
/// properties, which is what makes the swap safe.
final class NativeRouteTokenAssetHandler: WebViewAssetHandler {
    static let tokenParam = "traycer_native_http_token"
    private static let routePrefix = "/_capacitor_"

    /// A fresh 256-bit token per launch. `SystemRandomNumberGenerator` is a
    /// cryptographically secure source on Apple platforms.
    static let token: String = (0..<32)
        .map { _ in String(format: "%02x", UInt8.random(in: .min ... .max)) }
        .joined()

    /// Defines the token on the top-level app document only.
    static var mainFrameScript: WKUserScript {
        WKUserScript(
            source: "if (window.top === window) Object.defineProperty(window, '__traycerNativeHttpToken', { value: '\(token)' });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    override func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        if let url = urlSchemeTask.request.url, url.path.hasPrefix(Self.routePrefix), !Self.carriesToken(url) {
            CAPLog.print("⚡️  Native route request without the native route token refused")
            if let response = HTTPURLResponse(url: url, statusCode: 403, httpVersion: nil, headerFields: ["Content-Type": "text/plain"]) {
                urlSchemeTask.didReceive(response)
            }
            urlSchemeTask.didReceive(Data())
            urlSchemeTask.didFinish()
            return
        }
        super.webView(webView, start: urlSchemeTask)
    }

    /// Compared in constant time.
    static func carriesToken(_ url: URL) -> Bool {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let given = items.first(where: { $0.name == tokenParam })?.value else { return false }
        let lhs = Array(given.utf8)
        let rhs = Array(token.utf8)
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    /// Swap this class onto Capacitor's own handler for `scheme`, and hand the
    /// token to the main frame. `false` when the handler is not exactly
    /// Capacitor's, so nothing was swapped.
    static func install(on webView: WKWebView, scheme: String, contentController: WKUserContentController) -> Bool {
        guard let handler = webView.configuration.urlSchemeHandler(forURLScheme: scheme),
              let handlerClass = object_getClass(handler),
              ObjectIdentifier(handlerClass) == ObjectIdentifier(WebViewAssetHandler.self)
        else { return false }
        object_setClass(handler, NativeRouteTokenAssetHandler.self)
        contentController.addUserScript(mainFrameScript)
        return true
    }
}
