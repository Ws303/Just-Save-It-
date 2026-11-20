import SwiftUI
import UIKit
import UniformTypeIdentifiers

@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let viewModel = ShareSheetViewModel()
    private var hostingController: UIHostingController<ShareSheetView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let rootView = ShareSheetView(vm: viewModel) { [weak self] in
            self?.finishExtension()
        }
        let host = UIHostingController(rootView: rootView)
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false

        addChild(host)
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
        self.hostingController = host

        extractIncomingShare()
    }

    private func finishExtension() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    private func extractIncomingShare() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem], !items.isEmpty else {
            return
        }

        var providers: [NSItemProvider] = []
        for item in items {
            if let attachments = item.attachments {
                providers.append(contentsOf: attachments)
            }
        }

        let urlType = UTType.url.identifier
        let textType = UTType.plainText.identifier

        Task { @MainActor in
            var foundUrl: String?
            var foundText: String?

            for provider in providers {
                if foundUrl == nil && provider.hasItemConformingToTypeIdentifier(urlType) {
                    if let loadedUrl = await loadUrl(from: provider, typeIdentifier: urlType) {
                        foundUrl = loadedUrl
                    }
                }
                if foundText == nil && provider.hasItemConformingToTypeIdentifier(textType) {
                    if let loadedText = await loadText(from: provider, typeIdentifier: textType) {
                        foundText = loadedText
                    }
                }
            }

            if let foundUrl {
                let extraTitle: String
                if let foundText, let parsedText = ShareUrlExtractor.extract(from: foundText) {
                    extraTitle = parsedText.fallbackTitle
                } else {
                    extraTitle = ShareUrlExtractor.scrubGenericTitle(foundText ?? "")
                }
                viewModel.setExtractedShare(
                    ExtractedShareInput(
                        url: ShareUrlExtractor.cleanTrailingPunctuation(foundUrl),
                        fallbackTitle: extraTitle
                    )
                )
            } else if let foundText, let extracted = ShareUrlExtractor.extract(from: foundText) {
                viewModel.setExtractedShare(extracted)
            } else {
                viewModel.errorMessage = "ไม่พบลิงก์ HTTP/HTTPS ในเนื้อหาที่แชร์"
            }
        }
    }

    private func loadUrl(from provider: NSItemProvider, typeIdentifier: String) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let url = item as? URL {
                    let s = url.absoluteString
                    if s.lowercased().hasPrefix("http://") || s.lowercased().hasPrefix("https://") {
                        continuation.resume(returning: s)
                        return
                    }
                } else if let str = item as? String,
                          let extracted = ShareUrlExtractor.extract(from: str) {
                    continuation.resume(returning: extracted.url)
                    return
                }
                continuation.resume(returning: nil)
            }
        }
    }

    private func loadText(from provider: NSItemProvider, typeIdentifier: String) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let str = item as? String {
                    continuation.resume(returning: str)
                } else if let url = item as? URL {
                    continuation.resume(returning: url.absoluteString)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}
