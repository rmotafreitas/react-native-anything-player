package com.anythingplayer.platform

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.StreamKey
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheEvictor
import androidx.media3.datasource.cache.CacheKeyFactory
import androidx.media3.datasource.cache.CacheSpan
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.offline.DefaultDownloaderFactory
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.Downloader
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.SourceDescriptor
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.util.TreeSet
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import org.json.JSONArray
import org.json.JSONObject

/**
 * The media cache (`Cache` in JS): one cache written as items play and by
 * `preload` (least recently played go first), and one kept by downloads,
 * never evicted. ExoPlayer reads both (downloads first) through
 * [dataSourceFactory]; nothing here needs JavaScript, so a cached item plays
 * while JS is frozen and with no network. Media3's `CacheDataSource` never
 * writes a response of unknown length (a live stream).
 */
@OptIn(UnstableApi::class)
internal object MediaCache {
  private const val PREFS = "rnap.cache"
  private const val MB = 1024L * 1024L
  private const val DEFAULT_MAX = 256 * MB
  private const val DEFAULT_PRELOAD = MB
  private const val PROGRESS_MS = 1_000L

  private lateinit var context: Context
  private val database by lazy { StandaloneDatabaseProvider(context) }
  private val evictor = ResizableLruEvictor(DEFAULT_MAX)
  private val play: SimpleCache by lazy { SimpleCache(File(context.cacheDir, "rnap-media"), evictor, database) }
  private val kept: SimpleCache by lazy { SimpleCache(File(context.filesDir, "rnap-downloads"), NoOpCacheEvictor(), database) }
  private val work = Executors.newFixedThreadPool(2)
  private val downloads = ConcurrentHashMap<String, Download>()
  private val running = ConcurrentHashMap<String, Future<*>>()
  @Volatile private var enabled = false
  @Volatile private var initialized = false

  private class Download(
    val id: String,
    val uri: String,
    val key: String,
    val headers: Map<String, String>,
    val type: String,
    var state: String,
    var bytes: Long = 0,
    var totalBytes: Long? = null,
    var error: PlayerError? = null,
  )

  /** Main thread, at runtime start: settings and unfinished downloads come back. */
  fun attach(app: Context) {
    if (initialized) return
    initialized = true
    context = app.applicationContext
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    enabled = prefs.getBoolean("enabled", false)
    evictor.maxBytes = prefs.getLong("maxSizeBytes", DEFAULT_MAX)
    work.execute {
      readIndex()
      downloads.values.filter { it.state == "queued" || it.state == "downloading" }.forEach { start(it) }
    }
  }

  // ── What ExoPlayer reads ──

  /** Whether a source may go in the cache as it plays: finite, over HTTP(S), its own `cache` or the setting. */
  private fun writes(source: SourceDescriptor): Boolean =
    source.liveHint != true && source.drm == null && source.isNetwork && (source.cache ?: enabled)

  fun keyOf(source: SourceDescriptor): String = source.cacheKey ?: source.uri.substringBefore('#')

