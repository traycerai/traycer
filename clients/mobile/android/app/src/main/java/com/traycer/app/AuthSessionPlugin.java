package com.traycer.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The in-app sign-in sheet (see src/auth-sheet.ts): a Chrome Custom Tab,
 * which shares the browser's cookies so the approval page opens already
 * signed in, and presents as a partial-height sheet where the browser
 * supports it (Chrome 107+; older ones show it full screen).
 *
 * The tab is started FOR A RESULT on purpose. Chrome honours the initial
 * height only when it can tell which activity to resize over: the launch
 * must either carry a CustomTabsSession or come through
 * startActivityForResult. A plain launchUrl ignores the height and opens
 * full screen. The result itself is unused: BridgeActivity drops a request
 * code no plugin claims.
 *
 * The tab is a separate activity the app does not own, so there is no
 * completion to report: `open` resolves once the tab is launched. The
 * approval page's return link brings the singleTask MainActivity forward,
 * which finishes the tab, and the App plugin's appUrlOpen carries the return
 * signal from there.
 */
@CapacitorPlugin(name = "AuthSession")
public class AuthSessionPlugin extends Plugin {
    /** Initial sheet height as a share of the screen; the user can drag it to full height. */
    private static final float INITIAL_HEIGHT_FRACTION = 0.85f;
    /** Request code for the tab's (unused) activity result; no Capacitor plugin claims it. */
    static final int SIGN_IN_TAB_REQUEST_CODE = 0x5A17;

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        int screenHeight = getActivity().getResources().getDisplayMetrics().heightPixels;
        CustomTabsIntent tab = new CustomTabsIntent.Builder()
            .setInitialActivityHeightPx(Math.round(screenHeight * INITIAL_HEIGHT_FRACTION))
            .build();
        tab.intent.setData(Uri.parse(url));
        try {
            getActivity().startActivityForResult(tab.intent, SIGN_IN_TAB_REQUEST_CODE);
        } catch (ActivityNotFoundException error) {
            call.reject("No browser can present the sign-in sheet");
            return;
        }
        JSObject result = new JSObject();
        result.put("outcome", "opened");
        call.resolve(result);
    }

    /** Brings MainActivity back on top, which finishes a tab still above it. */
    @PluginMethod
    public void close(PluginCall call) {
        Intent intent = new Intent(getContext(), getActivity().getClass());
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        getActivity().startActivity(intent);
        call.resolve();
    }
}
