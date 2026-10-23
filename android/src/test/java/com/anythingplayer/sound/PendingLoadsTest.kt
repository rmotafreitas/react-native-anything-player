package com.anythingplayer.sound

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingLoadsTest {
  private val released = SoundException("PLAYER_RELEASED", "The app is shutting down.")

  private class Settled {
    val results = ArrayList<Result<LoadedSound>>()
    val done: (Result<LoadedSound>) -> Unit = { results.add(it) }
  }

  @Test
  fun `a load settles once with its result`() {
    val loads = PendingLoads()
    val settled = Settled()
    val ticket = loads.begin(settled.done)!!
    assertTrue(loads.isPending(ticket))
    assertTrue(loads.finish(ticket, Result.success(LoadedSound("x", 1.5))))
    assertFalse(loads.isPending(ticket))
    assertFalse(loads.finish(ticket, Result.failure(released)))
    assertEquals(1, settled.results.size)
    assertEquals("x", settled.results[0].getOrNull()?.id)
  }

  @Test
  fun `releasing during a load settles the promise`() {
    val loads = PendingLoads()
    val settled = Settled()
    val ticket = loads.begin(settled.done)!!
    loads.close(released)
    // Rejected at once, before the worker is done decoding.
    assertEquals(1, settled.results.size)
    assertEquals("PLAYER_RELEASED", (settled.results[0].exceptionOrNull() as SoundException).code)
    // The worker finishes late: it is told, and nothing settles twice.
    assertFalse(loads.finish(ticket, Result.success(LoadedSound("late", null))))
    assertEquals(1, settled.results.size)
  }

  @Test
  fun `every load in flight is rejected on release`() {
    val loads = PendingLoads()
    val all = List(3) { Settled() }
    all.forEach { loads.begin(it.done) }
    loads.close(released)
    all.forEach { assertEquals("PLAYER_RELEASED", (it.results.single().exceptionOrNull() as SoundException).code) }
  }

  @Test
  fun `a load that starts after release is rejected at once`() {
    val loads = PendingLoads()
    loads.close(released)
    val settled = Settled()
    assertNull(loads.begin(settled.done))
    assertNotNull(settled.results.single().exceptionOrNull())
  }

  @Test
  fun `releasing twice settles each load once`() {
    val loads = PendingLoads()
    val settled = Settled()
    loads.begin(settled.done)
    loads.close(released)
    loads.close(released)
    assertEquals(1, settled.results.size)
  }

  @Test
  fun `a rejected hand-off to the handler can still fail the load`() {
    // The handler thread quit between decoding and registering: the worker settles the ticket itself.
    val loads = PendingLoads()
    val settled = Settled()
    val ticket = loads.begin(settled.done)!!
    assertTrue(loads.finish(ticket, Result.failure(released)))
    assertEquals("PLAYER_RELEASED", (settled.results.single().exceptionOrNull() as SoundException).code)
  }
}
