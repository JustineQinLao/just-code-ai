package com.justcode.phone

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.net.HttpURLConnection
import java.net.URI

/** The saved link, e.g. http://192.168.1.5:7878/?token=abc */
object Pairing {
    private fun prefs(c: Context) = EncryptedSharedPreferences.create(
        c, "pairing", MasterKey.Builder(c).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)

    fun load(c: Context): String? = prefs(c).getString("link", null)
    fun save(c: Context, link: String) = prefs(c).edit().putString("link", link).apply()
    fun forget(c: Context) = prefs(c).edit().remove("link").apply()

    /** Returns the normalised link, or null if it is not an http(s) URL with a token. */
    fun parse(raw: String): String? = try {
        val u = URI(raw.trim())
        val ok = (u.scheme == "http" || u.scheme == "https") && !u.host.isNullOrEmpty()
        if (ok && Regex("(^|&)token=[^&]+").containsMatchIn(u.rawQuery ?: "")) u.toString() else null
    } catch (e: Exception) { null }

    sealed class Check { object Ok : Check(); object Unauthorized : Check(); class Unreachable(val why: String) : Check() }

    /** Call off the main thread. */
    fun check(link: String): Check = try {
        val u = URI(link)
        val token = Regex("token=([^&]+)").find(u.rawQuery!!)!!.groupValues[1]
        val port = if (u.port >= 0) ":${u.port}" else ""
        val c = java.net.URL("${u.scheme}://${u.host}$port/api/state").openConnection() as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 5000; c.setRequestProperty("x-token", token)
        when (val code = c.responseCode) {
            200 -> Check.Ok
            401 -> Check.Unauthorized
            else -> Check.Unreachable("Server answered $code")
        }
    } catch (e: Exception) { Check.Unreachable(e.message ?: e.javaClass.simpleName) }
}
