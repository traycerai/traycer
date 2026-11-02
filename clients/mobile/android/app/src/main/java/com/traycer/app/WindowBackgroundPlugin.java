package com.traycer.app;

import android.graphics.Color;
import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Paints the view behind the web view (see src/window-background.ts). A web
 * view older than Capacitor's safe-area fix gets native padding for the system
 * bars and any cutout, so that view shows beside the page and has to match it.
 * This is the padded view rather than the window's decor view, which SystemBars
 * repaints from the launch theme on every configuration change.
 */
@CapacitorPlugin(name = "WindowBackground")
public class WindowBackgroundPlugin extends Plugin {

    @PluginMethod
    public void set(PluginCall call) {
        String color = call.getString("color");
        if (color == null) {
            call.reject("color is required");
            return;
        }
        final int parsed;
        try {
            parsed = Color.parseColor(color);
        } catch (IllegalArgumentException error) {
            call.reject("color is not a color");
            return;
        }
        getActivity().runOnUiThread(() -> {
            ((View) getBridge().getWebView().getParent()).setBackgroundColor(parsed);
            call.resolve();
        });
    }
}
