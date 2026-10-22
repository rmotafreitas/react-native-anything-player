package com.anythingplayer.sound

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceAllocatorTest {
  @Test
  fun `voices up to a sound's limit start without stealing`() {
    val allocator = VoiceAllocator(32)
    assertNull(allocator.begin("a", 2, 1, now = 0, endsAt = null).stolen)
    assertNull(allocator.begin("a", 2, 2, now = 1, endsAt = null).stolen)
    assertEquals(2, allocator.size)
  }

  @Test
  fun `a full sound stops its own voice that started first`() {
    val allocator = VoiceAllocator(32)
    allocator.begin("a", 2, 1, 0, null)
    allocator.begin("b", 2, 2, 1, null)
    allocator.begin("a", 2, 3, 2, null)
    val stolen = allocator.begin("a", 2, 4, 3, null).stolen
    // Voice 2 is older than 3 but belongs to another sound.
    assertEquals(1L, stolen?.voiceId)
    assertEquals(3, allocator.size)
    assertNull(allocator.slot(1))
    assertNotNull(allocator.slot(2))
    assertNotNull(allocator.slot(4))
  }

  @Test
  fun `a full pool stops the oldest voice of any sound`() {
    val allocator = VoiceAllocator(3)
    allocator.begin("a", 4, 1, 0, null)
    allocator.begin("b", 4, 2, 1, null)
    allocator.begin("c", 4, 3, 2, null)
    val stolen = allocator.begin("d", 4, 4, 3, null).stolen
    assertEquals(1L, stolen?.voiceId)
    assertEquals("a", stolen?.soundId)
    assertEquals(3, allocator.size)
  }

  @Test
  fun `the pool never holds more than its cap`() {
    val allocator = VoiceAllocator(5)
    for (voice in 1L..40L) allocator.begin("s${voice % 7}", 4, voice, voice, null)
    assertEquals(5, allocator.size)
  }

  @Test
  fun `a voice past its end is returned as expired and not stolen from`() {
    val allocator = VoiceAllocator(32)
    allocator.begin("a", 2, 1, now = 0, endsAt = 100)
    allocator.begin("a", 2, 2, now = 50, endsAt = null)
    // At 150 voice 1 has ended: there is room, nothing is stopped.
    val begin = allocator.begin("a", 2, 3, now = 150, endsAt = null)
    assertNull(begin.stolen)
    assertEquals(listOf(1L), begin.expired.map { it.voiceId })
    assertEquals(2, allocator.size)
    assertNull(allocator.slot(1))
    assertNotNull(allocator.slot(2))
    assertNotNull(allocator.slot(3))
  }

  @Test
  fun `ended voices of every sound are pruned, so none pile up`() {
    val allocator = VoiceAllocator(32)
    for (voice in 1L..100L) {
      val begin = allocator.begin("s${voice % 10}", 4, voice, now = voice * 10, endsAt = voice * 10 + 5)
      assertTrue(begin.expired.size <= 1)
      assertNull(begin.stolen)
    }
    assertEquals(1, allocator.size)
  }

  @Test
  fun `a looping voice stays busy and is the oldest to go`() {
    val allocator = VoiceAllocator(32)
    allocator.begin("a", 1, 1, 0, null)
    assertEquals(1L, allocator.begin("a", 1, 2, 10_000, 10_100).stolen?.voiceId)
  }

  @Test
  fun `remove frees the slot and clear returns every voice`() {
    val allocator = VoiceAllocator(32)
    allocator.begin("a", 3, 1, 0, null)
    allocator.begin("a", 3, 2, 0, null)
    allocator.slot(2)?.streamId = 42
    assertEquals(42, allocator.remove(2)?.streamId)
    assertNull(allocator.remove(2))
    assertEquals(listOf(1L), allocator.clear().map { it.voiceId })
    assertEquals(0, allocator.size)
  }

  @Test
  fun `clearing one sound leaves the others`() {
    val allocator = VoiceAllocator(32)
    allocator.begin("a", 3, 1, 0, null)
    allocator.begin("b", 3, 2, 0, null)
    allocator.begin("a", 3, 3, 0, null)
    assertEquals(listOf(1L, 3L), allocator.clear("a").map { it.voiceId })
    assertEquals(listOf(2L), allocator.clear().map { it.voiceId })
  }
}
