# Panduan pembayaran langganan lewat iPaymu

Dengan panduan ini pelanggan Rupiah cukup menekan **Bayar**, lalu membayar di halaman iPaymu (QRIS, virtual account bank, atau e-wallet). Begitu lunas, paketnya aktif otomatis. Pelanggan Ringgit tetap memakai DuitNow manual seperti sekarang.

Semua langkah bisa dikerjakan dari HP. Kalau tampilan sebuah dashboard terlalu sempit, buka menu browser dan pilih **Situs desktop**.

## Cara kerjanya

```
Aplikasi (GitHub Pages) ──Bayar──► Cloudflare Worker ──buat transaksi──► iPaymu
                                        ▲                                  │
                                        │◄──── callback + cek ulang ───────┘
                                        │
                                        └──── tulis paket aktif ────► Firestore
```

- **API Key iPaymu dan kunci service account Firebase hanya ada di Secret Cloudflare.** Kode web tidak menyimpan keduanya.
- Harga diambil Worker dari Firestore (`zconfig/pay`, yang diatur di **Admin langganan → Harga & QRIS**), bukan dari HP pelanggan.
- Setiap callback iPaymu tidak langsung dipercaya. Worker selalu mengecek ulang status transaksi ke iPaymu sebelum mengaktifkan paket.
- Masa aktif ditambahkan dari tanggal berakhir paket yang sekarang, atau dari hari ini kalau paketnya sudah lewat. Cara hitungnya sama dengan tombol **Aktifkan** di Admin langganan.
- Langganan tidak diperpanjang otomatis.

Biayanya gratis: Cloudflare Workers gratis sampai 100.000 permintaan per hari, dan Firebase tetap memakai paket Spark.

---

## A. Siapkan akun iPaymu Sandbox

1. Buka **https://sandbox.ipaymu.com** lalu daftar atau masuk. Sandbox adalah akun uji coba yang terpisah dari akun asli (Live).
2. Cari halaman **API Key / Integrasi** (biasanya ada di menu **Pengaturan** atau di profil akun).
3. Catat dua nilai:
   - **VA**, nomor panjang yang biasanya diawali `0000`,
   - **API Key**, teks panjang.

Jangan kirim kedua nilai ini lewat chat atau email. Nanti langsung ditempel di Cloudflare (langkah D).

## B. Buat kunci service account Firebase

Kunci ini memberi Worker izin menulis status paket ke Firestore.

1. Buka **https://console.firebase.google.com** → pilih project **kontraktor-zui**.
2. Tekan ikon roda gigi → **Project settings** → tab **Service accounts**.
3. Tekan **Generate new private key** → **Generate key**. HP akan mengunduh file `.json`.
4. Buka file itu dengan aplikasi editor teks (misalnya Files/File Manager → Buka dengan → editor teks), lalu **salin seluruh isinya**, dari `{` pertama sampai `}` terakhir. Ini dipakai di langkah D.
5. Setelah ditempel di Cloudflare, **hapus file `.json` itu dari HP** (juga dari folder Download dan sampah).

> Kunci ini setara kunci utama database. Jangan diunggah ke GitHub, jangan dikirim lewat chat. Kalau tersebar, buka lagi tab **Service accounts** → **Manage service account permissions**, hapus kuncinya, lalu buat yang baru.

## C. Buat Worker di Cloudflare

1. Buka **https://dash.cloudflare.com** lalu daftar atau masuk (akun gratis cukup).
2. Menu **Workers & Pages** (di menu ☰ kalau dari HP) → **Create** → **Create Worker** (template **Hello World**).
3. Beri nama **`zui-bayar`** → **Deploy**.
4. Catat alamat Worker yang muncul, misalnya `https://zui-bayar.namamu.workers.dev`.
5. Tekan **Edit code**. Hapus semua isi editor.
6. Buka file **`worker/zui-bayar.js`** dari repo ini. Paling mudah dari HP: buka file itu di GitHub, tekan **Raw**, pilih semua teks, lalu salin.
7. Tempel ke editor Cloudflare → **Deploy**.

