import Capacitor
import WebKit

/// The storyboard's bridge controller. `cap sync` auto-registers only the npm
/// plugins in `packageClassList`; a plugin that lives in this app target is
/// registered here.
///
/// It also fences the native bridge and Capacitor's native routes off from
/// sandboxed agent pages and MCP Apps (`SandboxBridgeGuard.swift`). Every guard
/// is installed before the first page loads; the two delegates are held here
/// because WebKit keeps the navigation delegate weakly.
class BridgeViewController: CAPBridgeViewController {
    private let artifactHandler = ArtifactSchemeHandler()
    private var sandboxBridgeGuard: SandboxBridgeGuard?
    private var sandboxNavigationGuard: SandboxNavigationGuard?
    private var statusBarTapObserver: NSObjectProtocol?

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // A handler must be present before WKWebView exists. Capacitor adds its
        // app scheme afterwards; artifact bytes never enter that native router.
        configuration.setURLSchemeHandler(artifactHandler, forURLScheme: ArtifactSchemeHandler.scheme)
        return configuration
    }

    override func capacitorDidLoad() {
        let artifacts = SandboxArtifactsPlugin()
        artifacts.handler = artifactHandler
        artifactHandler.plugin = artifacts
        bridge?.registerPluginInstance(artifacts)
        bridge?.registerPluginInstance(AuthSessionPlugin())
        installSandboxGuards()
        forwardStatusBarTaps()
        forwardQuoteRequests()
    }

    /// The web view with "Quote" in its text-selection edit menu
    /// (`QuoteEditMenuWebView.swift`); Capacitor hands it the frame and the
    /// configuration it would have given a plain `WKWebView`.
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        return QuoteEditMenuWebView(frame: frame, configuration: configuration)
    }

    /// Forwarded like the status-bar tap: the edit menu's item raises the
    /// `traycerQuoteSelection` window event, and the GUI's own listener reads
    /// the selection and quotes it. The event reaches the app's document
    /// only, never a sandboxed page.
    private func forwardQuoteRequests() {
        (webView as? QuoteEditMenuWebView)?.onQuoteRequested = { [weak self] in
            self?.bridge?.triggerWindowJSEvent(eventName: "traycerQuoteSelection")
        }
    }

    deinit {
        if let statusBarTapObserver {
            NotificationCenter.default.removeObserver(statusBarTapObserver)
        }
    }

    private func installSandboxGuards() {
        // Capacitor's one delegation handler is the navigation delegate, the
        // `bridge` script-message handler and the owner of the content
        // controller that handler is registered on.
        guard let webView, let appOrigin = bridge?.config.serverURL,
              let capacitorHandler = webView.navigationDelegate as? WebViewDelegationHandler
        else {
            // Without the guard every frame can reach every plugin: fail loudly
            // in development, and say so in the native log everywhere.
            CAPLog.print("⚡️  Sandbox bridge guard could not be installed")
            assertionFailure("Sandbox bridge guard could not be installed")
            return
        }
        sandboxBridgeGuard = SandboxBridgeGuard.install(
            on: capacitorHandler.contentController,
            forwardingTo: capacitorHandler,
            appOrigin: appOrigin
        )
        let navigationGuard = SandboxNavigationGuard(inner: capacitorHandler, appOrigin: appOrigin)
        sandboxNavigationGuard = navigationGuard
        webView.navigationDelegate = navigationGuard
        // The scheme Capacitor serves the app and its native routes on, which
        // stays `capacitor:` even when live reload points the app elsewhere.
        let installed = bridge.map {
            NativeRouteTokenAssetHandler.install(
                on: webView,
                scheme: $0.config.localURL.scheme ?? "capacitor",
                contentController: capacitorHandler.contentController
            )
        } ?? false
        if !installed {
            CAPLog.print("⚡️  Native route token guard could not be installed")
            assertionFailure("Native route token guard could not be installed")
        }
    }

    /// Capacitor already notices every status-bar tap but tells only native
    /// code: its `UIStatusBarManager+CAPHandleTapAction.m` swizzles
    /// `handleTapAction:` and posts `.capacitorStatusBarTapped`, so nothing in
    /// this app has to detect the tap. Forwarded as the `statusTap` window
    /// event (the name `@capacitor/status-bar` would use), which
    /// `src/status-bar-tap.ts` hands to the GUI as its scroll-to-top gesture.
    /// It reaches the app's own document only: evaluating script on the web
    /// view runs in the main frame, never in a sandboxed page.
    private func forwardStatusBarTaps() {
        statusBarTapObserver = NotificationCenter.default.addObserver(
            forName: .capacitorStatusBarTapped,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.bridge?.triggerWindowJSEvent(eventName: "statusTap")
        }
    }
}
