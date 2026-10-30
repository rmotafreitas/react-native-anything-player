import Foundation
import Network

/// Reports `(state, interfaceChanged)` on the main thread. The first reading
/// is a baseline; a change of the primary interface while online (Wi-Fi ↔
/// cellular) is a handoff — the stream's socket died with the old route even
/// though the device never went offline.
final class NetworkMonitor {
  private let monitor = NWPathMonitor()
  private let queue = DispatchQueue(label: "anythingplayer.network")
  private var lastInterface: NWInterface.InterfaceType?
  private(set) var state: NetworkState = .unknown
  /// Cellular or a personal hotspot (video quality caps).
  private(set) var expensive = false
  /// Low Data Mode.
  private(set) var constrained = false
  private let onChange: (NetworkState, Bool) -> Void
  private let onCost: (Bool, Bool) -> Void
  private var started = false

  init(onChange: @escaping (NetworkState, Bool) -> Void, onCost: @escaping (Bool, Bool) -> Void = { _, _ in }) {
    self.onChange = onChange
    self.onCost = onCost
  }

  func start() {
    guard !started else { return }
    started = true
    monitor.pathUpdateHandler = { [weak self] path in
      let online = path.status == .satisfied
      let primary: NWInterface.InterfaceType? =
        [.wifi, .cellular, .wiredEthernet, .other].first { path.usesInterfaceType($0) }
      let expensive = path.isExpensive
      let constrained = path.isConstrained
      DispatchQueue.main.async {
        self?.update(online: online, primary: primary)
        self?.updateCost(expensive: expensive, constrained: constrained)
      }
    }
    monitor.start(queue: queue)
  }

  func stop() {
    guard started else { return }
    started = false
    monitor.cancel()
  }

  private func updateCost(expensive: Bool, constrained: Bool) {
    guard expensive != self.expensive || constrained != self.constrained else { return }
    self.expensive = expensive
    self.constrained = constrained
    onCost(expensive, constrained)
  }

  private func update(online: Bool, primary: NWInterface.InterfaceType?) {
    let next: NetworkState = online ? .online : .offline
    let changed = state == .online && online && primary != nil && lastInterface != nil
      && primary != lastInterface
    if online, let primary { lastInterface = primary }
    guard next != state || changed else { return }
    state = next
    onChange(next, changed)
  }
}