## D. Isi Secret dan pengaturan Worker

Di halaman Worker `zui-bayar` → **Settings** → **Variables and Secrets** → **Add**. Isi satu per satu:

| Nama | Tipe | Isi |
|---|---|---|
| `IPAYMU_VA` | **Secret** | VA iPaymu dari langkah A |
| `IPAYMU_KEY` | **Secret** | API Key iPaymu dari langkah A |
| `FIREBASE_SA` | **Secret** | seluruh isi file `.json` dari langkah B |
| `IPAYMU_MODE` | Text | `sandbox` |
| `APP_URL` | Text | `https://kontraktor.zuisystem.com/` |
| `TEST_EMAILS` | Text | email akunmu untuk uji coba, misalnya `admin.zuisystem@gmail.com` (beberapa email dipisah koma) |
| `ADMIN_EMAILS` | Text | `admin.zuisystem@gmail.com` (samakan dengan `superAdmins` di `config.js`) |

Tekan **Deploy** atau **Save and deploy** setelah semuanya terisi.

Cek: buka alamat Worker di browser. Harus muncul tulisan **`ZUI bayar aktif · mode sandbox`**.

Catatan:
- Selama `IPAYMU_MODE` = `sandbox`, Worker hanya melayani email di `TEST_EMAILS`. Pelanggan lain tidak bisa membuat pembayaran uji coba yang mengaktifkan paket asli.
- Kalau aplikasi juga dibuka dari alamat lain (misalnya `namamu.github.io`), tambahkan variabel Text `EXTRA_ORIGINS` berisi `https://namamu.github.io`.

## E. Perbarui Firestore Rules

Rules ini mencegah pelanggan mengubah sendiri paket dan tanggal berakhir perusahaannya.

1. Firebase Console → **Firestore Database** → tab **Rules**.
2. **Salin dulu seluruh isi rules yang sekarang** ke catatan sebagai cadangan.
3. Buka file **`worker/firestore-rules-langganan.txt`** di repo ini dan ikuti empat bagiannya: tempel dua fungsi baru, lalu tambahkan syarat pada aturan `companies`, `subreqs`, dan `zconfig` yang sudah ada.
4. Tekan **Publish**. Kalau muncul tanda error merah, baca nomor barisnya. Biasanya ada kurung `)` atau `&&` yang kurang. Kalau ragu, kembalikan rules dari cadangan di langkah 2 lalu kirimkan isi rules lama ke saya untuk digabungkan.

Cek setelah publish: buka aplikasi sebagai pemilik perusahaan biasa. Aplikasi harus berjalan seperti biasa (proyek, invoice, chat, halaman klien dan pekerja). Admin langganan tetap bisa menekan **Atur** dan **Aktifkan**.

## F. Isi URL callback di iPaymu

Worker sudah mengirim alamat callback di setiap transaksi, tapi isi juga di dashboard sebagai cadangan:

1. Di dashboard iPaymu (Sandbox dulu), buka halaman **API Key / Integrasi** atau **Pengaturan**.
2. Cari kolom **URL Notifikasi / Notify URL / Callback URL**, lalu isi:
   `https://zui-bayar.namamu.workers.dev/notify`
3. Kalau ada kolom **Return URL / URL Kembali**, isi `https://kontraktor.zuisystem.com/`.
4. Simpan.

## G. Sambungkan aplikasi

Di file **`config.js`** (lewat GitHub → file → ikon pensil):

```js
payGateway: "https://zui-bayar.namamu.workers.dev",
payGatewayTesters: ["admin.zuisystem@gmail.com"],
```

- `payGateway`: alamat Worker dari langkah C.4.
- `payGatewayTesters`: selama uji coba, hanya email ini yang melihat tombol **Bayar** iPaymu. Pelanggan lain tetap memakai QRIS manual seperti sekarang, jadi tidak ada yang terganggu.

Commit perubahan, lalu tunggu 1–2 menit sampai GitHub Pages diperbarui. Tutup dan buka ulang aplikasi supaya versi baru termuat.

## H. Uji di Sandbox

