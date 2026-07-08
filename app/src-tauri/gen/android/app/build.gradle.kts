import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "app.solomd"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.solomd"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }

    // Release signing — credentials sourced from env vars set by
    // scripts/build-android.sh (which sources .env.local). If any of them
    // are missing we fall back to debug signing so `tauri android build`
    // without env still works (debug APKs only — not for Play upload).
    signingConfigs {
        create("release") {
            val ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
            val ksPass = System.getenv("ANDROID_KEYSTORE_PASS")
            val kAlias = System.getenv("ANDROID_KEY_ALIAS")
            val kPass  = System.getenv("ANDROID_KEY_PASS")
            if (ksPath != null && ksPass != null && kAlias != null && kPass != null) {
                storeFile = file(ksPath)
                storePassword = ksPass
                keyAlias = kAlias
                keyPassword = kPass
            }
        }
    }

    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            // v4.3.0 issue #73 — resource shrinking is DISABLED because of
            // https://issuetracker.google.com/402800800: AGP 8.x errors out
            // with "Multiple shrunk-resources files found" when
            // `isShrinkResources = true` is combined with `splits.abi.enable
            // = true` and the `bundle*` task is invoked. R8 fullMode +
            // minifyEnabled still strip dead code and most resource refs;
            // we lose only the ~1-3 MB of orphan-drawable/string pruning.
            // Re-enable once AGP ships the fix (tracked upstream).
            // isShrinkResources = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            // v4.3.0 issue #73 — strip debug symbols from native .so libs in
            // release. Tauri's Rust binary normally compiles with `strip = "symbols"`
            // in Cargo.toml, but this provides a belt-and-braces guarantee.
            packaging {
                jniLibs {
                    keepDebugSymbols.clear()
                    // useLegacyPackaging defaults to false in AGP 7+, which
                    // means .so files stay compressed inside the APK rather
                    // than being extracted to /data/app on install — halves
                    // the disk footprint vs legacy mode.
                }
                resources {
                    // Cut Kotlin metadata, license files, and module manifests
                    // that JVM-side tooling reads but Android runtime ignores.
                    excludes += setOf(
                        "/META-INF/{AL2.0,LGPL2.1}",
                        "/META-INF/*.kotlin_module",
                        "/META-INF/versions/**",
                        "/kotlin/**",
                        "/kotlin-tooling-metadata.json",
                        "/DebugProbesKt.bin",
                    )
                }
            }
            val cfg = signingConfigs.getByName("release")
            if (cfg.storeFile != null) {
                signingConfig = cfg
            }
        }
    }

    // Per-architecture APK splits — gives us a separate, smaller APK for
    // arm64 / armv7 / x86_64 sideloads (Play Store consumes the AAB and
    // does the splitting server-side regardless). Without splits the
    // universal APK is ~200MB; per-ABI release APKs come in at ~30-50MB.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = true
        }
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")