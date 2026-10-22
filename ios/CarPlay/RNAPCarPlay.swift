#if RNAP_CAR && canImport(CarPlay)
import CarPlay
import UIKit

/// The CarPlay audio app: a tab bar of lists from the catalog's browse tree
/// (`BrowseTree`: the top-level groups, "Recently played", "Favorites"; a list
/// longer than CarPlay allows continues in a "More…" row), the
/// system Now Playing screen, and playback through the same path as
/// `playFromSearch` (`VoiceSearch.handleBrowse`, reported to JS as `searchPlay`
/// with `origin: 'browse'`). Built in with `RNAP_CAR=1` (the Expo plugin's `car`
/// option). The app also needs the `com.apple.developer.carplay-audio`
/// entitlement and a CarPlay scene named `RNAPCarPlaySceneDelegate` in its scene
/// manifest; see docs/cars-and-watches.md. Main thread only.
@objc(RNAPCarPlaySceneDelegate)
public final class RNAPCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    RNAPCarPlay.shared.connect(interfaceController)
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    RNAPCarPlay.shared.disconnect()
  }
}

final class RNAPCarPlay {
  static let shared = RNAPCarPlay()

  private var interfaceController: CPInterfaceController?
  /// The tab lists, by folder id, so a catalog change can update them in place.
  private var tabTemplates: [String: CPListTemplate] = [:]
  private var tabIds: [String] = []
  private var observer: NSObjectProtocol?
  private let artwork = CarArtwork()

  private init() {}

  // MARK: - Connection

  func connect(_ controller: CPInterfaceController) {
    // The app may have been launched in the background for CarPlay: no JS yet.
    AnythingPlayerRuntime.shared.startIfNeeded()
    interfaceController = controller
    showRoot()
    observer = NotificationCenter.default.addObserver(
      forName: RNAPVoice.catalogDidChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.catalogChanged() }
  }

