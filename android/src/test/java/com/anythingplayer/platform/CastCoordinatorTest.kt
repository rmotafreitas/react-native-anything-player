package com.anythingplayer.platform

import com.anythingplayer.core.AudioRoute
import com.anythingplayer.core.AudioRouteKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeTarget(val name: String, override var castableSource: Boolean?, val log: MutableList<String>) : CastTarget {
  override fun handoff(route: AudioRoute, outputId: String, resume: Boolean) {
    log += "$name.handoff(${route.kind.wire}${route.name?.let { ":$it" } ?: ""}, $outputId, resume=$resume)"
  }

  override fun castRefused() {
    log += "$name.refused"
  }
}

class CastCoordinatorTest {
  private val log = mutableListOf<String>()
  private val home = AudioRoute(AudioRouteKind.BLUETOOTH, "Buds")
  private val cast = CastCoordinator { home }
  private val a = FakeTarget("a", true, log)
  private val b = FakeTarget("b", true, log)

  @Test
  fun `a session moves the active player to the receiver keeping its intent`() {
    cast.sessionStarted("tv1", "Living Room", a)
    assertEquals(listOf("a.handoff(cast:Living Room, cast:tv1, resume=true)"), log)
    assertTrue(cast.casting)
  }

  @Test
  fun `ending the session returns the player to the device without playing`() {
    cast.sessionStarted("tv1", "TV", a)
    log.clear()
    cast.sessionEnded()
    assertEquals(listOf("a.handoff(bluetooth:Buds, local, resume=false)"), log)
    assertFalse(cast.casting)
    cast.sessionEnded()
    assertEquals(1, log.size)
  }

  @Test
  fun `the same device resuming a session changes nothing`() {
    cast.sessionStarted("tv1", "TV", a)
    log.clear()
    cast.sessionStarted("tv1", "TV (renamed)", a)
    assertTrue(log.isEmpty())
  }

  @Test
  fun `another device ends the first and takes over`() {
    cast.sessionStarted("tv1", "TV", a)
    log.clear()
    cast.sessionStarted("speaker", "Kitchen", a)
    assertEquals(
      listOf("a.handoff(bluetooth:Buds, local, resume=false)", "a.handoff(cast:Kitchen, cast:speaker, resume=true)"),
      log,
    )
  }

  @Test
  fun `a player that becomes active while casting takes the receiver from the previous one`() {
    cast.sessionStarted("tv1", "TV", a)
    log.clear()
    cast.activeChanged(b)
    assertEquals(listOf("a.handoff(bluetooth:Buds, local, resume=false)", "b.handoff(cast:TV, cast:tv1, resume=true)"), log)
    log.clear()
    cast.activeChanged(b)
    assertTrue(log.isEmpty())
  }

  @Test
  fun `an active change without a session does nothing`() {
    cast.activeChanged(a)
    assertTrue(log.isEmpty())
  }

  @Test
  fun `a session that starts with no player waits for the first active one`() {
    cast.sessionStarted("tv1", "TV", null)
    assertTrue(log.isEmpty())
    cast.activeChanged(a)
    assertEquals(listOf("a.handoff(cast:TV, cast:tv1, resume=true)"), log)
  }

  @Test
  fun `a source the receiver cannot reach stays on the device and says so`() {
    a.castableSource = false
    cast.sessionStarted("tv1", "TV", a)
    assertEquals(listOf("a.refused"), log)
    log.clear()
    cast.sessionEnded()
    assertTrue(log.isEmpty())
  }

  @Test
  fun `a player with nothing loaded still moves, so its next load goes to the receiver`() {
    a.castableSource = null
    cast.sessionStarted("tv1", "TV", a)
    assertEquals(listOf("a.handoff(cast:TV, cast:tv1, resume=true)"), log)
  }

  @Test
  fun `loading a local file on the receiver's player brings it back to play there`() {
    cast.sessionStarted("tv1", "TV", a)
    log.clear()
    cast.beforeLoad(a, reachable = true)
    assertTrue(log.isEmpty())
    cast.beforeLoad(a, reachable = false)
    assertEquals(listOf("a.refused", "a.handoff(bluetooth:Buds, local, resume=true)"), log)
    log.clear()
    cast.sessionEnded()
    assertTrue("nothing left to return", log.isEmpty())
  }

  @Test
  fun `a released player is no longer carried`() {
    cast.sessionStarted("tv1", "TV", a)
    log.clear()
    cast.released(a)
    cast.sessionEnded()
    assertTrue(log.isEmpty())
  }
}
