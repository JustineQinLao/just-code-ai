package com.justcode.phone

import org.junit.Assert.*
import org.junit.Test

class PairingTest {
    @Test fun acceptsLinkWithToken() = assertEquals("http://192.168.1.5:7878/?token=abc", Pairing.parse(" http://192.168.1.5:7878/?token=abc "))
    @Test fun rejectsMissingToken() = assertNull(Pairing.parse("http://h:1/"))
    @Test fun rejectsOtherScheme() = assertNull(Pairing.parse("ftp://h/?token=a"))
    @Test fun rejectsGarbage() = assertNull(Pairing.parse("not a url"))
}
