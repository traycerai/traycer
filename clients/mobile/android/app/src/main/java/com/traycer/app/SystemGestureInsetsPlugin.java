package com.traycer.app;

import android.view.View;
import android.view.ViewTreeObserver;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Reads system gesture ownership without replacing Capacitor's inset listener. */
@CapacitorPlugin(name = "SystemGestureInsets")
public class SystemGestureInsetsPlugin extends Plugin {
    private ViewTreeObserver.OnPreDrawListener observer;
    private int lastLeft = -1;
    private int lastRight = -1;
    private int lastWidth = -1;
    private int sequence = 0;
    private final int[] webLocation = new int[2];
    private final int[] decorLocation = new int[2];

    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            View webView = getBridge().getWebView();
            observer = () -> {
                JSObject geometry = sample();
                if (geometry != null) bridge.execute(() -> notifyListeners("change", geometry));
                return true;
            };
            webView.getViewTreeObserver().addOnPreDrawListener(observer);
        });
    }

    @PluginMethod
    public void get(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject geometry = sample();
            if (geometry != null) {
                JSObject changed = geometry;
                bridge.execute(() -> notifyListeners("change", changed));
            }
            if (geometry == null) geometry = current();
            if (geometry == null) call.reject("Window insets are not available yet");
            else call.resolve(geometry);
        });
    }

    private JSObject sample() {
        View webView = getBridge().getWebView();
        View decor = getActivity().getWindow().getDecorView();
        WindowInsetsCompat windowInsets = ViewCompat.getRootWindowInsets(webView);
        int width = webView.getWidth();
        if (windowInsets == null || width <= 0 || decor.getWidth() <= 0) return null;
        Insets gestures = windowInsets.getInsets(WindowInsetsCompat.Type.systemGestures());
        webView.getLocationInWindow(webLocation);
        decor.getLocationInWindow(decorLocation);
        int webLeft = webLocation[0] - decorLocation[0];
        int left = Math.min(width, Math.max(0, gestures.left - webLeft));
        int right = Math.min(width, Math.max(0, webLeft + width - (decor.getWidth() - gestures.right)));
        if (left == lastLeft && right == lastRight && width == lastWidth) return null;
        lastLeft = left;
        lastRight = right;
        lastWidth = width;
        sequence++;
        return current();
    }

    private JSObject current() {
        if (lastWidth <= 0) return null;
        JSObject geometry = new JSObject();
        geometry.put("left", lastLeft);
        geometry.put("right", lastRight);
        geometry.put("width", lastWidth);
        geometry.put("sequence", sequence);
        return geometry;
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(() -> {
            ViewTreeObserver tree = getBridge().getWebView().getViewTreeObserver();
            if (observer != null && tree.isAlive()) tree.removeOnPreDrawListener(observer);
            observer = null;
        });
        super.handleOnDestroy();
    }
}
