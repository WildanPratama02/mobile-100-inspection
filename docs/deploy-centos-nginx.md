# Deploy produksi ke server Linux (CentOS Stream 10 + Nginx + PostgreSQL)

| | |
|---|---|
| Status | **Usulan (draft)**, diperbarui 26 Nov 2026. Konfigurasi sudah ada di `deploy/linux/` dan rilis dibangun dengan `pnpm release`; belum ada langkah yang dijalankan di server. |
| Target | `192.168.40.193`: CentOS Stream 10, PostgreSQL 18.4, nginx 1.26.3, Node.js v26.13.0, SELinux Enforcing, certbot 5.10.0, keluar ke API Cloudflare dan Let's Encrypt |

> **Alamat lama dalam dokumen ini:** teks di bawah masih menyebut `server-qiplab` / `10.3.12.3`. Itu sama dengan server `192.168.40.193`; bacalah sebagai server ini. Pengecekan K2, K3, K6 dan K9 sudah terjawab oleh spesifikasi di atas (CentOS 10, PostgreSQL 18, akses Cloudflare/Let's Encrypt, SELinux Enforcing).

## 0. Alur singkat (pakai ini)

**Di laptop (Windows)** setiap rilis:

```powershell
pnpm install            # sekali; supportedArchitectures di pnpm-workspace.yaml ikut memasang biner argon2 Linux
pnpm release            # menghasilkan release\m100-<versi>.tar.gz untuk Linux x64 (glibc)
# pnpm release -- --target windows   -> zip lama untuk server Windows
```

`pnpm release` membangun web, admin dan API, mengambil dependensi produksi, hanya menyisakan biner `@node-rs/argon2-linux-x64-gnu`, lalu mengemas `release\m100-<versi>.tar.gz` (termasuk `deploy/linux/`). Server tidak perlu git, pnpm, atau internet npm.

**Unggah dengan FileZilla (SFTP)**: host `192.168.40.193`, port 22, pengguna operator (bukan root). Taruh file di `/home/<user>/upload/`. Jangan unggah `.env`, `secrets/` atau `jwt.key`.

**Instalasi pertama** (di server, SSH):

```bash
# 0. sekali: zona waktu, pengguna operator sudah punya sudo
sudo timedatectl set-timezone Asia/Jakarta
mkdir -p /tmp/m100-rel && tar -xzf ~/upload/m100-<versi>.tar.gz -C /tmp/m100-rel
sudo bash /tmp/m100-rel/deploy/linux/install.sh      # user m100, folder, .env, unit systemd, nginx, SELinux, firewall
sudo nano /opt/m100/.env                             # periksa; BACKUP_DIR dan PG_BIN
# sertifikat: §7.1 (certbot + dns-cloudflare), lalu:
sudo nginx -t && sudo systemctl reload nginx
sudo bash /opt/m100/current/deploy/linux/m100.sh bootstrap   # role dan database m100
sudo bash /opt/m100/current/deploy/linux/m100.sh migrate
sudo systemctl enable --now m100-api
sudo bash /opt/m100/current/deploy/linux/m100.sh health
sudo bash /opt/m100/current/deploy/linux/m100.sh admin-create --username admin
```

**Update berikutnya** (pergantian shift): `pnpm release` → FileZilla ke `~/upload/` → di server:

```bash
sudo bash /opt/m100/current/deploy/linux/upgrade.sh ~/upload/m100-<versi baru>.tar.gz
sudo bash /opt/m100/current/deploy/linux/upgrade.sh --rollback     # bila perlu (migrasi satu arah tidak dibatalkan)
```

`upgrade.sh` membuat backup `pre-upgrade`, membongkar rilis ke `/opt/m100/releases/<versi>`, menjalankan migrasi, memindah symlink `current`, restart `m100-api`, dan menunggu `/v1/health` selama 60 detik; bila tidak sehat, symlink dikembalikan. Rilis disimpan 5 terakhir. Perubahan `deploy/linux/m100.conf` tidak diterapkan otomatis: file barunya disimpan sebagai `/etc/nginx/conf.d/m100.conf.new`; bandingkan, salin, `nginx -t`, reload.

**Perintah harian**: `m100.sh status | logs | health | backup | sweep --dry-run | device-add --label "..." | device-list | device-revoke | import-master --dir ...`.

**Catatan Node.js 26.** Proyek diuji pada Node 22 LTS (`engines`). Rilis tidak memeriksa `engines` (tanpa pnpm di server) dan `@node-rs/argon2` memakai N-API yang stabil antar versi, jadi Node 26 seharusnya jalan, tetapi **belum teruji**. Setelah instalasi, uji login admin (argon2), submit PO dengan foto, backup dan restore sebelum dipakai produksi. Bila ada masalah, pasang Node 22 (`dnf module`/NodeSource) dan jalankan ulang `install.sh` (menulis ulang path `node` di unit systemd).

**Catatan SELinux.** `install.sh` mengaktifkan `httpd_can_network_connect` dan memberi label `httpd_sys_content_t` pada `/opt/m100/releases` dan symlink `current`. Jangan mematikan SELinux. Bila nginx menjawab 403: `sudo ausearch -m avc -ts recent`. Bila API tidak bisa menulis foto: periksa pemilik `/opt/m100/photos` (`m100:m100`).

**Port 3110** dipakai API (`PORT` di `.env`). Bila bentrok: `ss -ltnp | grep 3110`, ubah `PORT` dan `upstream` di `m100.conf` bersama-sama.

Bagian di bawah adalah rincian dan alasan di balik langkah-langkah ini.

---

| | |
|---|---|
| Target lama | `server-qiplab`, `10.3.12.3` (lihat catatan di atas) |
| Mengubah | doc 03 §7 (Windows + Caddy), ADR-015/016/018 bagian server. Perlu ADR baru (usulan: ADR-023) sebelum dijalankan. |
| Tidak berubah | Kode aplikasi, skema database, kontrak API, alamat `https://m100.qdms.web.id` |

Dokumen ini adalah rencana dan runbook. Semua yang bertanda **PERLU DICEK** atau **KEPUTUSAN** belum diketahui dari repositori dan harus dijawab dulu (§2). Perintah di bawah belum pernah diuji di server-qiplab.

---

## 1. Ringkasan

Aplikasi dibangun untuk satu server Windows dengan Caddy (doc 03 §7). Pindah ke CentOS + Nginx **tidak mengubah kode aplikasi**; yang berubah hanya lapisan operasi:

| Bagian | Sekarang (Windows) | Di server-qiplab (CentOS) |
|---|---|---|
| Web server / TLS | Caddy, sertifikat Let's Encrypt lewat DNS challenge Cloudflare | Nginx, sertifikat Let's Encrypt lewat `certbot` + plugin `dns-cloudflare` |
| Proses API | Layanan WinSW `m100-api`, `127.0.0.1:3000` | Unit systemd `m100-api`, `127.0.0.1:3110` (port 3000 sudah dipakai) |
| Database | PostgreSQL 18 layanan Windows | PostgreSQL 18 (ADR-020), `127.0.0.1` |
| Foto | Folder `photos\` | Folder `/opt/m100/photos` (`PHOTO_STORE=disk`) |
| Paket rilis | `pnpm release` (zip, Windows x64 saja) | Tarball yang dibangun di Linux x64 (§6) |
| Skrip operasi | `deploy\windows\*.ps1` | Perintah `node …/dist/cli/*.js`, systemd timer (§9, §11) |
| Firewall | Windows Firewall, aturan `M100-HTTPS` | `firewalld`, hanya 443 dari subnet tablet dan admin |

Topologi tujuan:

```
tablet ──HTTPS 443──▶ nginx (server_name m100.qdms.web.id)
admin  ──HTTPS 443──▶   ├▶ /           file statis  /opt/m100/current/web
                        ├▶ /admin/*    file statis  /opt/m100/current/admin
                        └▶ /v1/*       127.0.0.1:3110  (NestJS, systemd m100-api)
                                         ├▶ PostgreSQL 127.0.0.1:5432
                                         └▶ /opt/m100/photos
proyek lama ──────────▶ nginx (server block-nya sendiri) ──▶ port 3000   (tidak disentuh)
```

### Soal port 3000

API M100 secara bawaan mendengar di `127.0.0.1:3000`. Port itu bisa diganti dengan variabel `PORT` di `.env`, tanpa mengubah kode. Rencana ini memakai **`PORT=3110`** (pastikan bebas: `ss -ltnp | grep 3110`).

Dua aplikasi bisa hidup di satu Nginx karena masing-masing punya `server` block sendiri: M100 dikenali dari `server_name m100.qdms.web.id` pada port 443, proyek lama tetap pada konfigurasinya. File konfigurasi proyek lama **tidak diubah**; M100 hanya menambah satu file baru di `/etc/nginx/conf.d/`.

---

## 2. Yang harus diputuskan atau dicek dulu

Tanpa jawaban ini rencana tidak boleh dijalankan.

| # | Pertanyaan | Kenapa penting |
|---|---|---|
| K1 | **KEPUTUSAN:** server-qiplab menggantikan server Windows produksi (`D:\Project\M100`, PostgreSQL 18.1), atau menjadi staging / server kedua? | Kalau menggantikan, perlu migrasi data dan cutover (§10). Kalau staging, §10 dilewati dan **nama host harus lain** (mis. `m100-staging.qdms.web.id`). |
| K2 | **PERLU DICEK:** versi CentOS (`cat /etc/os-release`, `ldd --version`). | Node.js 22 butuh glibc ≥ 2.28. **CentOS 7 (glibc 2.17) tidak bisa menjalankan Node.js 22** dan sudah habis masa dukungannya (Juni 2024). Perlu CentOS Stream 9 (atau 8 / Rocky / Alma 8+). Kalau server masih CentOS 7, rencana ini berhenti di sini. |
| K3 | **PERLU DICEK:** PostgreSQL yang sudah ada di server (`psql -V`, `SELECT version();`), dipakai proyek lama atau tidak. | ADR-020 menetapkan PostgreSQL **18** untuk produksi; dump dari server 18 tidak bisa dipulihkan ke versi lebih lama. Kalau yang ada bukan 18, pasang 18 berdampingan pada port lain (mis. 5433) dan jangan upgrade cluster proyek lama. |
| K4 | **PERLU DICEK:** proyek lama memakai port apa saja di Nginx (`nginx -T`, `ss -ltnp`). Apakah ada `server` block yang sudah mendengar di 443, dan mana yang `default_server`? | Menentukan apakah M100 cukup menambah satu `server` block 443. Kalau 443 belum dipakai, perlu dibuka di firewall. |
| K5 | **PERLU DICEK:** tablet (Wi-Fi pabrik) dan PC admin bisa menjangkau `10.3.12.3:443`? Server lama ada di `192.168.43.175`, subnet berbeda. | Tanpa rute/aturan firewall jaringan, tablet tidak bisa mengirim. |
| K6 | **PERLU DICEK:** server bisa keluar ke `api.cloudflare.com` dan `acme-v02.api.letsencrypt.org` (443)? | Diperlukan untuk menerbitkan dan memperpanjang sertifikat. Tidak perlu port masuk dari internet. |
| K7 | **KEPUTUSAN:** lokasi backup (`BACKUP_DIR`): disk lain atau share jaringan, bukan disk yang sama dengan data. | Risiko A1 di `phase5-release-preparation.md` §8.1 jangan terulang. |
| K8 | **KEPUTUSAN:** siapa pemegang akses `root`/`sudo` dan siapa yang mengoperasikan (tetap QIP Digital Team?). | Runbook, perpanjangan token, uji restore. |
| K9 | **PERLU DICEK:** SELinux `Enforcing`? (`getenforce`) | Menentukan langkah §7.4. Jangan mematikan SELinux; proyek lama mungkin bergantung padanya. |

**Nama host jangan diganti** bila ini menggantikan produksi. Browser menyimpan data per *origin*: host lain berarti IndexedDB kosong, tablet kehilangan device key dan sesi yang belum terkirim (doc 03 §7.2). Dengan nama yang sama (`m100.qdms.web.id`), cukup record DNS `A` yang pindah ke `10.3.12.3`.

---

## 3. Perubahan di repositori (tugas terpisah, belum dikerjakan)

Deploy pertama bisa dilakukan dengan tangan mengikuti dokumen ini. Supaya bisa diulang dan teruji, perubahan berikut perlu dijadwalkan sebagai tugas di `docs/08-implementation-plan.md`:

**Status 26 Nov 2026:** butir 2 (`deploy/linux/m100.conf`, `m100-headers.conf`, unit systemd, `install.sh`, `upgrade.sh`, `m100.sh`) dan butir 3 (`pnpm release` menghasilkan tarball Linux, `--target windows` untuk zip lama) sudah dikerjakan; butir 4 tidak perlu: `backup.ts` melewati entri yang tidak ada (`existsSync`), jadi `caddy-data` yang absen tidak membuat backup gagal. Yang tersisa: ADR baru (nomor 023 sudah dipakai di CLAUDE.md untuk NO DEFECT total; pakai nomor berikutnya yang bebas), butir 5 dan 6, tes isi `m100.conf` terhadap `security-headers.json`/`cache-control.json`, dan dua catatan: skrip bash di `deploy/linux/` melanggar aturan "tanpa bash di `deploy/`" di CLAUDE.md, yang berlaku untuk server Windows (aturan itu perlu diubah lewat ADR), dan `pnpm release` kini membangun Linux secara bawaan.

1. **ADR-023** "Server produksi CentOS + Nginx": mencatat keputusan K1–K3, dan mengubah aturan "server adalah Windows; tidak ada skrip bash di `deploy/`" (CLAUDE.md, `.claude/rules/api-postgres.md`).
2. **`deploy/nginx/m100.conf`** dan **`deploy/systemd/*.service|*.timer`** dari §7 dan §11, dengan tes seperti `deploy/test/caddyfile.spec.ts` (header harus sama dengan `security-headers.json` dan `cache-control.json`).
3. **`deploy/build-release.mjs`**: sekarang menolak selain `win32` dan membuat zip dengan `tar.exe` Windows. Perlu jalur Linux (tarball).
4. **`apps/api/src/backup/backup.ts`**: `CONFIG_ENTRIES` berisi `caddy-data`, yang tidak ada di Linux. **PERLU DICEK** apakah backup melewati entri yang tidak ada atau gagal; lihat §11.
5. **Doc 03 §7** dan `phase5-recovery-runbook.md` diperbarui setelah ADR diterima.
6. Komentar "Only Caddy listens…" di `apps/api/src/main.ts` dan `app.ts` (kosmetik).

---

## 4. Tata letak di server

```
/opt/m100/                      pemilik root, grup m100
├── .env                        0640 root:m100   (konfigurasi, §8)
├── secrets/                    0750 root:m100
│   └── jwt.key                 0640 root:m100   (≥ 32 byte acak)
├── photos/                     0750 m100:m100   (hanya API yang menulis)
├── releases/<versi>/           root:root, hanya-baca
│   ├── web/  admin/  api/  db/migrations/  reference/mapping/  VERSION
└── current -> releases/<versi> (symlink, diganti saat upgrade)
```

- Pengguna sistem `m100` (tanpa login, tanpa shell) menjalankan API.
- Nginx (pengguna `nginx`) hanya membaca `releases/`; tidak membaca `.env`, `secrets/`, `photos/`.
- `api/dist` mencari `db/migrations` dan `reference/mapping` di folder induk terdekat, jadi keduanya harus bersebelahan dengan `api/` seperti di atas.
- Semua perintah CLI dijalankan **dari `/opt/m100`**, karena `.env` dibaca dari direktori kerja.

---

## 5. Menyiapkan server (sekali)

Jalankan sebagai `root`. Server-qiplab: **CentOS Stream 10** (diperiksa 18 Nov 2026), jadi K2 terpenuhi (glibc cukup untuk Node.js 22). Di server itu juga sudah terlihat: PostgreSQL 18.4 sudah terpasang dan mendengar di `127.0.0.1:5432` dan `[::1]:5432` (K3 terpenuhi, lewati §5.3 pemasangan); Nginx sudah mendengar di 80 dan 443; proyek lama di `*:3000` (semua antarmuka, bukan hanya loopback); port 3110 bebas; port lain terpakai: 3306, 8090, 9090, 4330, 44321, 631, 3389.

### 5.1 Waktu dan zona

```bash
timedatectl set-timezone Asia/Jakarta
systemctl enable --now chronyd
chronyc tracking            # harus tersinkron; token ditolak bila jam melenceng
```

### 5.2 Node.js (server ini: v26.13.0 sudah terpasang, lewati)

Bagian ini hanya bila Node perlu dipasang ulang. Proyek diuji pada Node.js 22 LTS (≥ 22.13); lihat catatan Node 26 di §0.

```bash
dnf module disable -y nodejs
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
node --version              # v22.13 atau lebih baru, < 23
```

`pnpm` tidak perlu ada di server bila rilis dibangun di mesin lain (§6, cara A).

### 5.3 PostgreSQL 18

**Di server-qiplab dilewati:** PostgreSQL 18.4 sudah ada. M100 hanya menambah database `m100` dan role `m100_*` di cluster itu; database proyek lama tidak disentuh. Yang perlu dicek: lokasi `pg_dump` 18 (`rpm -ql postgresql18 | grep pg_dump` atau `which pg_dump`, untuk `PG_BIN`), nama service (`systemctl list-units 'postgresql*'`), dan aturan `pg_hba.conf` (`sudo -u postgres psql -c "SHOW hba_file"`) agar login `scram-sha-256` dari `127.0.0.1` untuk role `m100_*` diterima. Jangan ubah aturan yang dipakai proyek lama. Pada contoh di bawah, `/usr/pgsql-18/bin` dan `postgresql-18` adalah nama dari repo PGDG; sesuaikan dengan hasil pengecekan itu.

Pemasangan baru (hanya bila tidak ada cluster 18; CentOS Stream 10 memakai repo `EL-10`):

```bash
dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-10-x86_64/pgdg-redhat-repo-latest.noarch.rpm
dnf -qy module disable postgresql
dnf install -y postgresql18-server
/usr/pgsql-18/bin/postgresql-18-setup initdb
systemctl enable --now postgresql-18
```

Di `/var/lib/pgsql/18/data/postgresql.conf`: `listen_addresses = 'localhost'`, `timezone = 'Asia/Jakarta'`.
Di `pg_hba.conf`, koneksi TCP lokal memakai kata sandi:

```
host    all    all    127.0.0.1/32    scram-sha-256
```

`systemctl restart postgresql-18`. Port 5432 **tidak** dibuka di firewall.

### 5.4 Pengguna dan folder

```bash
useradd --system --home-dir /opt/m100 --shell /sbin/nologin m100
install -d -o root -g m100 -m 0750 /opt/m100 /opt/m100/secrets
install -d -o m100 -g m100 -m 0750 /opt/m100/photos
install -d -o root -g root -m 0755 /opt/m100/releases
chmod 0751 /opt/m100          # nginx perlu menembus ke releases/, tanpa bisa melihat isi folder
head -c 32 /dev/urandom > /opt/m100/secrets/jwt.key
chown root:m100 /opt/m100/secrets/jwt.key && chmod 0640 /opt/m100/secrets/jwt.key
```

Bila ini migrasi dari Windows (§10), **jangan** membuat `jwt.key` baru; salin yang lama.

### 5.5 Firewall

```bash
firewall-cmd --permanent --new-zone=m100
firewall-cmd --permanent --zone=m100 --add-source=<subnet tablet>/24
firewall-cmd --permanent --zone=m100 --add-source=<subnet admin>/24
firewall-cmd --permanent --zone=m100 --add-service=https
firewall-cmd --reload
```

Sesuaikan dengan aturan yang sudah ada untuk proyek lama (`firewall-cmd --list-all-zones`); jangan menghapus aturan apa pun. Port 3110 dan 5432 tidak dibuka.

---

## 6. Membangun rilis

**Cara yang dipakai: `pnpm release` di laptop Windows (§0).** API memuat modul native `@node-rs/argon2`; `pnpm-workspace.yaml` (`supportedArchitectures`) membuat pnpm ikut memasang biner `linux-x64-gnu`, dan `deploy/build-release.mjs` membuang biner platform lain dari rilis. Perintah manual di bawah hanya cadangan bila `pnpm release` tidak bisa dipakai (bangun di mesin Linux).

**Cara A (disarankan): bangun di mesin Linux lain** (WSL2 di laptop pengembang, atau container `node:22`), lalu kirim tarball. Server produksi tidak perlu git, pnpm, atau akses ke registry npm.

**Cara B: bangun di server-qiplab** dari `git clone`. Lebih sederhana, tetapi server perlu internet ke registry npm dan menyimpan kode sumber serta alat build.

Langkah (sama untuk A dan B), dari commit `main` yang sudah lulus `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm e2e`:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build

VERSION="$(TZ=Asia/Jakarta date +%Y.%m.%d)-$(git rev-parse --short HEAD)"
OUT="release/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT"

# dependensi produksi sebagai folder nyata (tanpa symlink)
pnpm --filter api --config.node-linker=hoisted deploy --prod --legacy "$OUT/api"
# pnpm deploy ikut menyalin sumber dan .env lokal: sisakan hanya tiga ini
find "$OUT/api" -mindepth 1 -maxdepth 1 ! -name dist ! -name node_modules ! -name package.json -exec rm -rf {} +

cp -r apps/web/dist     "$OUT/web"
cp -r apps/admin/dist   "$OUT/admin"
mkdir -p "$OUT/db" "$OUT/reference"
cp -r db/migrations     "$OUT/db/migrations"
cp -r reference/mapping "$OUT/reference/mapping"
echo "$VERSION" > "$OUT/VERSION"

# tidak boleh ada .env atau folder secrets di dalam rilis
find "$OUT" \( -name '.env' -o -name '.env.*' -o -type d -name secrets \) ! -name '.env.example' | grep . && echo "BERHENTI: ada rahasia di rilis"

tar -C release -czf "release/m100-$VERSION.tar.gz" "$VERSION"
```

Kirim ke server (cara A):

```bash
scp "release/m100-$VERSION.tar.gz" <user>@10.3.12.3:/tmp/
```

Pasang di server:

```bash
tar -C /opt/m100/releases -xzf /tmp/m100-<versi>.tar.gz
chown -R root:root /opt/m100/releases/<versi>
chmod -R a+rX,go-w /opt/m100/releases/<versi>
ln -sfn /opt/m100/releases/<versi> /opt/m100/current
```

---

## 7. Nginx

### 7.1 Sertifikat (Let's Encrypt, DNS challenge Cloudflare)

Chrome hanya menjalankan service worker dan menawarkan instalasi PWA lewat HTTPS dengan sertifikat tepercaya (ADR-016). Nginx tidak mengurus sertifikat sendiri seperti Caddy, jadi dipakai `certbot`. DNS challenge tidak butuh port masuk dari internet.

```bash
dnf install -y epel-release
dnf install -y certbot python3-certbot-dns-cloudflare

install -d -m 0700 /etc/letsencrypt
cat > /etc/letsencrypt/cloudflare.ini   # isi: dns_cloudflare_api_token = <token>
chmod 0600 /etc/letsencrypt/cloudflare.ini

certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d m100.qdms.web.id \
  --deploy-hook "systemctl reload nginx"

systemctl enable --now certbot-renew.timer
certbot renew --dry-run
```

Token Cloudflare: *Zone → Zone → Read* dan *Zone → DNS → Edit*, terbatas pada zona `qdms.web.id` (doc 03 §7.2.1 langkah 5). Token yang sekarang dipakai Caddy di Windows bisa dipakai, tetapi lebih baik buat token baru dan cabut yang lama setelah cutover.

Sertifikat untuk nama yang sama bisa diterbitkan di server baru **sebelum** DNS dipindah, karena pembuktiannya lewat record TXT, bukan lewat alamat `A`.

### 7.2 Header bersama

`/etc/nginx/snippets/m100-headers.conf` (harus sama dengan `deploy/security-headers.json`):

```nginx
add_header Content-Security-Policy "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
# HSTS setelah HTTPS stabil (doc 03 §6); sesudah itu nama ini tidak bisa kembali ke HTTP.
# add_header Strict-Transport-Security "max-age=31536000" always;
```

Di Nginx, `add_header` di dalam `location` **menggantikan** semua `add_header` dari tingkat `server`. Karena tiap `location` di bawah menambah `Cache-Control`, snippet ini di-`include` di setiap `location`, bukan di `server`.

### 7.3 Server block

`/etc/nginx/conf.d/m100.conf` (file baru; file proyek lama tidak disentuh):

```nginx
upstream m100_api {
    server 127.0.0.1:3110;
    keepalive 16;
}

server {
    listen 443 ssl;
    http2 on;                                # nginx < 1.25.1: tulis "listen 443 ssl http2;" dan hapus baris ini
    server_name m100.qdms.web.id;

    ssl_certificate     /etc/letsencrypt/live/m100.qdms.web.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/m100.qdms.web.id/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    server_tokens off;
    gzip on;
    gzip_types text/css application/javascript application/json application/manifest+json image/svg+xml;

    # Satu Submit PO: sampai 98 foto + JSON, batas 100 MB (CLAUDE.md aturan 6). Bawaan nginx hanya 1 MB.
    client_max_body_size 100m;

    # API: hanya loopback, tidak pernah di-cache, prefiks /v1 tidak dibuang.
    location /v1/ {
        include snippets/m100-headers.conf;
        add_header Cache-Control "no-store" always;

        proxy_pass http://m100_api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Ditimpa, bukan ditambah: API mempercayai proxy loopback dan membatasi laju per IP klien.
        proxy_set_header X-Forwarded-For $remote_addr;

        client_body_timeout 120s;
        proxy_read_timeout  120s;            # di atas SUBMIT_TIMEOUT_SECONDS (60)
        proxy_send_timeout  120s;
    }

    location = /admin { return 308 /admin/; }

    # Aplikasi admin: online saja, tanpa service worker.
    location /admin/assets/ {
        root /opt/m100/current;
        include snippets/m100-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }
    location /admin/ {
        root /opt/m100/current;
        include snippets/m100-headers.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri /admin/index.html;
    }

    # PWA tablet. File ber-hash di /assets/ tidak pernah berubah; sisanya (index.html, sw.js, manifest,
    # ikon, rute aplikasi) selalu divalidasi ulang supaya rilis baru sampai ke tablet.
    location /assets/ {
        root /opt/m100/current/web;
        include snippets/m100-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }
    location / {
        root /opt/m100/current/web;
        include snippets/m100-headers.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri /index.html;
    }
}
```

Perbedaan yang diketahui dari Caddyfile: (1) Nginx bawaan tidak punya `zstd`, hanya `gzip`; (2) header `Server: nginx` tetap terkirim tanpa nomor versi (`server_tokens off`), menghapusnya butuh modul `headers-more`; (3) file `/assets/…` yang tidak ada dijawab `404`, bukan `index.html`.

Port 80 untuk nama ini tidak dilayani dengan sengaja: tablet selalu membuka `https://`. Bila proyek lama punya `default_server` di port 80/443, permintaan ke nama lain tetap jatuh ke sana seperti sekarang.

### 7.4 SELinux (bila `Enforcing`)

```bash
dnf install -y policycoreutils-python-utils       # menyediakan semanage (install.sh memasangnya bila belum ada)
setsebool -P httpd_can_network_connect 1          # nginx boleh ke 127.0.0.1:3110 (mungkin sudah aktif untuk proyek lama)
semanage fcontext -a -t httpd_sys_content_t "/opt/m100/releases(/.*)?"
restorecon -R /opt/m100/releases
```

Ulangi `restorecon -R /opt/m100/releases/<versi>` setiap memasang rilis baru. Bila Nginx menjawab 403 padahal izin file benar: `ausearch -m avc -ts recent`.

### 7.5 Aktifkan

```bash
nginx -t && systemctl reload nginx
```

`nginx -t` wajib lulus sebelum `reload`; konfigurasi yang salah akan ikut menjatuhkan proyek lama saat restart berikutnya.

---

## 8. Konfigurasi `.env`

`/opt/m100/.env` (`0640 root:m100`, tidak pernah masuk git atau rilis):

```ini
NODE_ENV=production
TZ=Asia/Jakarta
PORT=3110
LOG_LEVEL=info

DATABASE_URL=postgres://m100_app:<sandi acak 1>@127.0.0.1:5432/m100
MIGRATE_DATABASE_URL=postgres://m100_migrate:<sandi acak 2>@127.0.0.1:5432/m100

PHOTO_STORE=disk
PHOTO_DIR=/opt/m100/photos
JWT_KEY_FILE=/opt/m100/secrets/jwt.key

PUBLIC_HOST=m100.qdms.web.id

BACKUP_DIR=/mnt/backup/m100
PG_BIN=/usr/pgsql-18/bin
```

- Sandi: `openssl rand -hex 24`. Hindari karakter yang perlu di-escape dalam URL.
- `ADMIN_DATABASE_URL` dan `REPORT_DB_PASSWORD` **tidak** ditulis ke `.env`; hanya diberikan lewat environment saat `db-bootstrap` (§9).
- `CF_API_TOKEN` tidak diperlukan di sini; token ada di `/etc/letsencrypt/cloudflare.ini`.
- API berhenti dan menyebut nama variabelnya bila ada yang kurang atau salah.

---

## 9. Database, layanan API, data awal

Semua dari `/opt/m100`.

### 9.1 Role dan database (sekali per server PostgreSQL)

```bash
cd /opt/m100
read -rs PGSUPER      # sandi superuser postgres
read -rs REPORTPW     # sandi m100_report
sudo -u m100 env \
  ADMIN_DATABASE_URL="postgres://postgres:${PGSUPER}@127.0.0.1:5432/postgres" \
  REPORT_DB_PASSWORD="${REPORTPW}" \
  node current/api/dist/cli/db-bootstrap.js
unset PGSUPER REPORTPW
```

Membuat role `m100_migrate`, `m100_app`, `m100_report` dengan sandi dari `.env`, dan database `m100` milik `m100_migrate`. Tidak menyentuh database proyek lama.

### 9.2 Migrasi skema

```bash
sudo -u m100 node current/api/dist/cli/db-migrate.js     # jalankan kedua kali: tidak ada yang diterapkan
```

### 9.3 Unit systemd

`/etc/systemd/system/m100-api.service`:

```ini
[Unit]
Description=PSI Inspection Report API (NestJS) on 127.0.0.1:3110
After=network-online.target postgresql-18.service
Requires=postgresql-18.service

[Service]
User=m100
Group=m100
WorkingDirectory=/opt/m100
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/m100/current/api/dist/main.js
Restart=on-failure
RestartSec=10
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/m100/photos

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now m100-api
curl -s http://127.0.0.1:3110/v1/health
journalctl -u m100-api -f          # log pino (JSON) masuk ke journald
```

Batasi ukuran journal di `/etc/systemd/journald.conf` (mis. `SystemMaxUse=1G`, `MaxRetentionSec=30day`).

### 9.4 Data awal (hanya instalasi baru, bukan migrasi §10)

```bash
cd /opt/m100
sudo -u m100 node current/api/dist/cli/admin-create.js --username admin        # sandi ≥ 10 karakter, diketik dua kali
sudo -u m100 node current/api/dist/cli/import-master.js --dir /root/master-data --dry-run
sudo -u m100 node current/api/dist/cli/import-master.js --dir /root/master-data
sudo -u m100 node current/api/dist/cli/device-add.js --label "Tablet F3-01"
```

Ekspor master data berisi nama orang: simpan di folder yang hanya bisa dibaca operator (pengguna `m100` perlu izin baca sementara), hapus setelah impor. Lembar QR dari `device-add --batch` berisi kunci: hapus setelah tablet disiapkan.

---

## 10. Migrasi dari server Windows (bila K1 = menggantikan produksi)

Server Windows sekarang menyimpan submission dan foto produksi. Submission tidak bisa diubah (BR-07), jadi yang dipindah adalah dump utuh, bukan impor ulang.

### 10.1 Persiapan (hari-hari sebelumnya)

1. §5–§9.3 selesai di server-qiplab dengan rilis **yang sama versinya** dengan yang berjalan di Windows (skema harus sama).
2. Sertifikat sudah terbit di server baru (§7.1).
3. Turunkan TTL record `A` `m100` di Cloudflare ke 60–120 detik, minimal sehari sebelumnya.
4. **Gladi:** pulihkan backup harian terbaru ke database percobaan di server-qiplab dan periksa hitungannya (langkah 10.2 butir 4–6 dengan nama database lain). Catat lamanya.
5. Uji dari tablet uji dengan menimpa DNS sementara (DNS lokal router) ke `10.3.12.3`.

### 10.2 Cutover (saat pergantian shift)

1. Minta semua PSI mengirim yang masih menunggu (penghitung di header 0). Yang belum terkirim tetap aman di tablet dan akan terkirim ke server baru.
2. Di Windows: hentikan `m100-api` (`Stop-Service m100-api`), supaya tidak ada submission baru setelah backup.
3. Di Windows: `m100.ps1 backup --kind pre-upgrade`. Catat folder backup dan `manifest.json`.
4. Salin ke server-qiplab: folder backup itu (`m100.dump`, `manifest.json`, `config\`) dan seluruh `BACKUP_DIR\photos\`. Periksa SHA-256 dump terhadap manifest setelah disalin.
5. Di server-qiplab, API berhenti (`systemctl stop m100-api`):
   - Salin `jwt.key` dari `config\secrets\` ke `/opt/m100/secrets/jwt.key` (izin seperti §5.4), supaya sesi tablet dan admin tetap sah.
   - Pulihkan dump ke database `m100` yang masih kosong (baru di-bootstrap, **belum** dimigrasi; bila sudah, hapus dan bootstrap ulang):
     ```bash
     sudo -u postgres /usr/pgsql-18/bin/pg_restore --exit-on-error -d m100 /root/migrasi/m100.dump
     ```
   - Salin foto ke `/opt/m100/photos/` dengan struktur kunci yang sama (`submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg`), lalu `chown -R m100:m100 /opt/m100/photos`.
   - `sudo -u m100 node current/api/dist/cli/db-migrate.js` (seharusnya tidak menerapkan apa pun).
6. Verifikasi sebelum membuka: jumlah baris `submissions` dan `submission_photos` sama dengan `manifest.json`; jumlah file foto sama; buka beberapa foto.
7. `systemctl start m100-api`, `curl -s http://127.0.0.1:3110/v1/health`.
8. Ubah record `A` `m100.qdms.web.id` di Cloudflare ke `10.3.12.3` (tetap **DNS only**, awan abu-abu). Bila router pabrik menimpa nama ini di DNS lokal (doc 03 §7.2.1 langkah 9), ubah di sana juga.
9. Uji §12. Server Windows **dibiarkan mati tetapi utuh** sampai masa pengamatan selesai.

Karena nama host dan `jwt.key` sama dan device key ada di database, tablet tidak perlu didaftarkan ulang.

### 10.3 Batal (rollback)

Kembalikan record `A` ke IP lama dan jalankan lagi `m100-api` di Windows. **Peringatan:** submission yang sudah diterima server baru tidak ada di server lama. Tablet menyimpan submission terkirim hanya 7 hari dan tidak mengirim ulang sendiri. Karena itu putuskan lanjut/batal pada langkah 9, sebelum shift mulai mengirim; setelah itu perbaiki maju di server baru.

---

## 11. Backup, uji restore, pemeliharaan

### 11.1 Backup malam

CLI backup yang sama dipakai (`pg_dump -Fc`, manifest, salinan foto, retensi 14 harian + 12 bulanan). `pg_dump` harus versi 18 (`PG_BIN`).

**PERLU DICEK sebelum mengandalkan backup:** `backup.js` menyalin `.env`, `secrets/` dan `caddy-data/` dari direktori kerja. Di Linux `caddy-data/` tidak ada. Jalankan sekali dengan tangan dan lihat hasilnya; bila gagal karena itu, perbaiki kodenya (§3 butir 4) dan jangan mengakali dengan folder kosong di produksi tanpa mencatatnya.

`/etc/systemd/system/m100-backup.service`:

```ini
[Unit]
Description=M100 nightly backup
After=postgresql-18.service

[Service]
Type=oneshot
User=root
WorkingDirectory=/opt/m100
ExecStart=/usr/bin/node /opt/m100/current/api/dist/cli/backup.js
```

Dijalankan sebagai `root` karena harus membaca `.env` dan `secrets/` serta menulis ke `BACKUP_DIR`. Folder backup: `0700 root:root`.

`/etc/systemd/system/m100-backup.timer`:

```ini
[Unit]
Description=M100 nightly backup at 01:00 WIB

[Timer]
OnCalendar=*-*-* 01:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload && systemctl enable --now m100-backup.timer
systemctl start m100-backup.service && journalctl -u m100-backup -n 50     # uji sekarang
```

Tambahan di luar CLI: cadangkan `/etc/letsencrypt/` (terutama `cloudflare.ini`), `/etc/nginx/conf.d/m100.conf`, `/etc/nginx/snippets/m100-headers.conf` dan unit systemd. Kegagalan `m100-backup.service` harus terlihat oleh operator (mis. `OnFailure=` ke unit pemberitahuan, atau pemantauan `systemctl is-failed`).

### 11.2 Uji restore (awal, lalu tiap kuartal)

```bash
cd /opt/m100
env ADMIN_DATABASE_URL="postgres://postgres:<sandi>@127.0.0.1:5432/postgres" \
  node current/api/dist/cli/backup-restore.js --from /mnt/backup/m100/daily/<folder> --database m100_restore_test
```

Memulihkan ke database baru, membandingkan hitungan dan file foto dengan manifest, lalu menghapus database itu. Backup yang belum pernah dipulihkan bukan backup.

### 11.3 Mingguan

```bash
sudo -u m100 node current/api/dist/cli/sweep-photos.js --dry-run     # lihat dulu
sudo -u m100 node current/api/dist/cli/sweep-photos.js
```

### 11.4 Upgrade rilis

Pada pergantian shift:

1. Backup dulu, tunggu selesai: `cd /opt/m100 && node current/api/dist/cli/backup.js --kind pre-upgrade` (sebagai `root`).
2. Bongkar rilis baru ke `/opt/m100/releases/<versi baru>`, izin dan `restorecon` seperti §6 dan §7.4.
3. `cd /opt/m100 && sudo -u m100 node releases/<versi baru>/api/dist/cli/db-migrate.js`
4. `readlink current > previous-release.txt; ln -sfn releases/<versi baru> current; systemctl restart m100-api`
5. `curl -s https://m100.qdms.web.id/v1/health`. Bila tidak sehat dalam 60 detik: arahkan `current` kembali ke rilis sebelumnya dan restart. **Migrasi yang satu arah (seperti 0006) tidak bisa dibatalkan dengan cara ini**; baca catatan rilisnya dulu.
6. Simpan 5 rilis terakhir, hapus yang lebih lama.

Nginx tidak perlu di-reload: ia mengikuti symlink `current`. Permintaan yang sedang berjalan gagal dan tablet mengirim ulang (aman, BR-06).

---

## 12. Pemeriksaan setelah deploy

| # | Pemeriksaan | Harus |
|---|---|---|
| V1 | `ss -ltnp` | API hanya di `127.0.0.1:3110`; PostgreSQL hanya di `127.0.0.1`; proyek lama masih di port 3000 |
| V2 | Proyek lama dibuka dari browser | Berjalan seperti sebelumnya |
| V3 | `nslookup m100.qdms.web.id` dari Wi-Fi pabrik | `10.3.12.3` |
| V4 | `curl -s https://m100.qdms.web.id/v1/health` | 200, sertifikat Let's Encrypt, tanpa peringatan |
| V5 | `curl -sI https://m100.qdms.web.id/` dan `/assets/<file>` dan `/sw.js` | CSP, `nosniff`, `no-referrer` ada di semuanya; `no-cache` untuk `/` dan `/sw.js`; `immutable` untuk `/assets/` |
| V6 | `curl -s -H "X-Device-Key: <kunci tablet uji>" https://m100.qdms.web.id/v1/system/status` | Semua readiness check OK (`DB`, `PHOTO_STORE`) |
| V7 | `https://m100.qdms.web.id/admin/` login, muat ulang halaman | Aplikasi admin, bukan aplikasi tablet |
| V8 | Tablet uji: login, PO dengan temuan; PSI lv.2 dengan foto; Wi-Fi mati → SUBMIT PO → Wi-Fi hidup | Tepat satu submission di server; outbox kosong; foto tersimpan di `/opt/m100/photos/submissions/…` |
| V9 | Submission besar (banyak foto) | Tidak ada `413` dari Nginx |
| V10 | `systemctl restart m100-api`; lalu reboot server pada jendela yang disepakati | API sehat lagi sendiri; urutan PostgreSQL → API benar |
| V11 | Pagi berikutnya: `systemctl list-timers m100-backup.timer`, folder baru di `BACKUP_DIR/daily` | Backup ada, tidak `*.partial` |
| V12 | `certbot renew --dry-run` | Berhasil |

Catat hasil tiap baris di `docs/phase5-integration-review.md`.

---

## 13. Gangguan yang mungkin muncul

| Gejala | Kemungkinan sebab |
|---|---|
| `502 Bad Gateway` di `/v1/` | API mati (`systemctl status m100-api`), `PORT` di `.env` tidak sama dengan `upstream`, atau SELinux menolak (`httpd_can_network_connect`) |
| `403` untuk file statis | Izin folder (`/opt/m100` harus `o+x`), atau konteks SELinux belum di-`restorecon` |
| `413 Request Entity Too Large` | `client_max_body_size` tidak berlaku (salah `server` block yang menangkap permintaan) |
| Membuka `m100.qdms.web.id` menampilkan proyek lama | `server_name` tidak cocok atau `conf.d/m100.conf` tidak dimuat (`nginx -T \| grep m100`) |
| API berhenti saat start dan menyebut nama variabel | `.env` kurang/salah, atau `jwt.key` < 32 byte / tidak terbaca pengguna `m100` |
| Tablet menampilkan "Tablet ini belum terdaftar" setelah cutover | Origin berubah (nama host lain), atau database tidak dipulihkan dari server lama |
| Semua tablet harus login ulang | `jwt.key` baru, bukan salinan dari server lama |
| Admin terkena `429` | `X-Forwarded-For` tidak diteruskan, sehingga semua klien terhitung satu IP |
| `pg_dump: server version mismatch` | `PG_BIN` menunjuk versi selain 18 |
| Tablet tidak bisa membuka nama host, laptop bisa | Perlindungan DNS rebind di router; tambahkan nama ke DNS lokal (doc 03 §7.2.1 langkah 9) |

---

## 14. Urutan kerja

1. Jawab K1–K9 (§2). Berhenti bila CentOS 7.
2. Tulis dan setujui ADR-023; jadwalkan tugas §3.
3. Siapkan server (§5), sertifikat (§7.1).
4. Bangun dan pasang rilis (§6), `.env` (§8), database dan layanan (§9.1–9.3), Nginx (§7.2–7.5).
5. Periksa V1, V2, V4–V7 dengan DNS yang ditimpa sementara.
6. Backup dan uji restore (§11.1–11.2).
7. Gladi migrasi, lalu cutover (§10) **atau** data awal (§9.4).
8. Periksa V3, V8–V12; amati satu minggu sebelum server Windows dibongkar.
