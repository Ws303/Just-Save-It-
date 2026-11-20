import Foundation
import Security

enum ShareKeychainStore {
    // Shared Keychain access group (works on Free Apple ID / Personal Team via $(AppIdentifierPrefix)*)
    private static let sharedGroupSuffix = "com.chanisa.justsaveit.shared"
    private static let sharedServiceName = "com.chanisa.justsaveit.shared.auth"
    private static let sessionAccountKey = "session_v1"
    private static let authStateAccountKey = "auth_state_v1"

    // Legacy sandboxed service used prior to shared Keychain migration
    private static let legacyServiceName = "com.chanisa.justsaveit.ShareExtension.auth"

    private static let cachedFoldersKey = "sherlink.share_ext.cached_folders_v1"
    private static let cachedFoldersOwnerKey = "sherlink.share_ext.cached_folders_owner_v1"
    private static let cachedTagsKey = "sherlink.share_ext.cached_tags_v1"
    private static let cachedTagsOwnerKey = "sherlink.share_ext.cached_tags_owner_v1"
    private static let customApiBaseKey = "sherlink.share_ext.api_base_v1"

    private static var cachedSharedGroup: String?
    private static var resolvedSharedGroupOnce = false

    static var defaultApiBaseUrl: String {
        if let saved = UserDefaults.standard.string(forKey: customApiBaseKey),
           !saved.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return normalizeApiBaseUrl(saved)
        }
        if let plistVal = Bundle.main.object(forInfoDictionaryKey: "SherlinkApiBaseUrl") as? String,
           !plistVal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return normalizeApiBaseUrl(plistVal)
        }
        return "https://just-save-it-api.onrender.com"
    }

    static var supabaseUrl: String {
        if let plistVal = Bundle.main.object(forInfoDictionaryKey: "SherlinkSupabaseUrl") as? String,
           !plistVal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return normalizeApiBaseUrl(plistVal)
        }
        return "https://pnqjamwhgzqzvpiytcln.supabase.co"
    }

    static var supabaseAnonKey: String {
        if let plistVal = Bundle.main.object(forInfoDictionaryKey: "SherlinkSupabaseAnonKey") as? String,
           !plistVal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return plistVal.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBucWphbXdoZ3pxenZwaXl0Y2xuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NjAzMjIsImV4cCI6MjExMDIzNjMyMn0.4RfZtHD9-23dSQw2P6tWRz45mty5BumKWAKKBifbebw"
    }

    static let oauthCallbackScheme = "sharely"
    static let oauthRedirectUri = "sharely://auth-callback"

    static func saveCustomApiBaseUrl(_ url: String) {
        let clean = normalizeApiBaseUrl(url)
        if clean.isEmpty {
            UserDefaults.standard.removeObject(forKey: customApiBaseKey)
        } else {
            UserDefaults.standard.set(clean, forKey: customApiBaseKey)
        }
    }

    static func normalizeApiBaseUrl(_ raw: String) -> String {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        return trimmed
    }

    static func loadSession() -> ShareAuthSession? {
        if let sharedData = readSharedItem(account: sessionAccountKey),
           let decoded = decodeSessionData(sharedData) {
            return decoded
        }

        if let stateData = readSharedItem(account: authStateAccountKey),
           let stateStr = String(data: stateData, encoding: .utf8),
           stateStr == "logged_out" {
            deleteLegacySession()
            return nil
        }

        // Migrate legacy sandboxed Share Extension session if present
        if let legacyData = readLegacySessionData(),
           let legacySession = decodeSessionData(legacyData) {
            saveSession(legacySession)
            deleteLegacySession()
            return legacySession
        }

        return nil
    }

    static func saveSession(_ session: ShareAuthSession) {
        let claims = ShareJwtHelper.decodeClaims(from: session.accessToken)
        let resolvedId = session.userId.isEmpty ? claims.sub : session.userId
        let resolvedEmail = session.email.isEmpty ? claims.email : session.email
        let resolvedName = session.displayName ?? claims.displayName
        let resolvedApiBase = normalizeApiBaseUrl(
            session.apiBaseUrl.isEmpty ? defaultApiBaseUrl : session.apiBaseUrl
        )

        let payload = SharedStoredSessionPayload(
            access_token: session.accessToken,
            refresh_token: session.refreshToken,
            expires_at: session.expiresAt,
            api_base_url: resolvedApiBase,
            user: (!resolvedId.isEmpty || !resolvedEmail.isEmpty)
                ? SharedStoredUser(
                    id: resolvedId,
                    email: resolvedEmail,
                    display_name: resolvedName,
                    tier: nil
                )
                : nil,
            updated_at: Int(Date().timeIntervalSince1970)
        )
        guard let data = try? JSONEncoder().encode(payload) else { return }

        _ = writeSharedItem(account: sessionAccountKey, data: data)
        _ = writeSharedItem(account: authStateAccountKey, data: Data("active".utf8))
        deleteLegacySession()
    }

    static func clearSession() {
        deleteSharedItem(account: sessionAccountKey)
        _ = writeSharedItem(account: authStateAccountKey, data: Data("logged_out".utf8))
        deleteLegacySession()
        UserDefaults.standard.removeObject(forKey: cachedFoldersKey)
        UserDefaults.standard.removeObject(forKey: cachedFoldersOwnerKey)
        UserDefaults.standard.removeObject(forKey: cachedTagsKey)
        UserDefaults.standard.removeObject(forKey: cachedTagsOwnerKey)
    }

    static func loadCachedFolders(forUserId userId: String? = nil) -> [ShareFolder] {
        if let uid = userId, !uid.isEmpty {
            let owner = UserDefaults.standard.string(forKey: cachedFoldersOwnerKey) ?? ""
            if owner != uid {
                return []
            }
        }
        guard let data = UserDefaults.standard.data(forKey: cachedFoldersKey) else { return [] }
        return (try? JSONDecoder().decode([ShareFolder].self, from: data)) ?? []
    }

    static func saveCachedFolders(_ folders: [ShareFolder], userId: String? = nil) {
        guard let data = try? JSONEncoder().encode(folders) else { return }
        UserDefaults.standard.set(data, forKey: cachedFoldersKey)
        if let uid = userId, !uid.isEmpty {
            UserDefaults.standard.set(uid, forKey: cachedFoldersOwnerKey)
        } else if let currentUid = loadSession()?.userId, !currentUid.isEmpty {
            UserDefaults.standard.set(currentUid, forKey: cachedFoldersOwnerKey)
        }
    }

    static func loadCachedTags(forUserId userId: String? = nil) -> [ShareTag] {
        if let uid = userId, !uid.isEmpty {
            let owner = UserDefaults.standard.string(forKey: cachedTagsOwnerKey) ?? ""
            if owner != uid {
                return []
            }
        }
        guard let data = UserDefaults.standard.data(forKey: cachedTagsKey) else { return [] }
        return (try? JSONDecoder().decode([ShareTag].self, from: data)) ?? []
    }

    static func saveCachedTags(_ tags: [ShareTag], userId: String? = nil) {
        guard let data = try? JSONEncoder().encode(tags) else { return }
        UserDefaults.standard.set(data, forKey: cachedTagsKey)
        if let uid = userId, !uid.isEmpty {
            UserDefaults.standard.set(uid, forKey: cachedTagsOwnerKey)
        } else if let currentUid = loadSession()?.userId, !currentUid.isEmpty {
            UserDefaults.standard.set(currentUid, forKey: cachedTagsOwnerKey)
        }
    }

    // MARK: - Decoding

    private static func decodeSessionData(_ data: Data) -> ShareAuthSession? {
        if let unified = try? JSONDecoder().decode(SharedStoredSessionPayload.self, from: data),
           !unified.access_token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let claims = ShareJwtHelper.decodeClaims(from: unified.access_token)
            let userId = (unified.user?.id.isEmpty == false ? unified.user?.id : nil) ?? claims.sub
            let email = (unified.user?.email.isEmpty == false ? unified.user?.email : nil) ?? claims.email
            let displayName = unified.user?.display_name ?? claims.displayName
            let apiBase = normalizeApiBaseUrl(
                (unified.api_base_url?.isEmpty == false ? unified.api_base_url : nil) ?? defaultApiBaseUrl
            )
            return ShareAuthSession(
                accessToken: unified.access_token,
                refreshToken: unified.refresh_token,
                email: email,
                userId: userId,
                displayName: displayName,
                expiresAt: unified.expires_at,
                apiBaseUrl: apiBase
            )
        }

        if let legacy = try? JSONDecoder().decode(ShareAuthSession.self, from: data),
           !legacy.accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return legacy
        }

        return nil
    }

    // MARK: - Shared Keychain Group Helpers

    private static func sharedAccessGroup() -> String? {
        if resolvedSharedGroupOnce {
            return cachedSharedGroup
        }
        resolvedSharedGroupOnce = true

        if let prefix = probeAppIdentifierPrefix() {
            cachedSharedGroup = "\(prefix)\(sharedGroupSuffix)"
            return cachedSharedGroup
        }

        if let teamId = Bundle.main.object(forInfoDictionaryKey: "SherlinkTeamId") as? String {
            let cleanTeam = teamId.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleanTeam.isEmpty && !cleanTeam.contains("$(") {
                cachedSharedGroup = "\(cleanTeam).\(sharedGroupSuffix)"
                return cachedSharedGroup
            }
        }

        return nil
    }

    private static func probeAppIdentifierPrefix() -> String? {
        let probeService = "com.chanisa.justsaveit.prefix_probe"
        let probeAccount = "probe"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: probeService,
            kSecAttrAccount as String: probeAccount,
            kSecReturnAttributes as String: true,
        ]
        var result: AnyObject?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            let addQuery: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: probeService,
                kSecAttrAccount as String: probeAccount,
                kSecValueData as String: Data("1".utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
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

    private static func baseQuery(account: String, service: String = sharedServiceName, accessGroup: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            q[kSecAttrAccessGroup as String] = accessGroup
        }
        return q
    }

    private static func readSharedItem(account: String) -> Data? {
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

    private static func writeSharedItem(account: String, data: Data) -> Bool {
        let group = sharedAccessGroup()
        if writeItemInternal(account: account, data: data, accessGroup: group) {
            return true
        }
        if group != nil {
            return writeItemInternal(account: account, data: data, accessGroup: nil)
        }
        return false
    }

    private static func writeItemInternal(account: String, data: Data, accessGroup: String?) -> Bool {
        let query = baseQuery(account: account, accessGroup: accessGroup)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
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
        return false
    }

    private static func deleteSharedItem(account: String) {
        let group = sharedAccessGroup()
        let status = SecItemDelete(baseQuery(account: account, accessGroup: group) as CFDictionary)
        if status == errSecMissingEntitlement && group != nil {
            SecItemDelete(baseQuery(account: account, accessGroup: nil) as CFDictionary)
        }
    }

    private static func readLegacySessionData() -> Data? {
        var query = baseQuery(account: sessionAccountKey, service: legacyServiceName, accessGroup: nil)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return data
    }

    private static func deleteLegacySession() {
        SecItemDelete(baseQuery(account: sessionAccountKey, service: legacyServiceName, accessGroup: nil) as CFDictionary)
    }
}
