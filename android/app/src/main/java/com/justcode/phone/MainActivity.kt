package com.justcode.phone

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebView
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var root: FrameLayout
    private var scanning = false
    private var boardShown = false
    private var scanPreview: PreviewView? = null
    private var scanCb: ((String) -> Unit)? = null
    private var firstResume = true
    private var web: WebView? = null

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val bar = androidx.appcompat.widget.Toolbar(androidx.appcompat.view.ContextThemeWrapper(this, androidx.appcompat.R.style.ThemeOverlay_AppCompat_Dark_ActionBar)).apply { title = "JustCode"; setTitleTextColor(0xFFFFFFFF.toInt()); setBackgroundColor(0xFF263238.toInt()) }
        root = FrameLayout(this)
        setContentView(LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(bar, LinearLayout.LayoutParams(-1, -2)); addView(root, LinearLayout.LayoutParams(-1, 0, 1f)) })
        setSupportActionBar(bar)
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) w.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
            }
        })
        connect()
    }

    override fun onCreateOptionsMenu(m: Menu): Boolean { m.add(0, 1, 0, "Forget / re-pair").setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS); return true }
    override fun onOptionsItemSelected(i: MenuItem): Boolean {
        if (i.itemId == 1) { Pairing.forget(this); showPairing(null); return true }
        return super.onOptionsItemSelected(i)
    }

    /** Reconnect with the saved link, or show the pairing screen. */
    private fun connect() {
        val link = Pairing.load(this) ?: return showPairing(null)
        showMessage("Connecting…", null)
        Executors.newSingleThreadExecutor().execute {
            val r = Pairing.check(link)
            runOnUiThread {
                when (r) {
                    is Pairing.Check.Ok -> showBoard(link)
                    is Pairing.Check.Unauthorized -> { Pairing.forget(this); showPairing("The pairing token is no longer valid (it was regenerated). Pair again.") }
                    is Pairing.Check.Unreachable -> showMessage("Can't reach the server: ${r.why}", "Retry") { connect() }
                }
            }
        }
    }

    private fun showMessage(text: String, button: String?, onClick: (() -> Unit)? = null) {
        web = null; scanning = false; boardShown = false; scanPreview = null
        root.removeAllViews()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 96, 48, 48) }
        col.addView(TextView(this).apply { this.text = text; textSize = 16f })
        if (button != null) col.addView(Button(this).apply { this.text = button; setOnClickListener { onClick?.invoke() } })
        root.addView(col)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showBoard(link: String) {
        scanPreview = null; boardShown = true
        root.removeAllViews()
        root.addView(WebView(this).apply {
            web = this
            settings.javaScriptEnabled = true; settings.domStorageEnabled = true
            webViewClient = object : android.webkit.WebViewClient() {
                override fun onReceivedHttpError(v: WebView, r: android.webkit.WebResourceRequest, e: android.webkit.WebResourceResponse) {
                    if (e.statusCode == 401 && (r.isForMainFrame || r.url.path?.startsWith("/api/") == true)) runOnUiThread { Pairing.forget(this@MainActivity); showPairing("The pairing token is no longer valid (it was regenerated). Pair again.") }
                }
            }
            loadUrl(link)
        })
    }

    private fun showPairing(error: String?) {
        web = null; boardShown = false; scanPreview = null; scanning = false
        root.removeAllViews()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 48, 32, 32) }
        val msg = TextView(this).apply { text = error ?: "Scan the QR from “JustCode: Show Phone Pairing”, or paste the link."; textSize = 15f }
        val input = EditText(this).apply { hint = "http://host:7878/?pair=…"; setSingleLine() }
        val go = Button(this).apply { text = "Pair" }
        val scan = Button(this).apply { text = "Scan QR" }
        val preview = PreviewView(this).apply { layoutParams = LinearLayout.LayoutParams(-1, 0, 1f); visibility = View.GONE }
        col.addView(msg); col.addView(input); col.addView(go); col.addView(scan); col.addView(preview)
        root.addView(col)
        fun submit(raw: String) {
            val link = Pairing.parse(raw) ?: run { msg.text = "That isn't a valid link (needs http://…/?pair=…)."; return }
            msg.text = "Checking…"
            Executors.newSingleThreadExecutor().execute {
                val r = Pairing.check(link)
                runOnUiThread {
                    when (r) {
                        is Pairing.Check.Ok -> { Pairing.save(this, Pairing.origin(link)); showBoard(link) }
                        is Pairing.Check.Unauthorized -> msg.text = "The server rejected the link (401). It may have expired or been used; generate a new one and try again."
                        is Pairing.Check.Unreachable -> msg.text = "Can't reach the server: ${r.why}. Check Wi-Fi and try again."
                    }
                }
            }
        }
        go.setOnClickListener { submit(input.text.toString()) }
        scan.setOnClickListener {
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startScan(preview) { submit(it) }
            else { pendingStart = { startScan(preview) { s -> submit(s) } }; requestPermissions(arrayOf(Manifest.permission.CAMERA), 7) }
        }
    }

    private var pendingStart: (() -> Unit)? = null
    override fun onRequestPermissionsResult(code: Int, p: Array<out String>, r: IntArray) {
        super.onRequestPermissionsResult(code, p, r)
        if (code != 7) return
        if (r.firstOrNull() == PackageManager.PERMISSION_GRANTED) pendingStart?.invoke()
        else Toast.makeText(this, "Camera denied — paste the link instead.", Toast.LENGTH_LONG).show()
    }

    private fun stopScan() { scanning = false; try { ProcessCameraProvider.getInstance(this).get().unbindAll() } catch (_: Exception) {} }
    override fun onPause() { stopScan(); super.onPause() }
    override fun onResume() {
        super.onResume()
        if (firstResume) { firstResume = false; return }
        // A token regenerated while the board is open can't be seen by the page's own fetches, so check again.
        if (boardShown) connect()
        else { val p = scanPreview; val cb = scanCb; if (p != null && cb != null && p.visibility == View.VISIBLE) startScan(p, cb) }
    }
    override fun onDestroy() { stopScan(); super.onDestroy() }

    private fun startScan(preview: PreviewView, onCode: (String) -> Unit) {
        preview.visibility = View.VISIBLE; scanning = true; scanPreview = preview; scanCb = onCode
        val fut = ProcessCameraProvider.getInstance(this)
        fut.addListener({
            val scanner = BarcodeScanning.getClient()
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(Executors.newSingleThreadExecutor()) { proxy ->
                val media = proxy.image
                if (media == null || !scanning) { proxy.close(); return@setAnalyzer }
                scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                    .addOnSuccessListener { codes ->
                        val v = codes.firstOrNull { it.format == Barcode.FORMAT_QR_CODE }?.rawValue
                        if (v != null && scanning) { scanning = false; runOnUiThread { fut.get().unbindAll(); onCode(v) } }
                    }.addOnCompleteListener { proxy.close() }
            }
            val prev = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
            fut.get().unbindAll()
            fut.get().bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, prev, analysis)
        }, ContextCompat.getMainExecutor(this))
    }
}