Masuk dengan akun yang ada di `TEST_EMAILS` dan `payGatewayTesters`, di perusahaan yang **bukan** "Gratis selamanya" dan memakai mata uang Rupiah.

1. Buka **Upgrade / Langganan** → pilih **Starter**, **1 bulan** → **Pilih Starter** → **Bayar Rp79.000**.
2. Halaman iPaymu Sandbox terbuka. Pilih salah satu metode (QRIS, VA bank, atau e-wallet).
3. Selesaikan pembayaran simulasi. Di Sandbox tidak ada uang sungguhan. Ikuti petunjuk di halaman sandbox (biasanya ada tombol atau halaman simulasi bayar). Kalau tidak ada, buka dashboard sandbox iPaymu → **Transaksi** dan cari cara menandai transaksi lunas.
4. Kembali ke aplikasi. Muncul **"Pembayaran berhasil"** dan paket **Starter** aktif. Kalau yang muncul "Menunggu pembayaran", tunggu 1–2 menit lalu buka ulang halaman Langganan, karena callback iPaymu kadang datang sedikit terlambat.
5. Cek di **Admin langganan → Permintaan**: ada baris `iPaymu (sandbox)` dengan nomor trx dan status **Aktif**.
6. Uji juga:
   - **Batal**: buka pembayaran baru lalu tekan batal/kembali di halaman iPaymu. Paket tidak berubah, dan riwayat menampilkan **Lanjutkan bayar**.
   - **Perpanjang**: bayar lagi paket yang sama. Tanggal berakhir bertambah dari tanggal berakhir sebelumnya, bukan dari hari ini.
   - **Cek iPaymu** di Admin langganan untuk baris yang belum dibayar.
7. Kembalikan perusahaan uji coba ke status yang benar lewat **Admin langganan → Perusahaan → Atur**.

Kalau ada error, lihat catatan Worker: Cloudflare → Worker `zui-bayar` → **Logs** (atau **Observability**) → **Begin log stream**, lalu ulangi langkah yang gagal.

## I. Pindah ke Live (uang sungguhan)

1. Pastikan akun iPaymu **Live** (https://my.ipaymu.com) sudah terverifikasi, lalu ambil **VA** dan **API Key** Live-nya.
2. Cloudflare → Worker `zui-bayar` → **Settings → Variables and Secrets**:
   - ubah `IPAYMU_VA` dan `IPAYMU_KEY` ke nilai Live,
   - ubah `IPAYMU_MODE` menjadi `live`,
   - lalu **Deploy**. Buka alamat Worker; tulisannya harus **`mode live`**.
3. Isi URL callback yang sama (langkah F) di dashboard iPaymu **Live**.
4. Lakukan satu pembayaran asli kecil (Starter 1 bulan) dengan akun penguji. Pastikan paket aktif otomatis.
5. Buka semua untuk pelanggan: di `config.js` ubah menjadi `payGatewayTesters: [],` lalu commit.

Untuk kembali ke Sandbox, ganti lagi ketiga nilai di langkah I.2.

## Kalau ada masalah

- **Matikan pembayaran online sementara**: di `config.js` isi `payGateway: ""`. Pelanggan Rupiah kembali ke QRIS manual (gambar QRIS di **Admin langganan → Harga & QRIS**).
- **Pelanggan sudah bayar tapi paket belum aktif**: di **Admin langganan → Permintaan**, tekan **Cek iPaymu** pada baris itu. Kalau masih belum, cocokkan dengan dashboard iPaymu lalu tekan **Aktifkan manual**, atau atur langsung di tab **Perusahaan → Atur**. Tombol manual ini tetap berfungsi seperti dulu.
- **Ganti harga**: ubah di **Admin langganan → Harga & QRIS**. Worker otomatis memakai harga Rupiah yang baru untuk pembayaran berikutnya.
- **Kunci tersebar**: buat API Key baru di iPaymu atau kunci service account baru di Firebase, lalu ganti Secret-nya di Cloudflare. Kunci lama di Firebase dihapus dari tab Service accounts.
