package com.traycer.app;

import android.content.Context;
import android.graphics.Rect;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
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
    /**
     * Raises the page's quote request event (use-native-quote-request.ts in
     * gui-app): the script Bridge.triggerWindowJSEvent builds, spelled here
     * because that method takes no completion, and the action mode must
     * outlive the page's read of the selection (below).
     */
    private static final String QUOTE_REQUEST_SCRIPT =
        "window.Capacitor.triggerEvent(\"traycerQuoteSelection\", \"window\")";
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

    /**
     * A Callback2, whatever the inner callback is: the selection toolbar is a
     * floating action mode, which the system positions through
     * onGetContentRect so it never covers the selected text. The WebView's
     * own callback is a Callback2 that reports the selection bounds; wrapping
     * it in a plain Callback would drop that and leave the toolbar on the
     * default (whole-view) rect.
     */
    private ActionMode.Callback withQuoteItem(ActionMode.Callback inner) {
        if (inner == null) {
            return null;
        }
        return new ActionMode.Callback2() {
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
                if (bridge == null) {
                    mode.finish();
                    return true;
                }
                // Finish only once the page has handled the event: the
                // evaluation is posted, and finishing the mode first could
                // clear the selection before the listener reads it. The event
                // dispatch is synchronous inside the evaluated script, so the
                // completion callback runs after the quote is in the draft.
                bridge.eval(QUOTE_REQUEST_SCRIPT, value -> mode.finish());
                return true;
            }

            @Override
            public void onDestroyActionMode(ActionMode mode) {
                inner.onDestroyActionMode(mode);
            }

            @Override
            public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
                if (inner instanceof ActionMode.Callback2) {
                    ((ActionMode.Callback2) inner).onGetContentRect(mode, view, outRect);
                } else {
                    super.onGetContentRect(mode, view, outRect);
                }
            }
        };
    }
}
