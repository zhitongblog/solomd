# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# v4.2.5 issue #73 — APK shrink rules.

# R8 fullMode is more aggressive: enable verbose rule warnings so any
# unintended strip surfaces in build logs (release CI will fail loudly
# rather than silently breaking at runtime).
-printusage build/outputs/r8-usage.txt
-printconfiguration build/outputs/r8-config.txt

# Tauri / wry already keep the bare minimum via proguard-tauri.pro +
# proguard-wry.pro — both are picked up by the fileTree("**/*.pro") glob
# in build.gradle.kts. Nothing extra to keep here.

# Strip all but error logs from production builds. Saves a few KB of
# string constants in classes.dex and prevents debug logs leaking to
# logcat in user installs.
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
}

# Strip Kotlin debug helpers — these are dead weight in release.
-assumenosideeffects class kotlin.jvm.internal.Intrinsics {
    static void checkExpressionValueIsNotNull(java.lang.Object, java.lang.String);
    static void checkFieldIsNotNull(java.lang.Object, java.lang.String);
    static void checkFieldIsNotNull(java.lang.Object, java.lang.String, java.lang.String);
    static void checkNotNull(java.lang.Object);
    static void checkNotNull(java.lang.Object, java.lang.String);
    static void checkNotNullExpressionValue(java.lang.Object, java.lang.String);
    static void checkNotNullParameter(java.lang.Object, java.lang.String);
    static void checkParameterIsNotNull(java.lang.Object, java.lang.String);
    static void checkReturnedValueIsNotNull(java.lang.Object, java.lang.String);
    static void checkReturnedValueIsNotNull(java.lang.Object, java.lang.String, java.lang.String);
}
# SAF JNI surface (#148, 4.9.4) — every method below is called ONLY from Rust
# via JNI (saf_android.rs), so R8 sees zero Java references and strips them in
# release, leaving MainActivity with just its lifecycle overrides. Symptom:
# "Java exception was raised during method invocation" on any SAF invoke in
# 4.9.2/4.9.3 release builds (debug builds unaffected — minify off).
-keep class app.solomd.MainActivity { *; }
-keep class app.solomd.MainActivity$Companion { *; }

# Keep AndroidX EdgeToEdge entrypoints and parameter types un-obfuscated so
# Google Play Console's static analyzer recognizes enableEdgeToEdge() in
# MainActivity.onCreate, while stripping deprecated pre-API-30 status/nav bar
# color setters and SHORT_EDGES cutout mode that trigger Play Console's
# "deprecated edge-to-edge API" warning.
-keep class androidx.activity.EdgeToEdge { *; }
-keep class androidx.activity.ComponentActivity { *; }
-keep class androidx.activity.SystemBarStyle** { *; }
-keep class androidx.core.view.WindowCompat { *; }
-keep class androidx.lifecycle.** { *; }
-keep class androidx.startup.** { *; }

-assumenosideeffects class android.view.Window {
    public void setStatusBarColor(int);
    public void setNavigationBarColor(int);
}
-assumenosideeffects class androidx.activity.EdgeToEdge** {
    void adjustLayoutInDisplayCutoutMode(android.view.Window);
}
-assumenosideeffects interface androidx.activity.EdgeToEdge** {
    void adjustLayoutInDisplayCutoutMode(android.view.Window);
}
