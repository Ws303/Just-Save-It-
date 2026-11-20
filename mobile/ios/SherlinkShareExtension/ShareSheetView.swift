import Combine
import SwiftUI
import UIKit

@MainActor
final class ShareSheetViewModel: ObservableObject {
    @Published var session: ShareAuthSession?
    @Published var sharedUrl: String = ""
    @Published var titleText: String = ""
    @Published var noteText: String = ""
    @Published var customTagText: String = ""

    @Published var folders: [ShareFolder] = []
    @Published var selectedFolderId: String? = nil

    @Published var userTags: [ShareTag] = []
    @Published var selectedTags: [String] = []

    @Published var previewData: SharePreviewResponse? = nil
    @Published var isLoadingPreview: Bool = false

    @Published var reminderMenuOpen: Bool = false
    @Published var reminderPreset: ShareReminderPreset = .none
    @Published var customReminderDate: Date = Date().addingTimeInterval(3600)

    @Published var inlineFolderOpen: Bool = false
    @Published var inlineFolderName: String = ""
    @Published var isCreatingFolder: Bool = false

    @Published var isSaving: Bool = false
    @Published var didSaveSuccess: Bool = false
    @Published var errorMessage: String? = nil

    // Login state (one-time inside Share Sheet)
    @Published var loginEmail: String = ""
    @Published var loginPassword: String = ""
    @Published var apiBaseInput: String = ShareKeychainStore.defaultApiBaseUrl
    @Published var showServerConfig: Bool = false
    @Published var isLoggingIn: Bool = false

    private var didUserEditTitle: Bool = false

    init() {
        self.session = ShareKeychainStore.loadSession()
        self.folders = ShareKeychainStore.loadCachedFolders()
        self.userTags = ShareKeychainStore.loadCachedTags()
        if let s = self.session {
            self.apiBaseInput = s.apiBaseUrl
        }
    }

