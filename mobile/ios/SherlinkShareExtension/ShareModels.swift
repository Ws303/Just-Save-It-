import Foundation
import SwiftUI

enum SherlinkTheme {
    static let accent = Color(hex: 0xC72D2D)
    static let accentStrong = Color(hex: 0xBE1429)
    static let accentText = Color(hex: 0xA81C1C)
    static let soft = Color(hex: 0xFCF0F0)
    static let softBorder = Color(hex: 0xF3D2D7)

    static let bgApp = Color.white
    static let bgMuted = Color(hex: 0xF6F6F6)
    static let bgChip = Color(hex: 0xEEEEEE)
    static let bgThumb = Color(hex: 0xE3E3E3)

    static let inkStrong = Color(hex: 0x222222)
    static let inkPrimary = Color(hex: 0x233642)
    static let inkSecondary = Color(hex: 0x61666B)
    static let inkSubtle = Color(hex: 0x666666)
    static let chipDark = Color(hex: 0x1C1917)

    static let borderCard = Color(hex: 0xDDDDDD)
    static let borderInput = Color(hex: 0xBBBBBB)
}

extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

let kQuickSaveTags: [String] = [
    "#คาเฟ่",
    "#ไอเดีย",
    "#เที่ยว",
    "#อาหาร",
    "#อ่านทีหลัง",
]

struct ShareAuthSession: Codable, Equatable {
    var accessToken: String
    var refreshToken: String
    var email: String
    var userId: String
    var displayName: String?
    var expiresAt: Int?
    var apiBaseUrl: String
}

struct SharedStoredUser: Codable, Equatable {
    let id: String
    let email: String
    let display_name: String?
    let tier: String?
}

struct SharedStoredSessionPayload: Codable {
    let access_token: String
    let refresh_token: String
    let expires_at: Int?
    let api_base_url: String?
    let user: SharedStoredUser?
    let updated_at: Int?
}

struct SupabaseUserMetadata: Decodable {
    let display_name: String?
    let full_name: String?
    let name: String?
}

struct SupabaseAuthUser: Decodable {
    let id: String
    let email: String?
    let user_metadata: SupabaseUserMetadata?
}

struct SupabaseTokenResponse: Decodable {
    let access_token: String
    let refresh_token: String?
    let expires_in: Int?
    let expires_at: Int?
    let user: SupabaseAuthUser?
}

enum ShareJwtHelper {
    static func decodeClaims(from jwt: String) -> (sub: String, email: String, displayName: String?) {
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return ("", "", nil) }
        var b64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 {
            b64.append("=")
        }
        guard let data = Data(base64Encoded: b64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ("", "", nil)
        }
        let sub = (json["sub"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let email = (json["email"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let meta = json["user_metadata"] as? [String: Any]
        let displayName = (meta?["display_name"] as? String)
            ?? (meta?["full_name"] as? String)
            ?? (meta?["name"] as? String)
        return (sub, email, displayName)
    }
}

struct ShareUserProfile: Codable {
    let id: String
    let email: String
    let display_name: String?
}

struct ShareAuthTokenResponse: Codable {
    let access_token: String
    let refresh_token: String
    let token_type: String?
    let expires_in: Int?
    let user: ShareUserProfile
}

struct ShareFolder: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let emoji: String?
    let role: String?
    let items_count: Int?
}

struct ShareFoldersListResponse: Codable {
    let folders: [ShareFolder]
}

struct ShareTag: Codable, Identifiable, Equatable {
    let id: String
    let name: String
}

struct ShareTagsListResponse: Codable {
    let tags: [ShareTag]
}

struct SharePreviewResponse: Codable {
    let url: String
    let canonical_url: String?
    let title: String?
    let description: String?
    let image_url: String?
    let media_items: [String]?
    let embed_type: String?
    let embed_url: String?
    let site_name: String?
    let content_type: String?
    let platform: String?
    let preview_status: String?
}

struct ShareReminderPayload: Codable {
    let schedule_type: String
    let remind_at: String
    let timezone: String
    let title_snapshot: String?
    let is_enabled: Bool
}

struct ShareItemCreatePayload: Codable {
    let url: String
    let title: String?
    let note: String?
    let folder_id: String?
    let tags: [String]?
    let status: String
    let platform: String?
    let content_type: String?
    let image_url: String?
    let thumbnail_url: String?
    let media_items: [String]?
    let embed_url: String?
    let embed_type: String?
    let reminder: ShareReminderPayload?
}

struct ShareItemCreateResponse: Codable {
    let id: String?
    let url: String?
    let title: String?
}

enum ShareReminderPreset: String, CaseIterable, Identifiable {
    case none
    case tonight
    case tomorrowMorning
    case weekend
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .none: return "ไม่เตือน"
        case .tonight: return "คืนนี้ 20:00"
        case .tomorrowMorning: return "พรุ่งนี้ 09:00"
        case .weekend: return "เสาร์ 10:00"
        case .custom: return "กำหนดเอง"
        }
    }

