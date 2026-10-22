import UIKit
import WebKit

/// The app's web view, with a "Quote" item in the text-selection edit menu.
///
/// On a phone a selection is built by a long press and handle drag, which
/// raises no `mouseup`, so the GUI's floating quote button (armed on release)
/// never appears; the system edit menu is the affordance instead. Since iOS 16
/// WKWebView builds that menu through `buildMenu(with:)`, so one override adds
/// the item beside Copy and Look Up. Tapping it tells the page, which reads the
/// selection itself and applies the same rules the desktop button does: the
/// native side never sees the selected text. On iOS 15 the override is not
/// consulted and the menu stays the system's.
///
/// The item cannot be shown only for quotable selections: the menu is built
/// synchronously, and whether a selection is quotable is a question only the
/// page can answer. An unquotable one quotes nothing.
final class QuoteEditMenuWebView: WKWebView {
    /// Set by the bridge controller to raise the page's quote request event
    /// (`traycerQuoteSelection`, `use-native-quote-request.ts` in gui-app).
    var onQuoteRequested: (() -> Void)?

    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        // Only the selection menu: the app's other responders build no menus.
        guard builder.system == .context else { return }
        let quote = UIAction(
            title: NSLocalizedString("Quote", comment: "Edit-menu item quoting the selected text into the reply"),
            image: UIImage(systemName: "text.quote")
        ) { [weak self] _ in
            self?.onQuoteRequested?()
        }
        let menu = UIMenu(options: .displayInline, children: [quote])
        if builder.menu(for: .standardEdit) != nil {
            builder.insertSibling(menu, afterMenu: .standardEdit)
        } else {
            builder.insertChild(menu, atStartOfMenu: .root)
        }
    }
}
