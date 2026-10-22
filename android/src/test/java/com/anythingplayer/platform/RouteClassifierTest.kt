package com.anythingplayer.platform

import android.media.AudioDeviceInfo
import com.anythingplayer.core.AudioRoute
import com.anythingplayer.core.AudioRouteKind
import org.junit.Assert.assertEquals
import org.junit.Test

class RouteClassifierTest {
  private fun device(type: Int, name: String? = null) = OutputDevice(type, name)

  @Test
  fun `every device type maps to the public kinds`() {
    val expected =
      mapOf(
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER to AudioRouteKind.SPEAKER,
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE to AudioRouteKind.SPEAKER,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES to AudioRouteKind.HEADPHONES,
        AudioDeviceInfo.TYPE_WIRED_HEADSET to AudioRouteKind.HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET to AudioRouteKind.HEADPHONES,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP to AudioRouteKind.BLUETOOTH,
        AudioDeviceInfo.TYPE_BLE_HEADSET to AudioRouteKind.BLUETOOTH,
        AudioDeviceInfo.TYPE_HEARING_AID to AudioRouteKind.BLUETOOTH,
        AudioDeviceInfo.TYPE_HDMI to AudioRouteKind.HDMI,
        AudioDeviceInfo.TYPE_HDMI_ARC to AudioRouteKind.HDMI,
        AudioDeviceInfo.TYPE_USB_DEVICE to AudioRouteKind.USB,
        AudioDeviceInfo.TYPE_BUS to AudioRouteKind.CAR,
        AudioDeviceInfo.TYPE_DOCK to AudioRouteKind.OTHER,
        AudioDeviceInfo.TYPE_AUX_LINE to AudioRouteKind.OTHER,
      )
    expected.forEach { (type, kind) -> assertEquals("type $type", kind, RouteClassifier.kind(type)) }
  }

  @Test
  fun `the system's selection wins and names the device`() {
    val route =
      RouteClassifier.route(
        listOf(device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "Pixel 8"), device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "AirPods Pro")),
        selected = true,
      )
    assertEquals(AudioRoute(AudioRouteKind.SPEAKER, null), route)
    val bluetooth = RouteClassifier.route(listOf(device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, " AirPods Pro ")), selected = true)
    assertEquals(AudioRoute(AudioRouteKind.BLUETOOTH, "AirPods Pro"), bluetooth)
  }

  @Test
  fun `without a selection Bluetooth beats wired beats the speaker`() {
    val speaker = device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "Pixel 8")
    val wired = device(AudioDeviceInfo.TYPE_WIRED_HEADPHONES, "Headphones")
    val bluetooth = device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "Buds")
    assertEquals(AudioRouteKind.SPEAKER, RouteClassifier.route(listOf(speaker), selected = false).kind)
    assertEquals(AudioRouteKind.HEADPHONES, RouteClassifier.route(listOf(speaker, wired), selected = false).kind)
    assertEquals(AudioRouteKind.BLUETOOTH, RouteClassifier.route(listOf(speaker, wired, bluetooth), selected = false).kind)
    assertEquals(AudioRouteKind.HDMI, RouteClassifier.route(listOf(speaker, device(AudioDeviceInfo.TYPE_HDMI, "TV")), selected = false).kind)
  }

  @Test
  fun `outputs nobody listens on are ignored`() {
    val devices = listOf(device(AudioDeviceInfo.TYPE_TELEPHONY), device(AudioDeviceInfo.TYPE_REMOTE_SUBMIX), device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER))
    assertEquals(AudioRouteKind.SPEAKER, RouteClassifier.route(devices, selected = false).kind)
    assertEquals(AudioRouteKind.SPEAKER, RouteClassifier.route(emptyList(), selected = true).kind)
  }

  @Test
  fun `a car projection makes the Bluetooth output the car's`() {
    val route = RouteClassifier.route(listOf(device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "My Car")), selected = true, carMode = true)
    assertEquals(AudioRoute(AudioRouteKind.CAR, "My Car"), route)
  }
}
