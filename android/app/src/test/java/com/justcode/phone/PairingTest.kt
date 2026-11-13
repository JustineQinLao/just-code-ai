package com.justcode.phone

import org.junit.Assert.*
import org.junit.Test

class PairingTest {
    @Test fun acceptsLinkWithToken() = assertEquals("http://192.168.1.5:7878/?token=abc", Pairing.parse(" http://192.168.1.5:7878/?token=abc "))
    @Test fun acceptsPairLink() = assertEquals("http://192.168.1.5:7878/?pair=abc", Pairing.parse("http://192.168.1.5:7878/?pair=abc"))
    @Test fun originDropsCode() = assertEquals("http://192.168.1.5:7878/", Pairing.origin("http://192.168.1.5:7878/?pair=abc"))
    @Test fun rejectsMissingToken() = assertNull(Pairing.parse("http://h:1/"))
    @Test fun rejectsOtherScheme() = assertNull(Pairing.parse("ftp://h/?token=a"))
    @Test fun rejectsGarbage() = assertNull(Pairing.parse("not a url"))
    private val fp = "ab".repeat(32)
    @Test fun acceptsHttpsLinkWithFingerprint() = assertEquals("https://h:7878/?pair=123456&fp=$fp", Pairing.parse("https://h:7878/?pair=123456&fp=$fp"))
    @Test fun readsFingerprint() = assertEquals(fp, Pairing.fingerprint("https://h:7878/?pair=123456&fp=${fp.uppercase()}"))
    @Test fun originKeepsFingerprintDropsCode() = assertEquals("https://h:7878/?fp=$fp", Pairing.origin("https://h:7878/?pair=123456&fp=$fp"))
    @Test fun noFingerprintOnPlainLink() = assertNull(Pairing.fingerprint("http://h:1/?pair=1"))
    @Test fun sha256OfBytes() = assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Pairing.sha256("abc".toByteArray()))
}
