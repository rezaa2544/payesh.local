plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Row 126: the NATIVE owner app replaces the WebView shell apps/owner-panel/android under the
// SAME applicationId (ir.payesh.owner) and the SAME owner key (GitHub Secrets PAYESH_OWNER_*,
// written to runner temp storage by .github/workflows/owner-panel.yml), so an installed WebView
// panel is upgraded in place. No key, password or keystore file ever lives in the repository.
// PAYESH_OWNER_REQUIRE_RELEASE_SIGNING=true makes a missing key a hard error (fail-closed).
val ownerKeystore: String? = System.getenv("PAYESH_OWNER_KEYSTORE")?.takeIf { it.isNotBlank() }
val ownerSigningEnv = listOf("PAYESH_OWNER_KEYSTORE", "PAYESH_OWNER_KEYSTORE_PASS", "PAYESH_OWNER_KEY_ALIAS", "PAYESH_OWNER_KEY_PASS")
val ownerSigningMissing = ownerSigningEnv.filter { System.getenv(it).isNullOrBlank() }
if (System.getenv("PAYESH_OWNER_REQUIRE_RELEASE_SIGNING") == "true" && ownerSigningMissing.isNotEmpty()) {
    throw GradleException("PAYESH-OWNER-SIGNING-REQUIRED: missing " + ownerSigningMissing.joinToString(", "))
}
if (ownerKeystore != null && !file(ownerKeystore).isFile) {
    throw GradleException("PAYESH-OWNER-SIGNING-REQUIRED: PAYESH_OWNER_KEYSTORE does not point to a file")
}

android {
    namespace = "ir.payesh.owner"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "ir.payesh.owner"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // CI passes --build-number=100000+run_number: always above every WebView build
        // (which used the bare run_number), so Android accepts the in-place upgrade.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (ownerSigningMissing.isEmpty()) {
            create("ownerRelease") {
                storeFile = file(ownerKeystore!!)
                storeType = "PKCS12"
                storePassword = System.getenv("PAYESH_OWNER_KEYSTORE_PASS")
                keyAlias = System.getenv("PAYESH_OWNER_KEY_ALIAS")
                keyPassword = System.getenv("PAYESH_OWNER_KEY_PASS")
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isDebuggable = false
            // Owner key when present; otherwise a debug-signed REHEARSAL build that the
            // release step refuses to publish.
            signingConfig = if (ownerSigningMissing.isEmpty()) signingConfigs.getByName("ownerRelease") else signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
