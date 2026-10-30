package com.anythingplayer.platform

import android.util.Base64
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.DrmSessionManager
import androidx.media3.exoplayer.drm.ExoMediaDrm
import androidx.media3.exoplayer.drm.FrameworkMediaDrm
import androidx.media3.exoplayer.drm.HttpMediaDrmCallback
import androidx.media3.exoplayer.drm.LocalMediaDrmCallback
import androidx.media3.exoplayer.drm.MediaDrmCallback
import com.anythingplayer.core.DrmDescriptor
import com.anythingplayer.core.LicenseServer
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

// A source's `drm` on Android: ExoPlayer decrypts through the platform's
// MediaDrm with one key system, the first of Widevine, PlayReady and Clear
// Key that the source gives and the device has (FairPlay is Apple's). The
// license comes from the key system's server, from the Clear Key keys in the
// source (answered here), or from the app's `getLicense` — a `licenseRequest`
// event, answered by the `license` video command.

/** The key systems Android can use, in the order they are tried. */
internal enum class KeySystem(val wire: String, val uuid: UUID) {
  WIDEVINE("widevine", C.WIDEVINE_UUID),
  PLAYREADY("playready", C.PLAYREADY_UUID),
  CLEARKEY("clearkey", C.CLEARKEY_UUID),
}

/** The source's key system's server (Clear Key's may have only keys). */
internal fun DrmDescriptor.server(system: KeySystem): LicenseServer? =
  when (system) {
    KeySystem.WIDEVINE -> widevine
    KeySystem.PLAYREADY -> playready
    KeySystem.CLEARKEY -> clearkey
  }

/** The first key system the source gives and the device has; `null`: none. */
internal fun chooseKeySystem(drm: DrmDescriptor, supported: (UUID) -> Boolean): KeySystem? =
  KeySystem.entries.firstOrNull { drm.server(it) != null && supported(it.uuid) }

/** Why a source with `drm` cannot play here. */
internal fun noKeySystemMessage(drm: DrmDescriptor): String =
  if (drm.fairplay && drm.widevine == null && drm.playready == null && drm.clearkey == null) {
    "The source's drm gives only FairPlay, which is Apple's: Android plays Widevine, PlayReady or Clear Key."
  } else {
    "This device has none of the source's key systems (${KeySystem.entries.filter { drm.server(it) != null }.joinToString { it.wire }})."
  }

/** A Clear Key license (JSON Web Keys) holding every key of the source. */
internal fun clearKeyLicense(keys: Map<String, String>): ByteArray {
  val entries =
    keys.entries.joinToString(",") { (kid, key) ->
      """{"kty":"oct","kid":"${base64Url(hexBytes(kid))}","k":"${base64Url(hexBytes(key))}"}"""
    }
  return """{"keys":[$entries],"type":"temporary"}""".toByteArray(Charsets.UTF_8)
}

private fun hexBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

private const val BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** Unpadded base64url (as Clear Key licenses write ids and keys). */
internal fun base64Url(bytes: ByteArray): String {
  val out = StringBuilder()
  var i = 0
  while (i < bytes.size) {
    val n = minOf(3, bytes.size - i)
    var chunk = 0
    for (j in 0 until 3) chunk = (chunk shl 8) or (if (j < n) bytes[i + j].toInt() and 0xff else 0)
    for (j in 0..n) out.append(BASE64_URL[(chunk shr (18 - 6 * j)) and 0x3f])
    i += 3
  }
  return out.toString()
}

/** The app's `getLicense` failed, or did not answer. */
internal class LicenseHookException(message: String) : IOException(message)

/**
 * License requests waiting on the app's `getLicense`: each gets an id that the
 * `license` video command answers (from any player: the ids are unique).
 */
internal object LicenseRequests {
  private val next = AtomicInteger(1)
  private val pending = ConcurrentHashMap<Int, CompletableFuture<ByteArray>>()

  fun open(): Pair<Int, CompletableFuture<ByteArray>> {
    val id = next.getAndIncrement()
    val future = CompletableFuture<ByteArray>()
    pending[id] = future
    return id to future
  }

