# POS CRDT — Local-First Point of Sale

> **Implementasi Paradigma Local-First Software Menggunakan Automerge CRDT untuk Resolusi Konflik Konkurensi pada POS Terdesentralisasi**

Penelitian: Dimas Rizqia Hidayat — UIN Sunan Gunung Djati Bandung, 2026

---

## Arsitektur

```
Hybrid Decentralized · Offline-First · Strong Eventual Consistency
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 POS Node (Electron)     Bootstrap Relay        POS Node (Electron)
 ├─ React UI             (peer discovery only)   ├─ React UI
 ├─ SQLite (local)  ←──── ws://localhost:9000 ────→ ├─ SQLite (local)
 ├─ Automerge CRDT       (NO business data)      ├─ Automerge CRDT
 └─ Sync Engine ←────── direct WebSocket sync ──→ └─ Sync Engine
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start bootstrap relay (terminal 1)
npm run relay

# 3. Start Electron POS node (terminal 2)
RELAY_URL=ws://localhost:9000 LISTEN_PORT=8080 npm run electron

# 4. Start second node (terminal 3)
RELAY_URL=ws://localhost:9000 LISTEN_PORT=8081 npm run electron

# 5. Run demo (3-node simulation)
npm run demo

# 6. Run evaluation metrics
npm run eval

# 7. Run all tests (300 test cases)
npm test
```

## Tech Stack

| Layer | Teknologi |
|---|---|
| Desktop Client | Electron + React |
| UI State | useState / hooks |
| Local Persistence | sql.js (SQLite) |
| CRDT Engine | Automerge v2 |
| Sync Transport | WebSocket (ws) |
| Node Identity | UUID v4 |
| Causality Tracking | Vector Clock |

## Struktur Proyek

```
pos-crdt/
├── electron/
│   ├── main.js                  ← Electron entry point
│   ├── preload.js               ← IPC bridge (contextBridge)
│   ├── identity.js              ← UUID v4 node identity
│   ├── pos-service.js           ← Business logic coordinator
│   ├── db/
│   │   └── index.js             ← SQLite (sql.js) + schema migrations
│   ├── crdt/
│   │   ├── doc-manager.js       ← Automerge doc CRUD
│   │   ├── inventory-projection.js ← Stock = Σ(op deltas)
│   │   ├── vector-clock.js      ← Causal ordering
│   │   └── merge-verifier.js    ← SHA-256 convergence proof
│   ├── sync/
│   │   ├── protocol.js          ← WebSocket message builders
│   │   └── sync-engine.js       ← Peer discovery + CRDT sync
│   ├── pos/
│   │   ├── auth.js              ← PIN auth + RBAC
│   │   ├── cart.js              ← Ephemeral cart
│   │   ├── reports.js           ← Daily reports (projection)
│   │   └── pos-facade.js        ← Single entry point facade
│   ├── recovery/
│   │   └── recovery-manager.js  ← WAL + crash recovery
│   └── ipc/
│       └── handlers.js          ← IPC handler registration
├── relay/
│   └── server.js                ← Bootstrap relay (peer discovery)
├── src/
│   ├── main.jsx                 ← React entry point
│   ├── App.jsx                  ← Full POS UI (4 screens)
│   └── index.css                ← Dark professional theme
├── demo/
│   ├── run-demo.js              ← 3-node scenario demo
│   └── evaluation.js            ← Formal metrics collector
├── tests/
│   ├── run.js                   ← Phase 3: 72 tests
│   ├── sync.test.js             ← Phase 4: 42 tests
│   ├── conflict.test.js         ← Phase 5: 65 tests
│   └── phase6.test.js           ← Phase 6: 121 tests
├── index.html
├── vite.config.js
└── package.json
```

## Test Coverage

| Phase | Komponen | Tests |
|---|---|---|
| P3 | DB + CRDT + Identity + PosService | 72 ✅ |
| P4 | Relay + SyncEngine + Protocol | 42 ✅ |
| P5 | Conflict Simulation + MergeVerifier | 65 ✅ |
| P6 | Recovery + Auth + Cart + Reports | 121 ✅ |
| **Total** | **14 modules** | **300 ✅** |

## Data Architecture

```
GLOBAL SHARED STATE (CRDT-synced):
  products      → Automerge.Map (LWW per field)
  transactions  → Automerge.List (append-only, add-wins)
  users         → Automerge.Map (LWW per field)
  inventory     → PROJECTION dari operation_logs (commutative)
  operation_logs → Append-only SQLite (immutable source of truth)
  sync_metadata → Per-peer sync state

LOCAL DEVICE STATE (not synced):
  UI State      → React useState
  Session       → Memory only
  device_config → SQLite (node_id, settings)
```

## CAP Theorem Position

```
System = AP (Available + Partition Tolerant)
Consistency = Strong Eventual Consistency (SEC)
Reason: POS UMKM prioritizes availability over strict consistency.
        CRDT guarantees convergence after partition heals.
```