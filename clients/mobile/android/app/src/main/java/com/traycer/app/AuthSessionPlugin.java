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
        try {
            tab.launchUrl(getActivity(), Uri.parse(url));
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
