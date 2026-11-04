# Capacitor 8.4.2 reads these annotation types through reflection. Keeping
# annotated plugins alone lets R8 full mode fold their cached annotation to
# null, crashing permission checks after sign-in (ionic-team/capacitor#8589).
-keep @interface com.getcapacitor.annotation.** { *; }
-keep @interface com.getcapacitor.PluginMethod { *; }
-keep @interface com.getcapacitor.NativePlugin { *; }

# Activity and permission callbacks can live on non-public plugin base classes.
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
}

# The barcode scanner only sets an orientation when asked for portrait or
# landscape, and this app always asks for adaptive. Nothing else here sets one,
# so the calls go, and with them Play's warning about orientation restrictions.
-assumenosideeffects class android.app.Activity {
    public void setRequestedOrientation(int);
}
