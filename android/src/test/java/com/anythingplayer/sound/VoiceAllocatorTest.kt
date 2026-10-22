package com.anythingplayer.sound

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceAllocatorTest {
  @Test
  fun `voices up to the capacity start without stealing`() {
    val allocator = VoiceAllocator(2)
    assertNull(allocator.begin(1, now = 0, endsAt = null))
    assertNull(allocator.begin(2, now = 1, endsAt = null))
    assertEquals(2, allocator.size)
  }

  @Test
  fun `a full sound stops the voice that started first`() {
    val allocator = VoiceAllocator(2)
    allocator.begin(1, 0, null)
    allocator.begin(2, 1, null)
    val stolen = allocator.begin(3, 2, null)
    assertEquals(1L, stolen?.voiceId)
    assertEquals(2, allocator.size)
    assertNull(allocator.slot(1))
    assertNotNull(allocator.slot(3))
  }

  @Test
  fun `a voice past its end is not stolen from`() {
    val allocator = VoiceAllocator(2)
    allocator.begin(1, now = 0, endsAt = 100)
    allocator.begin(2, now = 50, endsAt = null)
    // At 150 voice 1 has ended: there is room, nothing is stopped.
    assertNull(allocator.begin(3, now = 150, endsAt = null))
    assertEquals(2, allocator.size)
    assertNotNull(allocator.slot(2))
    assertNotNull(allocator.slot(3))
  }

  @Test
  fun `a looping voice stays busy and is the oldest to go`() {
    val allocator = VoiceAllocator(1)
    allocator.begin(1, 0, null)
    assertEquals(1L, allocator.begin(2, 10_000, 10_100)?.voiceId)
  }

  @Test
  fun `remove frees the slot and clear returns every voice`() {
    val allocator = VoiceAllocator(3)
    allocator.begin(1, 0, null)
    allocator.begin(2, 0, null)
    allocator.slot(2)?.streamId = 42
    assertEquals(42, allocator.remove(2)?.streamId)
    assertNull(allocator.remove(2))
    assertEquals(listOf(1L), allocator.clear().map { it.voiceId })
    assertEquals(0, allocator.size)
  }
}
