package com.justcode.phone

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.net.HttpURLConnection
import java.net.URI

/** A pairing link, e.g. http://192.168.1.5:7878/?pair=123456 (single use). With TLS it is https and carries the server
 *  certificate's SHA-256 fingerprint (&fp=…), which the app pins. After the first load the saved link is just the
 *  origin (plus fp); the WebView cookie keeps the session. */
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

    /** http://host:port/ without the one-time code (the pinned fingerprint stays): what we keep after the code is used. */
    fun origin(link: String): String {
        val u = URI(link)
        return "${u.scheme}://${u.host}${if (u.port >= 0) ":${u.port}" else ""}/" + (fingerprint(link)?.let { "?fp=$it" } ?: "")
    }

    /** The pinned certificate fingerprint (64 hex characters) from fp=, if the link has one. */
    fun fingerprint(link: String): String? = try {
        Regex("(^|&)fp=([0-9a-fA-F]{64})(&|$)").find(URI(link).rawQuery ?: "")?.groupValues?.get(2)?.lowercase()
    } catch (e: Exception) { null }

    /** SHA-256 of a DER certificate, as the link carries it. */
    fun sha256(der: ByteArray): String = java.security.MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /** Trusts exactly the pinned certificate (self-signed, so no certificate authority and no host name to check). */
    private fun pinned(fp: String): javax.net.ssl.SSLSocketFactory {
        val tm = object : javax.net.ssl.X509TrustManager {
            override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, auth: String) = throw java.security.cert.CertificateException("no client certs")
            override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, auth: String) {
                if (chain.isEmpty() || sha256(chain[0].encoded) != fp) throw java.security.cert.CertificateException("certificate does not match the pairing link")
            }
            override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
        }
        return javax.net.ssl.SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }.socketFactory
    }

    sealed class Check { object Ok : Check(); object Unauthorized : Check(); class Unreachable(val why: String) : Check() }

    /** Call off the main thread. */
    fun check(link: String): Check = try {
        val u = URI(link)
        val q = u.rawQuery ?: ""
        val token = Regex("(^|&)token=([^&]+)").find(q)?.groupValues?.get(2)
        val isPair = Regex("(^|&)pair=[^&]+").containsMatchIn(q)
        val base = origin(link).substringBefore('?')
        val c = java.net.URL(base + "api/state").openConnection() as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 5000
        if (c is javax.net.ssl.HttpsURLConnection) {
            val fp = fingerprint(link) ?: return Check.Unreachable("an https link needs the certificate fingerprint (fp=); pair again with a new QR")
            c.sslSocketFactory = pinned(fp); c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        }
        if (token != null) c.setRequestProperty("x-token", token)
        else if (!isPair) android.webkit.CookieManager.getInstance().getCookie(base)?.let { c.setRequestProperty("Cookie", it) }
        // A pair= code is single use, so it is never sent here (the WebView redeems it); a 401 just proves the server is up.
        when (val code = c.responseCode) {
            200 -> Check.Ok
            401 -> if (isPair) Check.Ok else Check.Unauthorized
            else -> Check.Unreachable("Server answered $code")
        }
    } catch (e: Exception) { Check.Unreachable(e.message ?: e.javaClass.simpleName) }
}