    var mergedTagOptions: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for raw in kQuickSaveTags + userTags.map(\.name) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let normalized = trimmed.hasPrefix("#") ? trimmed : "#\(trimmed)"
            let key = normalized.lowercased()
            if !seen.contains(key) {
                seen.insert(key)
                result.append(normalized)
            }
        }
        return result
    }

    var displayDomain: String {
        if sharedUrl.isEmpty { return "กำลังอ่านลิงก์..." }
        return ShareUrlExtractor.displayDomain(for: sharedUrl)
    }

    var resolvedThumbUrl: URL? {
        if let raw = previewData?.image_url, !raw.isEmpty, let url = URL(string: raw) {
            return url
        }
        if let first = previewData?.media_items?.first, !first.isEmpty, let url = URL(string: first) {
            return url
        }
        return nil
    }

    var platformInitial: String {
        let p = (previewData?.platform ?? ShareUrlExtractor.displayDomain(for: sharedUrl))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(p.prefix(1)).uppercased().isEmpty ? "L" : String(p.prefix(1)).uppercased()
    }

    func setExtractedShare(_ input: ExtractedShareInput) {
        self.sharedUrl = input.url
        if !input.fallbackTitle.isEmpty && !didUserEditTitle {
            self.titleText = input.fallbackTitle
        }
        if session != nil {
            Task { await loadInitialData() }
        }
    }

    func markTitleEdited() {
        didUserEditTitle = true
    }

    func toggleTag(_ tag: String) {
        let key = tag.lowercased()
        if let idx = selectedTags.firstIndex(where: { $0.lowercased() == key }) {
            selectedTags.remove(at: idx)
        } else {
            selectedTags.append(tag)
        }
    }

    func isTagSelected(_ tag: String) -> Bool {
        let key = tag.lowercased()
        return selectedTags.contains(where: { $0.lowercased() == key })
    }

    func loadInitialData() async {
        guard session != nil, !sharedUrl.isEmpty else { return }
        errorMessage = nil
        isLoadingPreview = true

        async let foldersTask: [ShareFolder]? = try? await ShareApiClient.shared.fetchFolders()
        async let tagsTask: [ShareTag]? = try? await ShareApiClient.shared.fetchTags()
        async let previewTask: SharePreviewResponse? = try? await ShareApiClient.shared.fetchPreview(url: sharedUrl)

        let (fetchedFolders, fetchedTags, fetchedPreview) = await (foldersTask, tagsTask, previewTask)

        if let fetchedFolders {
            self.folders = fetchedFolders
        }
        if let fetchedTags {
            self.userTags = fetchedTags
        }
        if let fetchedPreview {
            self.previewData = fetchedPreview
            if !didUserEditTitle && titleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let candidate = ShareUrlExtractor.scrubGenericTitle(fetchedPreview.title ?? "")
                if !candidate.isEmpty {
                    self.titleText = candidate
                }
            }
        }
        isLoadingPreview = false

        // If key expired and auto-refresh cleared session, reflect logged-out state
        if ShareKeychainStore.loadSession() == nil {
            self.session = nil
            self.errorMessage = "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้ง"
        }
    }

    func signIn() async {
        let email = loginEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty, !loginPassword.isEmpty else {
            errorMessage = "กรุณากรอกอีเมลและรหัสผ่าน"
            return
        }
        isLoggingIn = true
        errorMessage = nil
        do {
            let newSession = try await ShareApiClient.shared.login(
                email: email,
                password: loginPassword,
                apiBaseUrl: apiBaseInput
            )
            self.session = newSession
            self.loginPassword = ""
            await loadInitialData()
        } catch {
            self.errorMessage = error.localizedDescription
        }
        isLoggingIn = false
    }

    func signOut() {
        ShareKeychainStore.clearSession()
        self.session = nil
        self.folders = []
        self.userTags = []
        self.errorMessage = nil
    }

    func createFolderInline() async {
        let clean = inlineFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        isCreatingFolder = true
        errorMessage = nil
        do {
            let created = try await ShareApiClient.shared.createFolder(name: clean)
            if !folders.contains(where: { $0.id == created.id }) {
                folders.insert(created, at: 0)
            }
            selectedFolderId = created.id
            inlineFolderName = ""
            inlineFolderOpen = false
        } catch {
            errorMessage = error.localizedDescription
        }
        isCreatingFolder = false
    }

    func saveLink(onComplete: @escaping () -> Void) async {
        let targetUrl = ShareUrlExtractor.cleanTrailingPunctuation(sharedUrl)
        guard !targetUrl.isEmpty else {
            errorMessage = "ไม่พบลิงก์ที่แชร์เข้ามา"
            return
        }
        isSaving = true
        errorMessage = nil

        let cleanTitle = titleText.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanNote = noteText.trimmingCharacters(in: .whitespacesAndNewlines)

        var allTags = selectedTags.map {
            $0.hasPrefix("#") ? String($0.dropFirst()) : $0
        }
        let extraTags = customTagText
            .split(whereSeparator: { $0 == "," || $0 == " " })
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .map { $0.hasPrefix("#") ? String($0.dropFirst()) : $0 }
            .filter { !$0.isEmpty }
        for t in extraTags where !allTags.contains(where: { $0.caseInsensitiveCompare(t) == .orderedSame }) {
            allTags.append(t)
        }

        var reminderPayload: ShareReminderPayload? = nil
        if let targetDate = reminderPreset.computeTargetDate(customDate: customReminderDate) {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            reminderPayload = ShareReminderPayload(
                schedule_type: "once",
                remind_at: iso.string(from: targetDate),
                timezone: TimeZone.current.identifier.isEmpty ? "Asia/Bangkok" : TimeZone.current.identifier,
                title_snapshot: cleanTitle.isEmpty ? nil : cleanTitle,
                is_enabled: true
            )
        }

        let payload = ShareItemCreatePayload(
            url: targetUrl,
            title: cleanTitle.isEmpty ? nil : cleanTitle,
            note: cleanNote.isEmpty ? nil : cleanNote,
            folder_id: selectedFolderId,
            tags: allTags.isEmpty ? nil : allTags,
            status: "inbox",
            platform: previewData?.platform,
            content_type: previewData?.content_type,
            image_url: previewData?.image_url,
            thumbnail_url: previewData?.image_url,
            media_items: previewData?.media_items,
            embed_url: previewData?.embed_url,
            embed_type: previewData?.embed_type,
            reminder: reminderPayload
        )

        do {
            _ = try await ShareApiClient.shared.saveItem(payload)
            didSaveSuccess = true
            isSaving = false
            try? await Task.sleep(nanoseconds: 650_000_000)
            onComplete()
        } catch {
            isSaving = false
            if case ShareApiError.notAuthenticated = error {
                self.session = nil
            }
            self.errorMessage = error.localizedDescription
        }
    }
}

