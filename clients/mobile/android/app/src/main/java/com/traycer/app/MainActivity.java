package com.traycer.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // `cap sync` auto-registers only the npm plugins; a plugin that lives
        // in this app module is registered here, before the bridge loads.
        registerPlugin(AuthSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
