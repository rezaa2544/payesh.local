plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Row 76: release signing comes ONLY from the environment (GitHub Secrets in CI,
// prepared into runner temp storage by .github/workflows/native-client.yml):
//   PAYESH_KEYSTORE (path to the PKCS12 file), PAYESH_KEYSTORE_PASS,
//   PAYESH_KEY_ALIAS, PAYESH_KEY_PASS — the same secrets as row 61 (owner key).
// No key, password or keystore file ever lives in the repository.
// PAYESH_NATIVE_REQUIRE_RELEASE_SIGNING=true makes a missing key a hard error
// (fail-closed) instead of the debug-signed rehearsal build.
val payeshKeystore: String? = System.getenv("PAYESH_KEYSTORE")?.takeIf { it.isNotBlank() }
val payeshSigningEnv = listOf("PAYESH_KEYSTORE", "PAYESH_KEYSTORE_PASS", "PAYESH_KEY_ALIAS", "PAYESH_KEY_PASS")
val payeshSigningMissing = payeshSigningEnv.filter { System.getenv(it).isNullOrBlank() }
val payeshRequireRelease = System.getenv("PAYESH_NATIVE_REQUIRE_RELEASE_SIGNING") == "true"
if (payeshRequireRelease && payeshSigningMissing.isNotEmpty()) {
    throw GradleException("PAYESH-SIGNING-REQUIRED: release signing required but missing: " + payeshSigningMissing.joinToString(", "))
}
if (payeshKeystore != null && !file(payeshKeystore).isFile) {
    throw GradleException("PAYESH-SIGNING-REQUIRED: PAYESH_KEYSTORE does not point to a file")
}

android {
    namespace = "ir.payesh.school.payesh_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "ir.payesh.school.payesh_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (payeshSigningMissing.isEmpty()) {
            create("payeshRelease") {
                storeFile = file(payeshKeystore!!)
                storeType = "PKCS12"
                storePassword = System.getenv("PAYESH_KEYSTORE_PASS")
                keyAlias = System.getenv("PAYESH_KEY_ALIAS")
                keyPassword = System.getenv("PAYESH_KEY_PASS")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isDebuggable = false
            // Owner key from the environment when present; otherwise a debug-signed
            // REHEARSAL build (tools/android-release-check-76.mjs labels it
            // "not for distribution" and the release gate refuses it).
            signingConfig = if (payeshSigningMissing.isEmpty()) signingConfigs.getByName("payeshRelease") else signingConfigs.getByName("debug")
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
