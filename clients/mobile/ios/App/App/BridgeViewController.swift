import Capacitor

/// The storyboard's bridge controller. `cap sync` auto-registers only the npm
/// plugins in `packageClassList`; a plugin that lives in this app target is
/// registered here, and this is the only such plugin.
class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AuthSessionPlugin())
    }
}
