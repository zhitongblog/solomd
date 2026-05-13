// Aliyun maven mirror — repo.maven.apache.org keeps dropping TLS handshakes
// through the local Clash proxy. Aliyun's CN mirror is more reliable from
// this network and serves the same artifacts. Same for google() → google-cn
// fallback ordering. If building on a network where direct egress works,
// gradle still falls through to the canonical mirrors below.
buildscript {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