struct ShareSheetView: View {
    @ObservedObject var vm: ShareSheetViewModel
    let onClose: () -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.36)
                .ignoresSafeArea()
                .onTapGesture {
                    onClose()
                }

            VStack(spacing: 0) {
                if vm.didSaveSuccess {
                    successBannerView
                } else if vm.session == nil {
                    loginSheetView
                } else {
                    externalShareSheetView
                }
            }
            .background(SherlinkTheme.bgApp)
            .clipShape(TopRoundedShape(radius: 20))
            .shadow(color: Color.black.opacity(0.16), radius: 18, x: 0, y: -4)
        }
        .ignoresSafeArea(.container, edges: .bottom)
    }

    // MARK: - Figma 319:541 External Share Sheet

    private var externalShareSheetView: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Drag Handle
            HStack {
                Spacer()
                Capsule()
                    .fill(SherlinkTheme.borderCard)
                    .frame(width: 38, height: 4)
                Spacer()
            }
            .padding(.top, 10)

            // Header Row: "บันทึกลิงก์" + Clock Reminder + Close
            HStack(spacing: 8) {
                Text("บันทึกลิงก์")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(SherlinkTheme.inkStrong)

                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        vm.reminderMenuOpen.toggle()
                    }
                } label: {
                    Image(systemName: vm.reminderPreset == .none ? "clock" : "clock.fill")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundColor(vm.reminderPreset == .none ? SherlinkTheme.inkStrong : SherlinkTheme.accentText)
                        .frame(width: 40, height: 40)
                        .background(vm.reminderPreset == .none ? Color.clear : SherlinkTheme.soft)
                        .clipShape(Circle())
                }
                .accessibilityLabel("ตั้งเตือน")

                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(SherlinkTheme.inkSubtle)
                        .frame(width: 34, height: 34)
                }
                .accessibilityLabel("ปิด")
            }

            if vm.reminderMenuOpen {
                reminderPickerStrip
            }

            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 12) {
                    // Link Preview Card (Figma 319:541)
                    HStack(alignment: .center, spacing: 12) {
                        ZStack {
                            SherlinkTheme.bgThumb
                            if let thumbUrl = vm.resolvedThumbUrl {
                                AsyncImage(url: thumbUrl) { phase in
                                    switch phase {
                                    case .success(let image):
                                        image
                                            .resizable()
                                            .scaledToFill()
                                    case .failure:
                                        Text(vm.platformInitial)
                                            .font(.system(size: 20, weight: .bold))
                                            .foregroundColor(SherlinkTheme.inkSecondary)
                                    default:
                                        ProgressView()
                                    }
                                }
                            } else if vm.isLoadingPreview {
                                ProgressView()
                            } else {
                                Text(vm.platformInitial)
                                    .font(.system(size: 20, weight: .bold))
                                    .foregroundColor(SherlinkTheme.inkSecondary)
                            }
                        }
                        .frame(width: 68, height: 68)
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                        VStack(alignment: .leading, spacing: 4) {
                            TextField(
                                "ชื่อโพสต์",
                                text: Binding(
                                    get: { vm.titleText },
                                    set: {
                                        vm.titleText = $0
                                        vm.markTitleEdited()
                                    }
                                )
                            )
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(SherlinkTheme.inkStrong)

                            Text(vm.displayDomain)
                                .font(.system(size: 13))
                                .foregroundColor(SherlinkTheme.inkSubtle)
                                .lineLimit(1)
                        }
                    }
                    .padding(12)
                    .background(Color.white)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(SherlinkTheme.borderCard, lineWidth: 1)
                    )

                    // Folders Row
                    VStack(alignment: .leading, spacing: 6) {
                        Text("โฟลเดอร์")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(SherlinkTheme.inkSecondary)

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                pillButton(
                                    title: "ไม่ใส่โฟลเดอร์",
                                    isSelected: vm.selectedFolderId == nil,
                                    darkSelected: true
                                ) {
                                    vm.selectedFolderId = nil
                                }

                                ForEach(vm.folders) { folder in
                                    let active = vm.selectedFolderId == folder.id
                                    Button {
                                        vm.selectedFolderId = folder.id
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: "folder")
                                                .font(.system(size: 12, weight: .medium))
                                            Text(folder.name)
                                                .font(.system(size: 13, weight: active ? .bold : .medium))
                                        }
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                        .foregroundColor(active ? SherlinkTheme.accentText : SherlinkTheme.inkStrong)
                                        .background(active ? SherlinkTheme.soft : SherlinkTheme.bgChip)
                                        .overlay(
                                            Capsule().stroke(
                                                active ? SherlinkTheme.accent : Color.clear,
                                                lineWidth: 1
                                            )
                                        )
                                        .clipShape(Capsule())
                                    }
                                }

                                Button {
                                    withAnimation(.easeInOut(duration: 0.16)) {
                                        vm.inlineFolderOpen.toggle()
                                    }
                                } label: {
                                    Text("+ ใหม่")
                                        .font(.system(size: 13, weight: .semibold))
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                        .foregroundColor(SherlinkTheme.accentText)
                                        .background(vm.inlineFolderOpen ? SherlinkTheme.soft : Color.white)
                                        .overlay(
                                            Capsule().stroke(SherlinkTheme.softBorder, lineWidth: 1)
                                        )
                                        .clipShape(Capsule())
                                }
                            }
                            .padding(.vertical, 2)
                        }

                        if vm.inlineFolderOpen {
                            HStack(spacing: 8) {
                                TextField("ชื่อโฟลเดอร์ใหม่ เช่น คาเฟ่", text: $vm.inlineFolderName)
                                    .font(.system(size: 14))
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 9)
                                    .background(SherlinkTheme.bgMuted)
                                    .cornerRadius(10)

                                Button {
                                    Task { await vm.createFolderInline() }
                                } label: {
                                    Text(vm.isCreatingFolder ? "..." : "สร้าง")
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundColor(.white)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 9)
                                        .background(SherlinkTheme.accent)
                                        .cornerRadius(10)
                                }
                                .disabled(vm.isCreatingFolder || vm.inlineFolderName.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                            .padding(.top, 4)
                        }
                    }

                    // Tags Row
                    VStack(alignment: .leading, spacing: 6) {
                        Text("แท็ก")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(SherlinkTheme.inkSecondary)

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(vm.mergedTagOptions, id: \.self) { tag in
                                    pillButton(
                                        title: tag,
                                        isSelected: vm.isTagSelected(tag),
                                        darkSelected: false
                                    ) {
                                        vm.toggleTag(tag)
                                    }
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }

                    // Note Input
                    TextField("เพิ่มโน้ต (ไม่บังคับ)", text: $vm.noteText)
                        .font(.system(size: 14))
                        .foregroundColor(SherlinkTheme.inkStrong)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 11)
                        .background(Color.white)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(SherlinkTheme.borderCard, lineWidth: 1)
                        )

                    if let err = vm.errorMessage {
                        Text(err)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(SherlinkTheme.accentText)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(SherlinkTheme.soft)
                            .cornerRadius(8)
                    }
                }
            }
            .frame(maxHeight: 360)

            // Primary Save Button
            Button {
                Task { await vm.saveLink(onComplete: onClose) }
            } label: {
                HStack(spacing: 8) {
                    if vm.isSaving {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    }
                    Text(vm.isSaving ? "กำลังบันทึก..." : "บันทึก")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.white)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .background(SherlinkTheme.accent)
                .opacity(vm.isSaving ? 0.65 : 1.0)
                .cornerRadius(12)
            }
            .disabled(vm.isSaving || vm.sharedUrl.isEmpty)

            // Account footer
            if let email = vm.session?.email {
                HStack {
                    Text("บัญชี: \(email)")
                        .font(.system(size: 11))
                        .foregroundColor(SherlinkTheme.inkSubtle)
                        .lineLimit(1)
                    Spacer()
                    Button("สลับบัญชี") {
                        vm.signOut()
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(SherlinkTheme.accentText)
                }
                .padding(.bottom, 16)
            }
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 10)
    }

    private var reminderPickerStrip: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ShareReminderPreset.allCases) { preset in
                        pillButton(
                            title: preset.label,
                            isSelected: vm.reminderPreset == preset,
                            darkSelected: false
                        ) {
                            vm.reminderPreset = preset
                        }
                    }
                }
            }
            if vm.reminderPreset == .custom {
                DatePicker(
                    "เวลาเตือน",
                    selection: $vm.customReminderDate,
                    in: Date()...,
                    displayedComponents: [.date, .hourAndMinute]
                )
                .datePickerStyle(.compact)
                .font(.system(size: 13))
            }
        }
        .padding(10)
        .background(SherlinkTheme.bgMuted)
        .cornerRadius(10)
    }

    // MARK: - One-Time Login Sheet (Free Apple ID compatible)

    private var loginSheetView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Spacer()
                Capsule()
                    .fill(SherlinkTheme.borderCard)
                    .frame(width: 38, height: 4)
                Spacer()
            }
            .padding(.top, 10)

            HStack {
                Text("เชื่อมต่อ Sherlink Share Sheet")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(SherlinkTheme.inkStrong)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(SherlinkTheme.inkSubtle)
                        .frame(width: 34, height: 34)
                }
            }

            Text("เข้าสู่ระบบครั้งเดียว เพื่อบันทึกลิงก์จาก IG / TikTok ได้ทันทีโดยไม่ต้องออกจากแอป")
                .font(.system(size: 13))
                .foregroundColor(SherlinkTheme.inkSecondary)

            TextField("อีเมล", text: $vm.loginEmail)
                .keyboardType(.emailAddress)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .font(.system(size: 15))
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(SherlinkTheme.bgMuted)
                .cornerRadius(10)

            SecureField("รหัสผ่าน", text: $vm.loginPassword)
                .font(.system(size: 15))
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(SherlinkTheme.bgMuted)
                .cornerRadius(10)

            Button {
                vm.showServerConfig.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 11))
                    Text(vm.showServerConfig ? "ซ่อนตั้งค่า Server" : "ตั้งค่า Server API (\(vm.apiBaseInput))")
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)
                }
                .foregroundColor(SherlinkTheme.inkSubtle)
            }

            if vm.showServerConfig {
                TextField("https://just-save-it-api.onrender.com", text: $vm.apiBaseInput)
                    .keyboardType(.URL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .font(.system(size: 13))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(SherlinkTheme.bgMuted)
                    .cornerRadius(8)
            }

            if let err = vm.errorMessage {
                Text(err)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(SherlinkTheme.accentText)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SherlinkTheme.soft)
                    .cornerRadius(8)
            }

            Button {
                Task { await vm.signIn() }
            } label: {
                HStack(spacing: 8) {
                    if vm.isLoggingIn {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    }
                    Text(vm.isLoggingIn ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบและบันทึกลิงก์")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.white)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .background(SherlinkTheme.accent)
                .opacity(vm.isLoggingIn ? 0.65 : 1.0)
                .cornerRadius(12)
            }
            .disabled(vm.isLoggingIn)
            .padding(.bottom, 22)
        }
        .padding(.horizontal, 18)
    }

    // MARK: - Save Success State

    private var successBannerView: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 46))
                .foregroundColor(SherlinkTheme.accent)
            Text("บันทึกเข้า Sherlink แล้ว!")
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(SherlinkTheme.inkStrong)
            if !vm.displayDomain.isEmpty {
                Text(vm.displayDomain)
                    .font(.system(size: 13))
                    .foregroundColor(SherlinkTheme.inkSubtle)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
        .padding(.bottom, 16)
    }

    // MARK: - Shared Pill Button Helper

    private func pillButton(
        title: String,
        isSelected: Bool,
        darkSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        let fg: Color = isSelected
            ? (darkSelected ? .white : SherlinkTheme.accentText)
            : SherlinkTheme.inkStrong
        let bg: Color = isSelected
            ? (darkSelected ? SherlinkTheme.chipDark : SherlinkTheme.soft)
            : SherlinkTheme.bgChip
        let border: Color = isSelected
            ? (darkSelected ? SherlinkTheme.chipDark : SherlinkTheme.accent)
            : Color.clear

        return Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: isSelected ? .bold : .medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundColor(fg)
                .background(bg)
                .overlay(Capsule().stroke(border, lineWidth: 1))
                .clipShape(Capsule())
        }
    }
}

private struct TopRoundedShape: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        let path = UIBezierPath(
            roundedRect: rect,
            byRoundingCorners: [.topLeft, .topRight],
            cornerRadii: CGSize(width: radius, height: radius)
        )
        return Path(path.cgPath)
    }
}
