package com.traycer.app;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
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
        String top = call.getString("top");
        String rest = call.getString("rest");
        Float topDepth = call.getFloat("topDepth");
        if (top == null || rest == null || topDepth == null) {
            call.reject("top, topDepth and rest are required");
            return;
        }
        final int topColor;
        final int restColor;
        try {
            topColor = Color.parseColor(top);
            restColor = Color.parseColor(rest);
        } catch (IllegalArgumentException error) {
            call.reject("top and rest must be colors");
            return;
        }
        getActivity().runOnUiThread(() -> {
            View padded = (View) getBridge().getWebView().getParent();
            padded.setBackground(new SystemBarBands(padded, topColor, topDepth, restColor));
            call.resolve();
        });
    }

    /** The status bar's band and what continues it beside the page, then the rest. */
    private static final class SystemBarBands extends Drawable {

        private final View padded;
        private final Paint topPaint = new Paint();
        private final float topDepthPx;
        private final int restColor;

        SystemBarBands(View padded, int topColor, float topDepth, int restColor) {
            this.padded = padded;
            this.topDepthPx = topDepth * padded.getResources().getDisplayMetrics().density;
            this.restColor = restColor;
            topPaint.setColor(topColor);
        }

        @Override
        public void draw(Canvas canvas) {
            canvas.drawColor(restColor);
            canvas.drawRect(0, 0, getBounds().width(), padded.getPaddingTop() + topDepthPx, topPaint);
        }

        @Override
        public void setAlpha(int alpha) {}

        @Override
        public void setColorFilter(ColorFilter colorFilter) {}

        @Override
        public int getOpacity() {
            return PixelFormat.OPAQUE;
        }
    }
}
