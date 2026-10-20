# Lensa Privasi

Demo satu transaksi yang sama dilihat dari tiap pihak (BI, bank pengirim, bank penerima, bank lain) di tiga model privasi: Zeto, Noto, Stealth. Ada juga stress test TPS yang membandingkan ketiganya.

Server di port 8790 (`PORT` mengganti). Port 8791 dipakai server mock untuk Playwright. Port 8787 sudah dipakai di host ini.

## Prasyarat

- Port-forward Paladin aktif: node1..4 di `127.0.0.1:31548`, `:31648`, `:31748`, `:31848`. Skripnya `besu/noto+pente/scripts/port-forward-start.sh` (atau `alibaba-kube/Paladin/scripts/port-forward-start.sh` di host demo).
- Tunnel Besu RPC ke `127.0.0.1:8545`:

  ```bash
  KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml kubectl port-forward svc/besu-node-validator-1 8545:8545 -n besu
  ```

- Stealth butuh `besu/stealth-address/.env.smoke`.

## Instalasi

```bash
cd besu/lensa-privasi && npm install
cd ../stealth-address && npm install
cd ../zeto && npm install
cd ../noto+pente/common && npm ci
cd ../bond && npm ci
```

Adapter Noto mengimpor `noto+pente/bond/src/lib`, jadi `bond` butuh `node_modules` sendiri.

## Bootstrap (sekali, urutan ini)

```bash
npm run bootstrap -- stealth
npm run bootstrap -- noto
npm run bootstrap -- zeto
```

State ditulis ke `server/state/` (git-ignored). Catatan:

- Noto menolak bootstrap ulang tanpa `--force`, supaya deployment yang sudah ada tidak tertimpa.
- Zeto tidak pernah memanggil `setERC20`. Itu transaksi PUBLIC ke kontrak Zeto dan bisa membuat node Paladin crash (lihat bagian Node Paladin restart).

## Sebelum meeting

```bash
npm run preflight -- --prepare 500
npm run preflight -- --prepare 200 --only stealth   # Besu saja, tidak menyentuh node Paladin
npm run preflight
```

Perintah pertama menyiapkan kapasitas stress test (500 tx per model). Setelah `--prepare`, restart server supaya state kolam yang baru terbaca. Perintah kedua mengecek Besu, 4 node Paladin, dan kapasitas, tanpa mengubah apa pun.

## Menjalankan

```bash
npm run build && npm start
```

Buka `http://localhost:8790`. Dari laptop: `ssh -L 8790:localhost:8790 <host>`, lalu buka `http://localhost:8790`.

## Tes

```bash
npm test                      # unit test, tanpa chain
npm run e2e -w web            # smoke Playwright dengan adapter palsu (port 8791)
npm run test:live -w server -- test/live/zeto.live.ts
npm run test:live -w server -- test/live/noto.live.ts
npm run test:live -w server -- test/live/stealth.live.ts
```

Tes live Paladin (zeto, noto) jalan di bawah lock supaya tidak bertabrakan:

```bash
flock /tmp/lensa-paladin.lock npm run test:live -w server -- test/live/zeto.live.ts
```

## Node Paladin restart

Kalau node Paladin crash-loop atau restart (exit 137 saat proving, atau panic `IsNil`), penyebabnya biasanya transaksi tanpa receipt. Cara membersihkannya ada di `besu/zeto/README.md`, bagian "Poison-pill bug". Jangan hapus apa pun otomatis, jangan restart pod atau hapus transaksi tanpa persetujuan. Minta persetujuan pengguna dulu.

## Batasan yang diketahui

- Nominal Stealth publik di chain; yang tersembunyi hanya pihaknya.
- Zeto dengan lebih dari 2 pengirim paralel berisiko membuat node restart (bukti ZK dibangun di CPU node).
- Zeto punya batas yang sama dengan Noto: satu panggilan Paladin yang menggantung membuat bank itu terkunci (dan satu dari 2 slot Zeto) sampai server di-restart.
- Langkah 0 dan 1 berbagi satu durasi bila SDK tidak menyediakan batas di antaranya.
- Angka diukur di cluster demo, bukan kapasitas produksi.
