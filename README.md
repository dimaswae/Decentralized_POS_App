# POS CRDT — Local‑First Point of Sale

Implementasi lokal‑pertama (local‑first) untuk Point‑of‑Sale terdesentralisasi menggunakan Automerge CRDT untuk resolusi konflik.

Penelitian: Dimas Rizqia Hidayat — UIN Sunan Gunung Djati Bandung (2026)

---

## Table of contents

- [Arsitektur](#arsitektur)
- [Quick Start](#quick-start)
- [Tech Stack](#tech-stack)
- [Struktur Proyek](#struktur-proyek)
- [Test Coverage](#test-coverage)
- [Data Architecture](#data-architecture)
- [CAP Theorem Position](#cap-theorem-position)

## Arsitektur

Hybrid Decentralized · Offline‑First · Strong Eventual Consistency

```
POS Node (Electron)     Bootstrap Relay        POS Node (Electron)
├─ React UI             (peer discovery only)   ├─ React UI
├─ SQLite (local)  ←──── ws://localhost:9000 ────→ ├─ SQLite (local)
├─ Automerge CRDT       (no business data)      ├─ Automerge CRDT
└─ Sync Engine ←────── direct WebSocket sync ──→ └─ Sync Engine
```

Keterangan: relay hanya untuk discovery/bootstrapping; data business tetap peer‑to‑peer dan disimpan lokal.

## Quick Start

Prasyarat: Node.js + npm

1. Install dependencies

```bash
npm install
```

2. Jalankan bootstrap relay (terminal 1)

```bash
npm run relay
```

3. Jalankan node Electron (terminal 2)

Windows (PowerShell):

```powershell
$env:RELAY_URL = 'ws://localhost:9000'; $env:LISTEN_PORT = '8080'; npm run electron
```

macOS / Linux (bash):

```bash
RELAY_URL=ws://localhost:9000 LISTEN_PORT=8080 npm run electron
```

4. Jalankan node kedua (terminal 3)

```bash
RELAY_URL=ws://localhost:9000 LISTEN_PORT=8081 npm run electron
```

5. Demo 3‑node simulation

```bash
npm run demo
```

6. Evaluasi dan metrik

```bash
npm run eval
```

7. Jalankan semua test (300 test cases)

```bash
npm test
```

## Tech Stack

| Layer              | Teknologi        |
| ------------------ | ---------------- |
| Desktop Client     | Electron + React |
| UI State           | React hooks      |
| Local Persistence  | sql.js (SQLite)  |
| CRDT Engine        | Automerge v2     |
| Sync Transport     | WebSocket (ws)   |
| Node Identity      | UUID v4          |
| Causality Tracking | Vector Clock     |

## Struktur Proyek

```
.
├── electron/                 # Electron app + backend logic
│   ├── main.js               # Electron entry point
│   ├── preload.js            # IPC bridge (contextBridge)
│   ├── identity.js           # Node identity (UUID v4)
│   ├── pos-service.js        # Business logic coordinator
│   ├── db/index.js           # sql.js (SQLite) + migrations
│   ├── crdt/                 # Automerge helpers + verification
│   ├── sync/                 # Protocols and sync engine
│   ├── pos/                  # POS domain (auth, cart, reports)
│   └── recovery/             # WAL + crash recovery
├── relay/                    # Bootstrap relay (peer discovery)
│   └── server.js
├── src/                      # React UI (renderer)
├── demo/                     # Scenario runner + evaluation
├── tests/                    # Automated tests (300 cases)
├── index.html
├── vite.config.js
└── package.json
```

Untuk detail file, lihat folder `electron/`, `relay/`, `src/`, dan `tests/`.

## Test Coverage

| Phase     | Komponen                           | Tests   |
| --------- | ---------------------------------- | ------- |
| P3        | DB, CRDT, Identity, PosService     | 72      |
| P4        | Relay, SyncEngine, Protocol        | 42      |
| P5        | Conflict Simulation, MergeVerifier | 65      |
| P6        | Recovery, Auth, Cart, Reports      | 121     |
| **Total** | **14 modules**                     | **300** |

## Data Architecture

GLOBAL SHARED STATE (CRDT‑synced):

- `products` → Automerge.Map (LWW per field)
- `transactions` → Automerge.List (append‑only, add‑wins)
- `users` → Automerge.Map (LWW per field)
- `inventory` → Projection dari `operation_logs` (commutative)
- `operation_logs` → Append‑only SQLite (immutable source of truth)
- `sync_metadata` → Per‑peer sync state

LOCAL DEVICE STATE (tidak disinkronkan):

- UI State → React useState
- Session → Memory only
- device_config → SQLite (node_id, settings)

## CAP Theorem Position

System = AP (Available + Partition Tolerant)

Consistency = Strong Eventual Consistency (SEC)

Alasan: sistem POS ini memprioritaskan ketersediaan selama partisi; CRDT (Automerge) menjamin konvergensi setelah partisi pulih.

---

Jika Anda ingin, saya bisa:

- Menambahkan badge status (build / tests)
- Menambahkan instruksi debugging / dev (dev server, electron build)
- Menyertakan link ke file penting seperti `electron/pos-service.js` atau test summary

Beritahu saya opsi mana yang mau ditambahkan.