  /**
   * The source's bytes: from a download, else the cache, else the network
   * (written to the cache when [writes]). A live source reads the network.
   */
  fun dataSourceFactory(upstream: DataSource.Factory, source: SourceDescriptor): DataSource.Factory {
    if (!initialized || source.liveHint == true || !source.isNetwork) return upstream
    val keys = keyFactory(source)
    val played =
      if (writes(source)) {
        CacheDataSource.Factory()
          .setCache(play)
          .setUpstreamDataSourceFactory(upstream)
          .setCacheKeyFactory(keys)
          .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR or CacheDataSource.FLAG_IGNORE_CACHE_FOR_UNSET_LENGTH_REQUESTS)
      } else {
        // Read what is there (a preload), write nothing.
        CacheDataSource.Factory()
          .setCache(play)
          .setUpstreamDataSourceFactory(upstream)
          .setCacheWriteDataSinkFactory(null)
          .setCacheKeyFactory(keys)
          .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
      }
    return CacheDataSource.Factory()
      .setCache(kept)
      .setUpstreamDataSourceFactory(played)
      .setCacheWriteDataSinkFactory(null)
      .setCacheKeyFactory(keys)
      .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
  }

  /** The source's own URL is keyed by its `cacheKey`; its segments by their URLs. */
  private fun keyFactory(source: SourceDescriptor): CacheKeyFactory {
    val own = source.uri.substringBefore('#')
    val key = keyOf(source)
    return CacheKeyFactory { spec ->
      val uri = spec.uri.toString().substringBefore('#')
      spec.key ?: if (uri == own) key else uri
    }
  }

  // ── Commands (any thread; the work runs on [work]) ──

  fun configure(enabledArg: Boolean?, maxSizeBytes: Long?) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    enabledArg?.let {
      enabled = it
      prefs.putBoolean("enabled", it)
    }
    maxSizeBytes?.let {
      prefs.putLong("maxSizeBytes", it)
      work.execute { evictor.resize(play, it) }
    }
    prefs.apply()
  }

  /** Fetches the start of a source (or all of it) into the cache. Blocking: call on a worker. */
  fun preload(source: SourceDescriptor, bytes: Long?, all: Boolean): WritableMap {
    if (source.liveHint == true || !source.isNetwork) return info(source)
    val upstream = http(source.headers)
    val factory =
      CacheDataSource.Factory().setCache(play).setUpstreamDataSourceFactory(upstream).setCacheKeyFactory(keyFactory(source))
    val type = typeOf(source.uri)
    val budget = if (all) C.LENGTH_UNSET.toLong() else (bytes ?: DEFAULT_PRELOAD)
    if (type == null) {
      val spec = DataSpec.Builder().setUri(Uri.parse(source.uri)).setLength(budget).setKey(keyOf(source)).build()
      CacheWriter(factory.createDataSource(), spec, null, null).cache()
    } else {
      // HLS / DASH: its first segments, one quality.
      val downloader = downloader(factory, source.uri, keyOf(source), type, streamKeys(source, type))
      try {
        downloader.download { _, downloaded, _ ->
          if (!all && downloaded >= budget) downloader.cancel()
        }
      } catch (_: InterruptedException) {
        // Stopped at the budget.
      } catch (_: java.util.concurrent.CancellationException) {
        // Stopped at the budget.
      }
    }
    return info(source)
  }

  fun download(source: SourceDescriptor, id: String?): WritableMap {
    if (source.liveHint == true || !source.isNetwork) {
      throw PlayerError(ErrorCode.UNSUPPORTED_FORMAT, "Downloads are finite sources over HTTP(S), not live streams or local files.", false)
    }
    val download =
      Download(id ?: source.uri, source.uri, keyOf(source), source.headers, typeOf(source.uri) ?: "file", "queued")
    downloads[download.id]?.let { running.remove(it.id)?.cancel(true) }
    downloads[download.id] = download
    writeIndex()
    start(download)
    return downloadMap(download)
  }

  fun downloadsArray(): List<WritableMap> = downloads.values.map(::downloadMap)

  fun removeDownload(id: String) {
    val download = downloads.remove(id) ?: return
    running.remove(id)?.cancel(true)
    work.execute {
      runCatching { downloaderFor(download).remove() }
      writeIndex()
    }
  }

  fun info(source: SourceDescriptor): WritableMap {
    val key = keyOf(source)
    val download = downloads.values.firstOrNull { it.key == key }
    val adaptive = typeOf(source.uri) != null
    val keptBytes = kept.getCachedBytes(key, 0, C.LENGTH_UNSET.toLong())
    val playedBytes = play.getCachedBytes(key, 0, C.LENGTH_UNSET.toLong())
    val length = ContentMetadata.getContentLength(kept.getContentMetadata(key)).takeIf { it > 0 }
      ?: ContentMetadata.getContentLength(play.getContentMetadata(key)).takeIf { it > 0 }
    val bytes = if (adaptive) download?.bytes ?: 0 else maxOf(keptBytes, playedBytes)
    val complete =
      download?.state == "completed" || (!adaptive && length != null && maxOf(keptBytes, playedBytes) >= length)
    return Arguments.createMap().apply {
      putString("state", if (complete) "complete" else if (bytes > 0) "partial" else "none")
      putDouble("bytes", bytes.toDouble())
      (length ?: download?.totalBytes)?.let { putDouble("totalBytes", it.toDouble()) } ?: putNull("totalBytes")
      putBoolean("downloaded", download?.state == "completed")
    }
  }

  fun usage(): WritableMap =
    Arguments.createMap().apply {
      putDouble("cacheBytes", play.cacheSpace.toDouble())
      putDouble("downloadBytes", kept.cacheSpace.toDouble())
      putDouble("maxSizeBytes", evictor.maxBytes.toDouble())
    }

  fun clear() {
    for (key in play.keys.toList()) play.removeResource(key)
  }

  // ── Downloads ──

  private fun start(download: Download) {
    running[download.id] =
      work.submit {
        try {
          download.state = "downloading"
          emit(download)
          var told = 0L
          val downloader = downloaderFor(download)
          downloader.download { contentLength, bytesDownloaded, _ ->
            download.bytes = bytesDownloaded
            if (contentLength > 0) download.totalBytes = contentLength
            val now = android.os.SystemClock.elapsedRealtime()
            if (now - told >= PROGRESS_MS) {
              told = now
              emit(download)
            }
          }
          download.state = "completed"
          // The same bytes are not kept twice.
          if (download.type == "file") play.removeResource(download.key)
        } catch (_: InterruptedException) {
          return@submit
        } catch (error: Exception) {
          download.state = "failed"
          download.error = mapDownloadError(error)
        } finally {
          running.remove(download.id)
        }
        writeIndex()
        emit(download)
      }
  }

  private fun downloaderFor(d: Download): Downloader {
    val factory = CacheDataSource.Factory().setCache(kept).setUpstreamDataSourceFactory(http(d.headers))
    val source = SourceDescriptor(d.uri, d.headers, liveHint = false, cacheKey = d.key)
    factory.setCacheKeyFactory(keyFactory(source))
    val type = if (d.type == "file") null else d.type
    return downloader(factory, d.uri, d.key, type, if (type == null) emptyList() else streamKeys(source, type))
  }

  private fun downloader(
    factory: CacheDataSource.Factory,
    uri: String,
    key: String,
    type: String?,
    keys: List<StreamKey>,
  ): Downloader {
    val request =
      DownloadRequest.Builder(key, Uri.parse(uri))
        .setMimeType(type)
        .setStreamKeys(keys)
        .setCustomCacheKey(if (type == null) key else null)
        .build()
    return try {
      DefaultDownloaderFactory(factory, Runnable::run).createDownloader(request)
    } catch (_: IllegalStateException) {
      val module = if (type == MimeTypes.APPLICATION_MPD) "DASH (`rnapDash=true`)" else "HLS"
      throw PlayerError(ErrorCode.UNSUPPORTED_FORMAT, "$module is not built into this app.", false)
    }
  }

  private fun emit(download: Download) {
    AnythingPlayerRuntime.emit(downloadMap(download).apply { putString("type", "download") })
  }

  private fun downloadMap(d: Download): WritableMap =
    Arguments.createMap().apply {
      putString("id", d.id)
      putString("uri", d.uri)
      putString("state", d.state)
      putDouble("bytes", d.bytes.toDouble())
      d.totalBytes?.let { putDouble("totalBytes", it.toDouble()) } ?: putNull("totalBytes")
      d.error?.let { putMap("error", errorToMap(it)) } ?: putNull("error")
    }

  private fun mapDownloadError(error: Exception): PlayerError {
    val status = (error as? androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)?.responseCode
    if (status != null) {
      val code = if (status == 404 || status == 410) ErrorCode.SOURCE_NOT_FOUND else ErrorCode.HTTP_ERROR
      return PlayerError(code, "The server answered $status.", status >= 500, httpStatus = status)
    }
    if (error is PlayerError) return error
    return PlayerError(ErrorCode.NETWORK_ERROR, error.message ?: error.javaClass.simpleName, true)
  }

  private fun indexFile() = File(context.filesDir, "rnap-downloads.json")

  @Synchronized
  private fun writeIndex() {
    val list = JSONArray()
    for (d in downloads.values) {
      list.put(
        JSONObject()
          .put("id", d.id)
          .put("uri", d.uri)
          .put("key", d.key)
          .put("type", d.type)
          .put("state", d.state)
          .put("bytes", d.bytes)
          .put("totalBytes", d.totalBytes ?: JSONObject.NULL)
          .put("headers", JSONObject(d.headers)),
      )
    }
    indexFile().writeText(list.toString())
  }

  private fun readIndex() {
    val file = indexFile()
    if (!file.exists()) return
    val list = runCatching { JSONArray(file.readText()) }.getOrNull() ?: return
    for (i in 0 until list.length()) {
      val o = list.getJSONObject(i)
      val headers = o.optJSONObject("headers")?.let { h -> h.keys().asSequence().associateWith { h.getString(it) } } ?: emptyMap()
      val d =
        Download(o.getString("id"), o.getString("uri"), o.getString("key"), headers, o.getString("type"), o.getString("state"))
      d.bytes = o.optLong("bytes")
      d.totalBytes = if (o.isNull("totalBytes")) null else o.getLong("totalBytes")
      downloads[d.id] = d
    }
  }

  private fun http(headers: Map<String, String>): DataSource.Factory {
    val userAgent = headers.entries.firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }?.value
    return OkHttpDataSource.Factory(HttpConnections.client)
      .setUserAgent(userAgent ?: "RNAP")
      .setDefaultRequestProperties(headers.filterKeys { !it.equals("User-Agent", ignoreCase = true) })
  }

  // ── One quality of an adaptive source ──

  /** HLS or DASH, by the URL; `null`: a file. */
  private fun typeOf(uri: String): String? {
    val path = uri.substringBefore('#').substringBefore('?').lowercase()
    return when {
      path.endsWith(".m3u8") -> MimeTypes.APPLICATION_M3U8
      path.endsWith(".mpd") -> MimeTypes.APPLICATION_MPD
      else -> null
    }
  }

  /**
   * The best video variant (or the only ones) and the first audio track:
   * a download keeps one quality, not every one the source offers.
   */
  private fun streamKeys(source: SourceDescriptor, type: String): List<StreamKey> {
    val upstream = http(source.headers).createDataSource()
    val text =
      try {
        upstream.open(DataSpec(Uri.parse(source.uri)))
        upstream.readText()
      } finally {
        upstream.close()
      }
    return if (type == MimeTypes.APPLICATION_M3U8) hlsKeys(text) else dashKeys(text)
  }

  private fun DataSource.readText(): String {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    while (true) {
      val n = read(buffer, 0, buffer.size)
      if (n == C.RESULT_END_OF_INPUT) break
      out.write(buffer, 0, n)
    }
    return out.toString("UTF-8")
  }

  /** A multivariant playlist's highest-bandwidth variant and its first audio rendition (none: a media playlist). */
  internal fun hlsKeys(text: String): List<StreamKey> {
    val variants = mutableListOf<Long>()
    var audio = 0
    for (line in text.lineSequence().map { it.trim() }) {
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        variants.add(Regex("[:,]BANDWIDTH=(\\d+)").find(line)?.groupValues?.get(1)?.toLong() ?: 0)
      } else if (line.startsWith("#EXT-X-MEDIA:") && line.contains("TYPE=AUDIO") && line.contains("URI=")) {
        audio += 1
      }
    }
    if (variants.isEmpty()) return emptyList()
    val best = variants.indices.maxByOrNull { variants[it] } ?: 0
    // Media3's group indexes: variants 0, audio renditions 1 (HlsMultivariantPlaylist).
    return listOf(StreamKey(0, best)) + if (audio > 0) listOf(StreamKey(1, 0)) else emptyList()
  }

  /** Per period: the highest-bandwidth representation of the first video set, and the first of the first audio set. */
  internal fun dashKeys(text: String): List<StreamKey> {
    val factory = javax.xml.parsers.DocumentBuilderFactory.newInstance()
    factory.isNamespaceAware = false
    // A manifest names no external entities: none are read.
    runCatching { factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
    val document = factory.newDocumentBuilder().parse(text.byteInputStream())
    val keys = mutableListOf<StreamKey>()
    val periods = document.getElementsByTagName("Period")
    for (p in 0 until periods.length) {
      val sets = (periods.item(p) as org.w3c.dom.Element).getElementsByTagName("AdaptationSet")
      val taken = mutableSetOf<String>()
      for (a in 0 until sets.length) {
        val set = sets.item(a) as org.w3c.dom.Element
        val reps = set.getElementsByTagName("Representation")
        if (reps.length == 0) continue
        val first = reps.item(0) as org.w3c.dom.Element
        val kind = kindOf(set.getAttribute("contentType").ifEmpty { set.getAttribute("mimeType") }.ifEmpty { first.getAttribute("mimeType") })
        if (kind == null || !taken.add(kind)) continue
        val bandwidths = (0 until reps.length).map { (reps.item(it) as org.w3c.dom.Element).getAttribute("bandwidth").toLongOrNull() ?: 0 }
        val index = if (kind == "video") bandwidths.indices.maxByOrNull { bandwidths[it] } ?: 0 else 0
        keys.add(StreamKey(p, a, index))
      }
    }
    return keys
  }

  private fun kindOf(type: String?): String? =
    when {
      type == null -> null
      type.startsWith("video") -> "video"
      type.startsWith("audio") -> "audio"
      else -> null
    }
}

