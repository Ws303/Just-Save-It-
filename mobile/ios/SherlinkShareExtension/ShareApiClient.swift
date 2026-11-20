import Foundation

enum ShareApiError: LocalizedError {
    case notAuthenticated
    case invalidUrl
    case serverError(statusCode: Int, message: String)
    case decodingFailed

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่"
        case .invalidUrl:
            return "URL ของเซิร์ฟเวอร์หรือลิงก์ไม่ถูกต้อง"
        case .serverError(_, let message):
            return message
        case .decodingFailed:
            return "ไม่สามารถอ่านข้อมูลจากเซิร์ฟเวอร์ได้"
        }
    }
}

private struct ApiDetailErrorBody: Decodable {
    let detail: String?
    let message: String?
}

private struct RefreshRequestBody: Encodable {
    let refresh_token: String
}

private struct LoginRequestBody: Encodable {
    let email: String
    let password: String
}

private struct PreviewRequestBody: Encodable {
    let url: String
    let force_refresh: Bool
}

private struct FolderCreateRequestBody: Encodable {
    let name: String
}

actor ShareApiClient {
    static let shared = ShareApiClient()

    private let urlSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 25
        cfg.timeoutIntervalForResource = 35
        return URLSession(configuration: cfg)
    }()

    private var refreshTask: Task<ShareAuthSession, Error>?

    func login(email: String, password: String, apiBaseUrl: String) async throws -> ShareAuthSession {
        let base = ShareKeychainStore.normalizeApiBaseUrl(apiBaseUrl)
        guard let endpoint = URL(string: "\(base)/api/auth/login") else {
            throw ShareApiError.invalidUrl
        }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(
            LoginRequestBody(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
        )

        let (data, response) = try await urlSession.data(for: req)
        try validateHttpResponse(response, data: data)

        guard let authResp = try? JSONDecoder().decode(ShareAuthTokenResponse.self, from: data) else {
            throw ShareApiError.decodingFailed
        }
        let session = ShareAuthSession(
            accessToken: authResp.access_token,
            refreshToken: authResp.refresh_token,
            email: authResp.user.email,
            userId: authResp.user.id,
            apiBaseUrl: base
        )
        ShareKeychainStore.saveCustomApiBaseUrl(base)
        ShareKeychainStore.saveSession(session)
        return session
    }

    func fetchPreview(url targetUrl: String) async throws -> SharePreviewResponse {
        let body = try JSONEncoder().encode(PreviewRequestBody(url: targetUrl, force_refresh: false))
        return try await authorizedRequest(path: "/api/preview", method: "POST", body: body)
    }

    func fetchFolders() async throws -> [ShareFolder] {
        let resp: ShareFoldersListResponse = try await authorizedRequest(path: "/api/folders", method: "GET")
        ShareKeychainStore.saveCachedFolders(resp.folders)
        return resp.folders
    }

    func createFolder(name: String) async throws -> ShareFolder {
        let body = try JSONEncoder().encode(FolderCreateRequestBody(name: name))
        let folder: ShareFolder = try await authorizedRequest(path: "/api/folders", method: "POST", body: body)
        var current = ShareKeychainStore.loadCachedFolders()
        if !current.contains(where: { $0.id == folder.id }) {
            current.insert(folder, at: 0)
            ShareKeychainStore.saveCachedFolders(current)
        }
        return folder
    }

    func fetchTags() async throws -> [ShareTag] {
        let resp: ShareTagsListResponse = try await authorizedRequest(path: "/api/tags", method: "GET")
        ShareKeychainStore.saveCachedTags(resp.tags)
        return resp.tags
    }

    func saveItem(_ payload: ShareItemCreatePayload) async throws -> ShareItemCreateResponse {
        let body = try JSONEncoder().encode(payload)
        return try await authorizedRequest(path: "/api/items", method: "POST", body: body)
    }

    // MARK: - Authorized Request + Single-Flight Refresh

    private func authorizedRequest<T: Decodable>(
        path: String,
        method: String,
        body: Data? = nil,
        allowRefresh: Bool = true
    ) async throws -> T {
        guard let session = ShareKeychainStore.loadSession() else {
            throw ShareApiError.notAuthenticated
        }
        let base = ShareKeychainStore.normalizeApiBaseUrl(session.apiBaseUrl)
        guard let url = URL(string: "\(base)\(path)") else {
            throw ShareApiError.invalidUrl
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }

        let (data, response) = try await urlSession.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode == 401, allowRefresh {
            _ = try await refreshSessionCoalesced()
            return try await authorizedRequest(path: path, method: method, body: body, allowRefresh: false)
        }

        try validateHttpResponse(response, data: data)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ShareApiError.decodingFailed
        }
    }

    private func refreshSessionCoalesced() async throws -> ShareAuthSession {
        if let activeTask = refreshTask {
            return try await activeTask.value
        }
        let task = Task<ShareAuthSession, Error> {
            defer { refreshTask = nil }
            guard let existing = ShareKeychainStore.loadSession(), !existing.refreshToken.isEmpty else {
                throw ShareApiError.notAuthenticated
            }
            let base = ShareKeychainStore.normalizeApiBaseUrl(existing.apiBaseUrl)
            guard let url = URL(string: "\(base)/api/auth/refresh") else {
                throw ShareApiError.invalidUrl
            }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(RefreshRequestBody(refresh_token: existing.refreshToken))

            let (data, response) = try await urlSession.data(for: req)
            if let http = response as? HTTPURLResponse, http.statusCode == 401 || http.statusCode == 403 {
                ShareKeychainStore.clearSession()
                throw ShareApiError.notAuthenticated
            }
            try validateHttpResponse(response, data: data)

            guard let authResp = try? JSONDecoder().decode(ShareAuthTokenResponse.self, from: data) else {
                throw ShareApiError.decodingFailed
            }
            let updated = ShareAuthSession(
                accessToken: authResp.access_token,
                refreshToken: authResp.refresh_token,
                email: authResp.user.email,
                userId: authResp.user.id,
                apiBaseUrl: base
            )
            ShareKeychainStore.saveSession(updated)
            return updated
        }
        refreshTask = task
        return try await task.value
    }

    private func validateHttpResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw ShareApiError.serverError(statusCode: -1, message: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้")
        }
        guard (200...299).contains(http.statusCode) else {
            let parsed = try? JSONDecoder().decode(ApiDetailErrorBody.self, from: data)
            let rawMsg = parsed?.detail ?? parsed?.message ?? String(data: data, encoding: .utf8) ?? ""
            let clean = rawMsg.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = http.statusCode == 401
                ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือเซสชันหมดอายุ"
                : "เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ (\(http.statusCode))"
            throw ShareApiError.serverError(statusCode: http.statusCode, message: clean.isEmpty ? fallback : clean)
        }
    }
}
