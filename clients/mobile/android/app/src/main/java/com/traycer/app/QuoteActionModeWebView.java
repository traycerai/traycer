package com.traycer.app;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import com.getcapacitor.Bridge;
import com.getcapacitor.CapacitorWebView;

/**
 * The app's web view, with a "Quote" item in the text-selection action mode.
 *
 * On a phone a selection is built by a long press and handle drag, which
 * raises no mouseup, so the GUI's floating quote button (armed on release)
 * never appears; the selection toolbar is the affordance instead. The WebView
 * starts that toolbar through startActionMode on itself, so wrapping the
 * callback here adds the item beside Copy and Share. Tapping it tells the
 * page, which reads the selection itself and applies the same rules the
 * desktop button does: the native side never sees the selected text.
 *
 * The item cannot be shown only for quotable selections: the menu is built
 * before the page could be asked. An unquotable one quotes nothing.
 *
 * Installed by the app's copy of capacitor_bridge_layout_main.xml, which
 * overrides the library's layout of the same name with this class.
 */
public class QuoteActionModeWebView extends CapacitorWebView {
    /** The page's quote request event (use-native-quote-request.ts in gui-app). */
    private static final String QUOTE_REQUEST_EVENT = "traycerQuoteSelection";
    private static final int QUOTE_ITEM_ID = Menu.FIRST;

    private Bridge quoteBridge;

    public QuoteActionModeWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public void setBridge(Bridge bridge) {
        super.setBridge(bridge);
        quoteBridge = bridge;
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback) {
        return super.startActionMode(withQuoteItem(callback));
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        return super.startActionMode(withQuoteItem(callback), type);
    }

    private ActionMode.Callback withQuoteItem(ActionMode.Callback inner) {
        if (inner == null) {
            return null;
        }
        return new ActionMode.Callback() {
            @Override
            public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                boolean created = inner.onCreateActionMode(mode, menu);
                if (created && menu.findItem(QUOTE_ITEM_ID) == null) {
                    menu.add(Menu.NONE, QUOTE_ITEM_ID, Menu.NONE, R.string.quote_selection)
                        .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
                }
                return created;
            }

            @Override
            public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                return inner.onPrepareActionMode(mode, menu);
            }

            @Override
            public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                if (item.getItemId() != QUOTE_ITEM_ID) {
                    return inner.onActionItemClicked(mode, item);
                }
                Bridge bridge = quoteBridge;
                if (bridge != null) {
                    bridge.triggerWindowJSEvent(QUOTE_REQUEST_EVENT);
                }
                mode.finish();
                return true;
            }

            @Override
            public void onDestroyActionMode(ActionMode mode) {
                inner.onDestroyActionMode(mode);
            }
        };
    }
}