/**
 * Least recently played first, like Media3's `LeastRecentlyUsedCacheEvictor`,
 * with a size the app can change (`Cache.configure`).
 */
@OptIn(UnstableApi::class)
internal class ResizableLruEvictor(@Volatile var maxBytes: Long) : CacheEvictor {
  private val spans = TreeSet<CacheSpan> { a, b ->
    val byTime = a.lastTouchTimestamp.compareTo(b.lastTouchTimestamp)
    if (byTime != 0) byTime else a.compareTo(b)
  }
  private var size = 0L

  override fun requiresCacheSpanTouches() = true

  override fun onCacheInitialized() = Unit

  override fun onStartFile(cache: Cache, key: String, position: Long, length: Long) {
    if (length != C.LENGTH_UNSET.toLong()) evict(cache, length)
  }

  override fun onSpanAdded(cache: Cache, span: CacheSpan) {
    spans.add(span)
    size += span.length
    evict(cache, 0)
  }

  override fun onSpanRemoved(cache: Cache, span: CacheSpan) {
    spans.remove(span)
    size -= span.length
  }

  override fun onSpanTouched(cache: Cache, oldSpan: CacheSpan, newSpan: CacheSpan) {
    onSpanRemoved(cache, oldSpan)
    onSpanAdded(cache, newSpan)
  }

  fun resize(cache: Cache, bytes: Long) {
    maxBytes = bytes
    synchronized(cache) { evict(cache, 0) }
  }

  private fun evict(cache: Cache, required: Long) {
    while (size + required > maxBytes && spans.isNotEmpty()) {
      cache.removeSpan(spans.first())
    }
  }
}
