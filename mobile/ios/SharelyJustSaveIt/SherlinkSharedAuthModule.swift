import Foundation
import Security

@objc(SherlinkSharedAuth)
final class SherlinkSharedAuthModule: NSObject {
  private static let sharedGroupSuffix = "com.chanisa.justsaveit.shared"
  private static let sharedServiceName = "com.chanisa.justsaveit.shared.auth"
  private static let sessionAccountKey = "session_v1"
  private static let authStateAccountKey = "auth_state_v1"

  private let lockQueue = DispatchQueue(label: "com.chanisa.justsaveit.sharedAuthLock")
  private var cachedSharedGroup: String?
  private var resolvedSharedGroupOnce = false

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc func getSessionState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    lockQueue.async {
      if let sessionData = self.readSharedItem(account: Self.sessionAccountKey),
         let sessionJson = String(data: sessionData, encoding: .utf8),
         !sessionJson.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        resolve([
          "status": "session",
          "sessionJson": sessionJson
        ])
        return
      }

      if let stateData = self.readSharedItem(account: Self.authStateAccountKey),
         let stateStr = String(data: stateData, encoding: .utf8),
         stateStr == "logged_out" {
        resolve(["status": "logged_out"])
        return
      }

      resolve(["status": "empty"])
    }
  }

  @objc func saveSession(
    _ sessionJson: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    lockQueue.async {
      guard let data = sessionJson.data(using: .utf8), !data.isEmpty else {
        resolve(false)
        return
      }
      let savedSession = self.writeSharedItem(account: Self.sessionAccountKey, data: data)
      let savedState = self.writeSharedItem(account: Self.authStateAccountKey, data: Data("active".utf8))
      resolve(savedSession && savedState)
    }
  }

  @objc func markLoggedOut(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    lockQueue.async {
      self.deleteSharedItem(account: Self.sessionAccountKey)
      let savedState = self.writeSharedItem(account: Self.authStateAccountKey, data: Data("logged_out".utf8))
      resolve(savedState)
    }
  }

  // MARK: - Keychain Helpers

  private func sharedAccessGroup() -> String? {
    if resolvedSharedGroupOnce {
      return cachedSharedGroup
    }
    resolvedSharedGroupOnce = true

    if let prefix = probeAppIdentifierPrefix() {
      cachedSharedGroup = "\(prefix)\(Self.sharedGroupSuffix)"
      return cachedSharedGroup
    }

    if let teamId = Bundle.main.object(forInfoDictionaryKey: "SherlinkTeamId") as? String {
      let cleanTeam = teamId.trimmingCharacters(in: .whitespacesAndNewlines)
      if !cleanTeam.isEmpty && !cleanTeam.contains("$(") {
        cachedSharedGroup = "\(cleanTeam).\(Self.sharedGroupSuffix)"
        return cachedSharedGroup
      }
    }

    return nil
  }

  private func probeAppIdentifierPrefix() -> String? {
    let probeService = "com.chanisa.justsaveit.prefix_probe"
    let probeAccount = "probe"
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: probeService,
      kSecAttrAccount as String: probeAccount,
      kSecReturnAttributes as String: true
    ]
    var result: AnyObject?
    var status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: probeService,
        kSecAttrAccount as String: probeAccount,
        kSecValueData as String: Data("1".utf8),
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      ]
      SecItemAdd(addQuery as CFDictionary, nil)
      status = SecItemCopyMatching(query as CFDictionary, &result)
    }
    guard status == errSecSuccess,
          let dict = result as? [String: Any],
          let group = dict[kSecAttrAccessGroup as String] as? String else {
      return nil
    }
    if let bundleId = Bundle.main.bundleIdentifier, group.hasSuffix(".\(bundleId)") {
      return String(group.dropLast(bundleId.count))
    }
    if let dotIdx = group.firstIndex(of: ".") {
      let prefix = String(group[...dotIdx])
      if prefix.count == 11 {
        return prefix
      }
    }
    return nil
  }

  private func baseQuery(account: String, accessGroup: String?) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.sharedServiceName,
      kSecAttrAccount as String: account
    ]
    if let accessGroup {
      q[kSecAttrAccessGroup as String] = accessGroup
    }
    return q
  }

  private func readSharedItem(account: String) -> Data? {
    let group = sharedAccessGroup()
    var query = baseQuery(account: account, accessGroup: group)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: AnyObject?
    var status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecMissingEntitlement && group != nil {
      var fallbackQuery = baseQuery(account: account, accessGroup: nil)
      fallbackQuery[kSecReturnData as String] = true
      fallbackQuery[kSecMatchLimit as String] = kSecMatchLimitOne
      status = SecItemCopyMatching(fallbackQuery as CFDictionary, &result)
    }
    guard status == errSecSuccess, let data = result as? Data else {
      return nil
    }
    return data
  }

  private func writeSharedItem(account: String, data: Data) -> Bool {
    let group = sharedAccessGroup()
    if writeItemInternal(account: account, data: data, accessGroup: group) {
      return true
    }
    if group != nil {
      return writeItemInternal(account: account, data: data, accessGroup: nil)
    }
    return false
  }

  private func writeItemInternal(account: String, data: Data, accessGroup: String?) -> Bool {
    let query = baseQuery(account: account, accessGroup: accessGroup)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]
    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess {
      return true
    }
    if updateStatus == errSecItemNotFound {
      var addQuery = query
      addQuery[kSecValueData as String] = data
      addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
      return addStatus == errSecSuccess
    }
    if updateStatus == errSecMissingEntitlement {
      return false
    }
    return false
  }

  private func deleteSharedItem(account: String) {
    let group = sharedAccessGroup()
    let status = SecItemDelete(baseQuery(account: account, accessGroup: group) as CFDictionary)
    if status == errSecMissingEntitlement && group != nil {
      SecItemDelete(baseQuery(account: account, accessGroup: nil) as CFDictionary)
    }
  }
}
