package com.anythingplayer.platform

import com.anythingplayer.core.OpenRequest
import com.anythingplayer.core.PlaybackSample
import com.anythingplayer.core.SourceDescriptor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class RecordingOutput(val name: String, val log: MutableList<String>) : RemoteOutput {
  var destroyed = false
  override fun open(request: OpenRequest) { log += "$name.open(gen=${request.generation})" }
  override fun play() { log += "$name.play" }
  override fun pause() { log += "$name.pause" }
  override fun seek(seconds: Double) { log += "$name.seek($seconds)" }
  override fun releaseConnection() { log += "$name.release" }
  override fun unload() { log += "$name.unload" }
  override fun setVolume(effective: Double) { log += "$name.volume($effective)" }
  override fun setRate(rate: Double) { log += "$name.rate($rate)" }
  override fun switchOutput(outputId: String) { log += "$name.switch($outputId)" }
  override fun sample(): PlaybackSample = PlaybackSample(if (name == "cast") 42.0 else 1.0, 0.0)
  override fun progress(): ProgressReading =
    ProgressReading(if (name == "cast") 42.0 else 1.0, 0.0, null, null, false, 1.0)
  override fun destroy() { destroyed = true }
}

class RoutingDriverTest {
  private val log = mutableListOf<String>()
  private val local = RecordingOutput("local", log)
  private val cast = RecordingOutput("cast", log)
  private var built = 0
  private val driver = RoutingDriver(local) { built += 1; cast }
  private val request = OpenRequest(1, SourceDescriptor("https://x/a.mp3"), null, true)

  @Test
  fun `commands go to the local output until the audio moves`() {
    driver.open(request)
    driver.play()
    driver.setVolume(0.5)
    assertEquals(listOf("local.open(gen=1)", "local.play", "local.volume(0.5)"), log)
    assertFalse(driver.isRemote)
    assertEquals(0, built)
  }

  @Test
  fun `a switch to a cast output routes everything after it to the remote`() {
    driver.unload()
    driver.switchOutput("cast:tv1")
    driver.open(request)
    driver.seek(3.0)
    assertEquals(
      listOf("local.unload", "cast.switch(cast:tv1)", "cast.open(gen=1)", "cast.seek(3.0)"),
      log,
    )
    assertTrue(driver.isRemote)
    assertEquals(42.0, driver.sample().position, 0.0)
    assertEquals(42.0, driver.progress().position, 0.0)
  }

  @Test
  fun `the remote output is built once and switching back returns to the device`() {
    driver.switchOutput("cast:tv1")
    driver.switchOutput("local")
    driver.switchOutput("cast:tv2")
    assertEquals(1, built)
    driver.switchOutput("local")
    driver.play()
    assertEquals("local.play", log.last())
    assertEquals(1.0, driver.sample().position, 0.0)
  }

  @Test
  fun `a cast switch without a cast output stays on the device`() {
    val bare = RoutingDriver(local) { null }
    bare.switchOutput("cast:tv1")
    bare.play()
    assertEquals(listOf("local.switch(cast:tv1)", "local.play"), log)
    assertFalse(bare.isRemote)
  }

  @Test
  fun `destroying the remote returns to the device and frees it`() {
    driver.switchOutput("cast:tv1")
    driver.destroyRemote()
    assertTrue(cast.destroyed)
    assertFalse(driver.isRemote)
    assertEquals(1.0, driver.progress().position, 0.0)
  }
}
