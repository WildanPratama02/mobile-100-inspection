# Mobile 100% Inspection — Starter Kit untuk Claude Code

Folder ini adalah titik awal repo. Isinya dokumen perencanaan, design system, mapping defect, prototype, dan aturan kerja (`CLAUDE.md`) yang dibaca otomatis oleh Claude Code setiap sesi.

```
mobile-100-inspection/
├── CLAUDE.md                  ← aturan utama untuk Claude Code (selalu dimuat)
├── .claude/
│   ├── settings.json          ← melarang Claude membaca .env / secrets
│   └── rules/                 ← aturan khusus: UI web, API + spreadsheet
├── docs/                      ← 00 Document Map, 01 PRD, 02 Data Design, 03 TDD (draft), 04 API Contract, 07 ADR, 08 Implementation Plan
├── design-system/             ← tokens.json, tokens.css, README, komponen (bundle.js referensi), foto sepatu
└── reference/
    ├── prototype/app.html     ← prototype klik (layout & alur; warnanya versi lama)
    └── mapping/               ← Footwear_Defect_Mapping_Database_v2.xlsx + mapping.json
```

## 1. Persiapan (sekali saja)

1. Install Claude Code. Di Windows PowerShell:
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```
   Di macOS / Linux / WSL:
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```
   Cek dengan `claude --version`. Butuh akun Pro, Max, Team atau Enterprise (atau Console).
2. Install Node.js 22 LTS, pnpm (`npm i -g pnpm`) dan Git. Di Windows, Git for Windows disarankan.
3. Ekstrak folder ini, lalu:
   ```bash
   cd mobile-100-inspection
   git init && git add . && git commit -m "Planning docs and design system"
   claude
   ```
   Login lewat browser saat diminta.

## 2. Cara kerja per task

Satu sesi = satu task dari `docs/08-implementation-plan.md`.

1. Masuk **plan mode**: tekan `Shift+Tab` sampai status bar menunjukkan `⏸ plan mode on` (atau jalankan `claude --permission-mode plan`).
2. Kirim prompt task (contoh di bawah). Claude membaca dokumen, lalu menyusun rencana tanpa mengubah file.
3. Periksa rencananya. Kalau sudah sesuai, setujui; Claude mulai menulis kode.
4. Pastikan test hijau, cek hasilnya di browser, lalu commit.
5. Mulai sesi baru (`/clear`) untuk task berikutnya, supaya konteks tetap bersih.

Lanjutkan sesi terakhir dengan `claude --continue`.

## 3. Prompt awal yang bisa langsung dipakai

**Sesi pertama: cek pemahaman, belum menulis kode**
```
Baca CLAUDE.md, docs/00-document-map.md, docs/01-prd.md, docs/07-decision-log.md dan docs/08-implementation-plan.md.
Ringkas dalam 10 poin apa yang akan dibangun, lalu sebutkan hal yang menurutmu ambigu atau saling bertentangan. Jangan menulis kode.
```

**T0.1**
```
Kerjakan T0.1 dari docs/08-implementation-plan.md. Buat rencana dulu: struktur folder, package dan versi, script root. Setelah saya setujui, scaffold, jalankan semua acceptance check, dan update bagian Commands di CLAUDE.md.
```

**T0.3 (counting engine)**
```
Kerjakan T0.3. Tulis test dulu dari tabel ADR-008 dan aturan UNDO di FR-08, pastikan test gagal, baru implementasikan sampai hijau.
```

**T1.4 (layar Defect)**
```
Kerjakan T1.4. Ikuti layout dan alur reference/prototype/app.html, tapi tampilannya dari design-system (komponen ShoeMap, CommandButton, OptionRow, Breadcrumb, HistoryRow, BottomBar). Tambahkan Playwright test untuk semua AC yang disebut di task.
```

## 4. Yang belum boleh dikerjakan

Phase 0–3 sudah bisa dikerjakan: PWA offline, API NestJS (login, master data, pencarian PO), lalu Submit PO ke spreadsheet dan upload foto (doc 02, 03, 04 sudah tersedia; doc 03 masih draft v0.2). Phase 4 (deploy dan pilot) dimulai dengan pemeriksaan server (doc 03 §7.3). Server memakai Windows dan dirawat tim QIP Digital, jadi script deploy memakai PowerShell atau Node, bukan bash. HTTPS sudah diputuskan: `https://m100.qdms.web.id` lewat Cloudflare (ADR-016). Doc 05 (UI/UX, draft v0.2) sudah ada; dua keputusan di dalamnya (U2, U10) masih menunggu konfirmasi pemilik; U1 (OQ-07) sudah dikonfirmasi 19 Okt 2026. `CLAUDE.md` sudah menyuruh Claude berhenti dan bertanya kalau task menyentuh hal-hal itu.

Sebelum Phase 2, siapkan dulu (bukan pekerjaan Claude): salinan spreadsheet, service account Google, folder Drive uji, dan, sebelum T3.5, OAuth client dengan consent screen berstatus **In production** (daftar lengkap di `docs/08-implementation-plan.md`).

Untuk development, gunakan **salinan** spreadsheet "100%INLINE IMPACTIVA". Simpan ID spreadsheet, file service account, token OAuth Drive dan daftar device key di `.env` / `secrets/`; semuanya sudah di `.gitignore` dan diblokir dari Claude.
