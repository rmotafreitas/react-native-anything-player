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
  private let onChange: (NetworkState, Bool) -> Void
  private var started = false

  init(onChange: @escaping (NetworkState, Bool) -> Void) {
    self.onChange = onChange
  }

  func start() {
    guard !started else { return }
    started = true
    monitor.pathUpdateHandler = { [weak self] path in
      let online = path.status == .satisfied
      let primary: NWInterface.InterfaceType? =
        [.wifi, .cellular, .wiredEthernet, .other].first { path.usesInterfaceType($0) }
      DispatchQueue.main.async { self?.update(online: online, primary: primary) }
    }
    monitor.start(queue: queue)
  }

  func stop() {
    guard started else { return }
    started = false
    monitor.cancel()
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
