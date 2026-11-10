package ir.payesh.school.payesh_app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small-secret store (row 72): AES-256-GCM with a non-exportable key generated inside
 * Android Keystore (alias payesh_secure_v1, hardware-backed where the device supports it).
 * Only iv||ciphertext (base64) is written to private SharedPreferences; the entry name is
 * bound as AAD so blobs cannot be swapped between entries. Backups are disabled in the manifest.
 */
class KeystoreSecureStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
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
        private const val ALIAS = "payesh_secure_v1"
        private const val PREFS = "payesh_secure_v1"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private val NAME = Regex("^[a-z0-9][a-z0-9._-]{0,63}$")
    }
}
