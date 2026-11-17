package ir.payesh.owner

import android.content.Context
import android.os.Build
import android.security.KeyPairGeneratorSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.util.Calendar
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.security.auth.x500.X500Principal

/**
 * Small-secret store of the owner app (copied from the school app, row 72): AES-256-GCM with a non-exportable key generated inside
 * Android Keystore (alias payesh_secure_v1, hardware-backed where the device supports it).
 * Only iv||ciphertext (base64) is written to private SharedPreferences; the entry name is
 * bound as AAD so blobs cannot be swapped between entries. Backups are disabled in the manifest.
 *
 * Row 168 — Android 5.0/5.1 (API 21/22) have no AES keys in Android Keystore (KeyGenParameterSpec
 * is API 23): there a random AES-256 key is wrapped with a non-exportable RSA-2048 key pair that
 * lives in Android Keystore (KeyPairGeneratorSpec, API 18) and only the wrapped key is stored.
 * The scheme is fixed per installation (MODE_KEY), so an OS upgrade to 6.0+ keeps reading the
 * existing entries.
 */
class KeystoreSecureStore(private val context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var cached: SecretKey? = null

    @Synchronized
    private fun key(): SecretKey {
        cached?.let { return it }
        val mode = prefs.getString(MODE_KEY, null)
            ?: (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) MODE_KEYSTORE_AES else MODE_WRAPPED)
                .also { check(prefs.edit().putString(MODE_KEY, it).commit()) { "secure store mode not persisted" } }
        val k = if (mode == MODE_WRAPPED) wrappedKey() else keystoreKey()
        cached = k
        return k
    }

    private fun keystoreKey(): SecretKey {
        check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) { "keystore AES needs Android 6.0" }
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return generateKeystoreKey()
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.M)
    private fun generateKeystoreKey(): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return gen.generateKey()
    }

    // API 21/22: AES-256 key wrapped by an Android Keystore RSA key pair (RSA/ECB/PKCS1Padding,
    // the only RSA transformation Keystore supports there, via the AndroidOpenSSL provider).
    @Suppress("DEPRECATION")
    private fun wrappedKey(): SecretKey {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        val rsaAlias = ALIAS + "_rsa"
        if (!ks.containsAlias(rsaAlias)) {
            val start = Calendar.getInstance()
            val end = Calendar.getInstance().apply { add(Calendar.YEAR, 100) }
            val gen = KeyPairGenerator.getInstance("RSA", PROVIDER)
            gen.initialize(
                KeyPairGeneratorSpec.Builder(context)
                    .setAlias(rsaAlias)
                    .setSubject(X500Principal("CN=" + rsaAlias))
                    .setSerialNumber(BigInteger.ONE)
                    .setKeySize(2048)
                    .setStartDate(start.time)
                    .setEndDate(end.time)
                    .build()
            )
            gen.generateKeyPair()
            prefs.edit().remove(WRAPPED_KEY).commit() // a new pair cannot unwrap an old key
        }
        val entry = ks.getEntry(rsaAlias, null) as KeyStore.PrivateKeyEntry
        prefs.getString(WRAPPED_KEY, null)?.let { b64 ->
            val c = rsaCipher()
            c.init(Cipher.DECRYPT_MODE, entry.privateKey as PrivateKey)
            return SecretKeySpec(c.doFinal(Base64.decode(b64, Base64.NO_WRAP)), "AES")
        }
        val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val c = rsaCipher()
        c.init(Cipher.ENCRYPT_MODE, entry.certificate.publicKey)
        val wrapped = Base64.encodeToString(c.doFinal(raw), Base64.NO_WRAP)
        check(prefs.edit().putString(WRAPPED_KEY, wrapped).commit()) { "secure store key not persisted" }
        return SecretKeySpec(raw, "AES")
    }

    private fun rsaCipher(): Cipher =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) Cipher.getInstance(RSA_TRANSFORM, "AndroidOpenSSL")
        else Cipher.getInstance(RSA_TRANSFORM)

    private fun checkName(name: String): String {
        require(NAME.matches(name)) { "invalid key name" }
        return name
    }

    fun write(name: String, value: String) {
        checkName(name)
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, key())
        c.updateAAD(name.toByteArray(Charsets.UTF_8))
        val ct = c.doFinal(value.toByteArray(Charsets.UTF_8))
        val blob = c.iv + ct
        check(prefs.edit().putString(name, Base64.encodeToString(blob, Base64.NO_WRAP)).commit()) {
            "secure store write not persisted"
        }
    }

    fun read(name: String): String? {
        checkName(name)
        val s = prefs.getString(name, null) ?: return null
        val blob = Base64.decode(s, Base64.NO_WRAP)
        require(blob.size > IV_BYTES) { "corrupted entry" }
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, blob, 0, IV_BYTES))
        c.updateAAD(name.toByteArray(Charsets.UTF_8))
        return String(c.doFinal(blob, IV_BYTES, blob.size - IV_BYTES), Charsets.UTF_8)
    }

    fun delete(name: String) {
        checkName(name)
        check(prefs.edit().remove(name).commit()) { "secure store delete not persisted" }
    }

    companion object {
        private const val PROVIDER = "AndroidKeyStore"
        private const val ALIAS = "payesh_owner_secure_v1"
        private const val PREFS = "payesh_owner_secure_v1"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val RSA_TRANSFORM = "RSA/ECB/PKCS1Padding"
        // names that the entry regex (NAME) can never produce
        private const val MODE_KEY = "__key_mode"
        private const val WRAPPED_KEY = "__wrapped_key"
        private const val MODE_KEYSTORE_AES = "keystore-aes"
        private const val MODE_WRAPPED = "rsa-wrapped-aes"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private val NAME = Regex("^[a-z0-9][a-z0-9._-]{0,63}$")
    }
}