  /** The app's answer: the license in base64, or why `getLicense` failed. */
  fun answer(requestId: Int, license: String?, error: String?) {
    val future = pending.remove(requestId) ?: return
    val bytes = license?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() }
    if (bytes != null) {
      future.complete(bytes)
    } else {
      future.completeExceptionally(LicenseHookException("The app's getLicense failed: ${error ?: "no license"}."))
    }
  }

  fun cancel(requestId: Int, reason: String) {
    pending.remove(requestId)?.completeExceptionally(LicenseHookException(reason))
  }
}

/** What the app's `getLicense` is asked (the `licenseRequest` event). */
internal data class LicenseAsk(
  val requestId: Int,
  val keySystem: String,
  val challenge: ByteArray,
  val licenseUrl: String?,
  val headers: Map<String, String>,
)

/**
 * Key requests answered by the app's `getLicense`. Runs on ExoPlayer's DRM
 * request thread, which waits for the answer (30 s at most); device
 * provisioning (Widevine's certificate) still goes to Google's server.
 */
@OptIn(UnstableApi::class)
internal class HookDrmCallback(
  private val system: KeySystem,
  private val server: LicenseServer?,
  private val provisioning: MediaDrmCallback,
  private val ask: (LicenseAsk) -> Unit,
) : MediaDrmCallback {
  private val waiting = ConcurrentHashMap.newKeySet<Int>()

  override fun executeProvisionRequest(uuid: UUID, request: ExoMediaDrm.ProvisionRequest): MediaDrmCallback.Response =
    provisioning.executeProvisionRequest(uuid, request)

  override fun executeKeyRequest(uuid: UUID, request: ExoMediaDrm.KeyRequest): MediaDrmCallback.Response {
    val (id, future) = LicenseRequests.open()
    waiting += id
    try {
      val url = server?.licenseUrl ?: request.licenseServerUrl.ifEmpty { null }
      ask(LicenseAsk(id, system.wire, request.data, url, server?.headers.orEmpty()))
      return MediaDrmCallback.Response(future.get(LICENSE_TIMEOUT_S, TimeUnit.SECONDS))
    } catch (e: ExecutionException) {
      throw e.cause as? IOException ?: LicenseHookException(e.cause?.message ?: "The app's getLicense failed.")
    } catch (e: TimeoutException) {
      throw LicenseHookException("The app's getLicense did not answer within $LICENSE_TIMEOUT_S s.")
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      throw LicenseHookException("The license request was interrupted.")
    } finally {
      waiting -= id
      LicenseRequests.cancel(id, "The source was closed.")
    }
  }

  /** The item is gone: nothing waits on the app anymore. */
  fun close() {
    for (id in waiting.toList()) LicenseRequests.cancel(id, "The source was closed.")
  }

  companion object {
    const val LICENSE_TIMEOUT_S = 30L
  }
}

/** A source's DRM session manager, and what to close with its item. */
@OptIn(UnstableApi::class)
internal class SourceDrm(val manager: DrmSessionManager, private val hook: HookDrmCallback?) {
  fun close() {
    hook?.close()
  }

  companion object {
    /**
     * The session manager for a source's `drm` on [system]; license requests
     * go over [http] (with the key system's headers only).
     */
    fun create(drm: DrmDescriptor, system: KeySystem, http: DataSource.Factory, ask: (LicenseAsk) -> Unit): SourceDrm {
      val server = drm.server(system)
      val url = server?.licenseUrl
      val httpCallback =
        HttpMediaDrmCallback(url, /* forceDefaultLicenseUrl= */ url != null, http).apply {
          server?.headers?.forEach { (name, value) -> setKeyRequestProperty(name, value) }
        }
      val keys = drm.clearKeys
      var hook: HookDrmCallback? = null
      val callback: MediaDrmCallback =
        when {
          system == KeySystem.CLEARKEY && keys != null -> LocalMediaDrmCallback(clearKeyLicense(keys))
          drm.hook -> HookDrmCallback(system, server, httpCallback, ask).also { hook = it }
          else -> httpCallback
        }
      val manager =
        DefaultDrmSessionManager.Builder()
          .setUuidAndExoMediaDrmProvider(system.uuid, FrameworkMediaDrm.DEFAULT_PROVIDER)
          .setLoadErrorHandlingPolicy(AnythingPlayerLoadErrorPolicy())
          .build(callback)
      return SourceDrm(manager, hook)
    }

    fun isSupported(uuid: UUID): Boolean = FrameworkMediaDrm.isCryptoSchemeSupported(uuid)
  }
}
