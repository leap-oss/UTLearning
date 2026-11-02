# UT AI Learning Companion

Aplikasi pendamping belajar mandiri untuk modul **Buku Materi Pokok (BMP) Universitas Terbuka** berbasis Express.js, Alpine.js, Drizzle ORM (Neon Postgres), dan Google Gemini API (`@google/genai`).

## Fitur Utama

1. **Manajemen Mata Kuliah & Modul Fleksibel**:
   - Mendukung berbagai mata kuliah UT dengan jumlah modul fleksibel (default 9 modul, dapat ditambah/diubah sesuai BMP) tanpa urutan belajar yang dikunci.
2. **Ekstraksi Halaman BMP Terverifikasi (1 Batch Request)**:
   - Unggah foto halaman Rangkuman, Tes Formatif, atau Materi BMP (`JPEG`, `PNG`, `WebP`) sekaligus, periksa hasil bacaan OCR terstruktur, dan koreksi teks sebelum digunakan sebagai dasar rangkuman.
3. **Study Pack & Kuis Awal (Batch Synthesis)**:
   - Menyusun ringkasan per topik, istilah penting BMP, penjelasan/analogi pendamping AI (dipisahkan secara visual dari kutipan materi BMP), serta 5–10 soal latihan awal hanya dalam **1 permintaan AI**.
4. **Penilaian Lokal di Server (0 Pemanggilan AI)**:
   - Kunci jawaban disembunyikan dari respons klien selama pengerjaan kuis dan dinilai secara transaksional di server tanpa memanggil API Gemini.
5. **Diagnostik Kesalahan & Paket Soal Remedial Terfokus**:
   - Menganalisis pola miskonsepsi dari jawaban yang salah dan menyusun soal remedial terfokus dalam 1 permintaan batch.
6. **Simulasi Ujian Komprehensif Lintas Modul**:
   - Menggabungkan ringkasan Study Pack terverifikasi dari minimal 2 modul untuk latihan evaluasi kesiapan ujian mandiri.

---

## Persiapan Lokal

1. Masuk ke direktori proyek dan instal dependensi:
   ```bash
   cd ut-learning
   npm install
   ```

2. Salin `.env.example` menjadi `.env` dan isi kredensial Neon Postgres serta Gemini API Key:
   ```bash
   cp .env.example .env
   ```

3. Jalankan migrasi skema database ke Neon Postgres:
   ```bash
   npm run db:migrate
   ```

4. Jalankan server pengembangan:
   ```bash
   npm run dev
   ```
   Buka `http://127.0.0.1:3000` di browser.

---

## Deploy ke Vercel

Proyek ini telah dilengkapi konfigurasi Serverless Function (`api/index.js` dan `vercel.json`):

1. Push folder `ut-learning` ke repositori GitHub Anda (atau atur **Root Directory** di Vercel ke `ut-learning`).
2. Di dashboard Vercel (**Settings → Environment Variables**), tambahkan variabel berikut:
   - `DATABASE_URL` (atau `DIRECT_URL`): Connection string Neon Postgres Anda.
   - `GEMINI_API_KEY`: API key dari Google AI Studio.
   - `GEMINI_MODEL`: `gemini-3.5-flash`
   - `GEMINI_THINKING_LEVEL`: `low`
3. Klik **Deploy**. File statis di `public/` akan disajikan langsung oleh CDN Vercel dan seluruh endpoint `/api/*` dijalankan melalui `api/index.js`.
