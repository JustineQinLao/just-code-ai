package com.justcode.phone

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.net.HttpURLConnection
import java.net.URI

/** A pairing link, e.g. http://192.168.1.5:7878/?pair=abc (single use). After the first load the saved link is just the origin; the WebView cookie keeps the session. */
object Pairing {
    private fun prefs(c: Context) = EncryptedSharedPreferences.create(
        c, "pairing", MasterKey.Builder(c).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)

    fun load(c: Context): String? = prefs(c).getString("link", null)
    fun save(c: Context, link: String) = prefs(c).edit().putString("link", link).apply()
    fun forget(c: Context) = prefs(c).edit().remove("link").apply()

    /** Returns the normalised link, or null if it is not an http(s) URL with a pair= (or legacy token=) code. */
    fun parse(raw: String): String? = try {
        val u = URI(raw.trim())
        val ok = (u.scheme == "http" || u.scheme == "https") && !u.host.isNullOrEmpty()
        if (ok && Regex("(^|&)(pair|token)=[^&]+").containsMatchIn(u.rawQuery ?: "")) u.toString() else null
    } catch (e: Exception) { null }

    /** http://host:port/ without any query: what we keep after the one-time code is used. */
    fun origin(link: String): String { val u = URI(link); return "${u.scheme}://${u.host}${if (u.port >= 0) ":${u.port}" else ""}/" }

    sealed class Check { object Ok : Check(); object Unauthorized : Check(); class Unreachable(val why: String) : Check() }

    /** Call off the main thread. */
    fun check(link: String): Check = try {
        val u = URI(link)
        val q = u.rawQuery ?: ""
        val token = Regex("(^|&)token=([^&]+)").find(q)?.groupValues?.get(2)
        val isPair = Regex("(^|&)pair=[^&]+").containsMatchIn(q)
        val c = java.net.URL(origin(link) + "api/state").openConnection() as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 5000
        if (token != null) c.setRequestProperty("x-token", token)
        else if (!isPair) android.webkit.CookieManager.getInstance().getCookie(origin(link))?.let { c.setRequestProperty("Cookie", it) }
        // A pair= code is single use, so it is never sent here (the WebView redeems it); a 401 just proves the server is up.
        when (val code = c.responseCode) {
            200 -> Check.Ok
            401 -> if (isPair) Check.Ok else Check.Unauthorized
            else -> Check.Unreachable("Server answered $code")
        }
    } catch (e: Exception) { Check.Unreachable(e.message ?: e.javaClass.simpleName) }
}