  func disconnect() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    interfaceController = nil
    tabTemplates = [:]
    tabIds = []
  }

  // MARK: - Templates

  private var tree: BrowseTree {
    AnythingPlayerRuntime.shared.voice.catalog.browseTree(foldersOnly: true)
  }

  private func showRoot() {
    guard let interfaceController else { return }
    let tree = self.tree
    let folders = (tree.children(BrowseTree.rootId) ?? []).filter(\.isFolder)
    tabTemplates = [:]
    tabIds = folders.map(\.id)
    let templates = folders.map { folder -> CPListTemplate in
      let template = listTemplate(folder, in: tree)
      template.tabTitle = folder.title
      template.tabImage = UIImage(systemName: Self.tabSymbol(folder.id)) ?? UIImage()
      tabTemplates[folder.id] = template
      return template
    }
    let root: CPTemplate
    if templates.isEmpty {
      let empty = CPListTemplate(title: "", sections: [])
      empty.emptyViewTitleVariants = ["Nothing to play"]
      empty.emptyViewSubtitleVariants = ["Open the app to choose something."]
      root = empty
    } else if templates.count == 1 {
      root = templates[0]
    } else {
      root = CPTabBarTemplate(templates: templates)
    }
    interfaceController.setRootTemplate(root, animated: false, completion: nil)
  }

  /// Updates the tabs in place when only their items changed; rebuilds the root when the tabs themselves did.
  private func catalogChanged() {
    guard interfaceController != nil else { return }
    let tree = self.tree
    let folders = (tree.children(BrowseTree.rootId) ?? []).filter(\.isFolder)
    guard folders.map(\.id) == tabIds else { return showRoot() }
    for folder in folders {
      tabTemplates[folder.id]?.updateSections(sections(for: folder.id, in: tree))
    }
  }

  private func listTemplate(_ folder: BrowseNode, in tree: BrowseTree, from offset: Int = 0) -> CPListTemplate {
    let template = CPListTemplate(title: folder.title, sections: sections(for: folder.id, in: tree, from: offset))
    template.emptyViewTitleVariants = ["Nothing here yet"]
    return template
  }

  /// How many rows one list can hold. CarPlay decides at run time (and drops the rows past it), so it is read, never assumed.
  private static var itemLimit: Int { max(CPListTemplate.maximumItemCount, 2) }

  /// One page of a folder, starting at child `offset`: as many rows as the list holds. A folder with more
  /// ends in a "More…" row that opens the next page as a list of its own (and so on). A single section:
  /// the row limit is a total, and sections only add a limit of their own (`maximumSectionCount`).
  private func sections(for folderId: String, in tree: BrowseTree, from offset: Int = 0) -> [CPListSection] {
    let nodes = tree.children(folderId) ?? []
    let start = min(max(offset, 0), nodes.count)
    let room = Self.itemLimit
    var rows: [CPListItem]
    if nodes.count - start <= room {
      rows = nodes[start...].map { listItem($0) }
    } else {
      let next = start + room - 1
      rows = nodes[start..<next].map { listItem($0) }
      let folder = tree.node(folderId) ?? BrowseNode(id: folderId, title: tree.moreTitle, isFolder: true)
      rows.append(moreItem(folder, title: "\(tree.moreTitle)…", next: next))
    }
    return [CPListSection(items: rows)]
  }

  private func moreItem(_ folder: BrowseNode, title: String, next: Int) -> CPListItem {
    let item = CPListItem(
      text: title, detailText: nil, image: nil, accessoryImage: nil, accessoryType: .disclosureIndicator)
    item.handler = { [weak self] _, completion in
      if let self, let interfaceController = self.interfaceController {
        interfaceController.pushTemplate(
          self.listTemplate(folder, in: self.tree, from: next), animated: true, completion: nil)
      }
      completion()
    }
    return item
  }

  private func listItem(_ node: BrowseNode) -> CPListItem {
    let item = CPListItem(
      text: node.title, detailText: node.subtitle, image: nil, accessoryImage: nil,
      accessoryType: node.isFolder ? .disclosureIndicator : .none)
    artwork.load(node.artwork) { [weak item] image in item?.setImage(image) }
    item.handler = { [weak self] _, completion in
      if node.isFolder {
        self?.open(node)
        completion()
      } else {
        self?.play(node, completion: completion)
      }
    }
    return item
  }

  private func open(_ folder: BrowseNode) {
    guard let interfaceController else { return }
    interfaceController.pushTemplate(listTemplate(folder, in: tree), animated: true, completion: nil)
  }

  private func play(_ node: BrowseNode, completion: @escaping () -> Void) {
    AnythingPlayerSystem.voice().handleBrowse(itemId: node.id) { [weak self] outcome in
      completion()
      switch outcome {
      case .playing:
        // "Recently played" has a new first item.
        self?.catalogChanged()
        self?.showNowPlaying()
      case .failed, .noMatch: self?.showCannotPlay(node.title)
      }
    }
  }

  private func showNowPlaying() {
    guard let interfaceController, !(interfaceController.topTemplate is CPNowPlayingTemplate) else { return }
    interfaceController.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
  }

  private func showCannotPlay(_ title: String) {
    guard let interfaceController else { return }
    let ok = CPAlertAction(title: "OK", style: .default) { [weak interfaceController] _ in
      interfaceController?.dismissTemplate(animated: true, completion: nil)
    }
    let alert = CPAlertTemplate(titleVariants: ["Can't play \(title)", "Can't play"], actions: [ok])
    interfaceController.presentTemplate(alert, animated: true, completion: nil)
  }

  private static func tabSymbol(_ folderId: String) -> String {
    switch folderId {
    case BrowseTree.recentId: return "clock"
    case BrowseTree.favoritesId: return "heart"
    case BrowseTree.moreId: return "ellipsis"
    default: return "music.note.list"
    }
  }
}

/// Loads list artwork: a remote URL or a file in the app, cached in memory.
private final class CarArtwork {
  private let cache = NSCache<NSString, UIImage>()

  func load(_ location: String?, completion: @escaping (UIImage) -> Void) {
    guard let location, !location.isEmpty else { return }
    if let cached = cache.object(forKey: location as NSString) { return completion(cached) }
    let url = URL(string: location).flatMap { $0.scheme == nil ? nil : $0 } ?? URL(fileURLWithPath: location)
    if url.isFileURL {
      if let image = UIImage(contentsOfFile: url.path) { finish(image, location, completion) }
      return
    }
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let data, let image = UIImage(data: data) else { return }
      DispatchQueue.main.async { self?.finish(image, location, completion) }
    }.resume()
  }

  private func finish(_ image: UIImage, _ location: String, _ completion: (UIImage) -> Void) {
    cache.setObject(image, forKey: location as NSString)
    completion(image)
  }
}
#endif