    func computeTargetDate(customDate: Date, now: Date = Date()) -> Date? {
        let cal = Calendar.current
        switch self {
        case .none:
            return nil
        case .tonight:
            var comps = cal.dateComponents([.year, .month, .day], from: now)
            comps.hour = 20
            comps.minute = 0
            comps.second = 0
            if let candidate = cal.date(from: comps), candidate > now.addingTimeInterval(60) {
                return candidate
            }
            return cal.date(byAdding: .day, value: 1, to: cal.date(from: comps) ?? now)
        case .tomorrowMorning:
            let tomorrow = cal.date(byAdding: .day, value: 1, to: now) ?? now
            var comps = cal.dateComponents([.year, .month, .day], from: tomorrow)
            comps.hour = 9
            comps.minute = 0
            comps.second = 0
            return cal.date(from: comps)
        case .weekend:
            var comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)
            comps.weekday = 7 // Saturday
            comps.hour = 10
            comps.minute = 0
            comps.second = 0
            if let candidate = cal.date(from: comps), candidate > now.addingTimeInterval(60) {
                return candidate
            }
            return cal.date(byAdding: .day, value: 7, to: candidateDateOrNow(comps, cal: cal, now: now))
        case .custom:
            return customDate > now ? customDate : now.addingTimeInterval(300)
        }
    }

    private func candidateDateOrNow(_ comps: DateComponents, cal: Calendar, now: Date) -> Date {
        cal.date(from: comps) ?? now
    }
}

struct ExtractedShareInput {
    let url: String
    let fallbackTitle: String
}

enum ShareUrlExtractor {
    private static let genericTitles: Set<String> = [
        "instagram", "tiktok", "youtube", "facebook", "x", "twitter",
        "threads", "line", "safari", "chrome", "watch", "reel", "reels",
        "video", "post", "share", "shared", "link",
    ]

    static func extract(from rawText: String) -> ExtractedShareInput? {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return nil
        }
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        let matches = detector.matches(in: trimmed, options: [], range: range)

        for match in matches {
            guard let url = match.url,
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else {
                continue
            }
            let cleanedUrl = cleanTrailingPunctuation(url.absoluteString)
            guard let matchedRange = Range(match.range, in: trimmed) else {
                return ExtractedShareInput(url: cleanedUrl, fallbackTitle: "")
            }
            var remainder = trimmed
            remainder.removeSubrange(matchedRange)
            remainder = remainder
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return ExtractedShareInput(
                url: cleanedUrl,
                fallbackTitle: scrubGenericTitle(remainder)
            )
        }
        return nil
    }

    static func cleanTrailingPunctuation(_ raw: String) -> String {
        var result = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let trailingSet = CharacterSet(charactersIn: "),.;!?]}>")
        while let last = result.unicodeScalars.last, trailingSet.contains(last) {
            result.removeLast()
        }
        return result
    }

    static func scrubGenericTitle(_ raw: String) -> String {
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return "" }
        if genericTitles.contains(cleaned.lowercased()) {
            return ""
        }
        return cleaned
    }

    static func displayDomain(for urlString: String) -> String {
        guard let url = URL(string: urlString), let host = url.host else {
            return urlString
        }
        let stripped = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        let path = url.path
        if path.isEmpty || path == "/" {
            return stripped
        }
        return "\(stripped)/..."
    }
}
