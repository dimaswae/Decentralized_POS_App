/**
 * electron/db/index.js
 * Database Manager — sql.js wrapper
 *
 * Tanggung jawab:
 *  - Inisialisasi SQLite database (sql.js)
 *  - Menjalankan schema migrations
 *  - Menyediakan CRUD methods untuk semua tabel
 *  - Persist database ke disk (file-based via Buffer)
 *
 * Tabel yang dikelola:
 *  SHARED (synced):
 *    - automerge_docs   → CRDT binary blob per entitas
 *    - operation_logs   → immutable op log (source of truth)
 *    - sync_metadata    → state sync per peer
 *
 *  LOCAL (not synced):
 *    - device_config    → konfigurasi node lokal
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Schema version ───────────────────────────────────────────────
const SCHEMA_VERSION = 1;

// ─── Migration: create all tables ────────────────────────────────
const MIGRATIONS = [
  // Migration v1
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version   INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

  -- ① Automerge CRDT document store
  CREATE TABLE IF NOT EXISTS automerge_docs (
    doc_id      TEXT PRIMARY KEY,
    doc_binary  BLOB NOT NULL,
    heads       TEXT NOT NULL DEFAULT '[]',
    updated_at  INTEGER NOT NULL
  );

  -- ② Immutable operation log (source of truth utama)
  CREATE TABLE IF NOT EXISTS operation_logs (
    op_id        TEXT PRIMARY KEY,
    node_id      TEXT NOT NULL,
    entity_type  TEXT NOT NULL,
    op_type      TEXT NOT NULL,
    payload      TEXT NOT NULL,
    vector_clock TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    synced       INTEGER NOT NULL DEFAULT 0
  );

  -- ③ Sync state per peer
  CREATE TABLE IF NOT EXISTS sync_metadata (
    peer_node_id  TEXT PRIMARY KEY,
    last_sync_at  INTEGER,
    last_op_id    TEXT,
    last_heads    TEXT DEFAULT '[]',
    sync_state    TEXT NOT NULL DEFAULT 'unknown'
  );

  -- ④ Local device configuration (TIDAK disync)
  CREATE TABLE IF NOT EXISTS device_config (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  -- Index untuk query umum
  CREATE INDEX IF NOT EXISTS idx_oplogs_entity
    ON operation_logs (entity_type, created_at);

  CREATE INDEX IF NOT EXISTS idx_oplogs_node
    ON operation_logs (node_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_oplogs_synced
    ON operation_logs (synced, created_at);
  `
];

// ─── Database class ───────────────────────────────────────────────
class Database {
  constructor() {
    this.db       = null;
    this.SQL      = null;
    this.dbPath   = null;
    this._dirty   = false;
    this._saveTimer = null;
  }

  /**
   * Inisialisasi database.
   * @param {string} dbPath - path file .db di disk
   */
  async init(dbPath) {
    const initSqlJs = require('sql.js');
    this.SQL    = await initSqlJs();
    const os = require('os');
    // Normalize common /tmp path (Unix-style) to the platform temp dir on Windows
    let resolvedPath = dbPath;
    if (resolvedPath.startsWith('/tmp')) {
      resolvedPath = path.join(os.tmpdir(), path.basename(resolvedPath));
    }
    // Resolve to absolute path and ensure parent directory exists
    this.dbPath = path.resolve(resolvedPath);
    const parent = path.dirname(this.dbPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }

    // Load existing DB dari disk jika ada
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      this.db = new this.SQL.Database(fileBuffer);
      console.log(`[DB] Loaded existing database: ${dbPath}`);
    } else {
      this.db = new this.SQL.Database();
      console.log(`[DB] Created new database: ${dbPath}`);
    }

    this._runMigrations();

    // Auto-save ke disk setiap 5 detik jika ada perubahan
    this._saveTimer = setInterval(() => this._flushToDisk(), 5000);

    return this;
  }

  /**
   * Jalankan migrations yang belum diaplikasikan.
   */
  _runMigrations() {
    const currentVersion = this._getCurrentSchemaVersion();

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      console.log(`[DB] Applying migration v${i + 1}...`);
      this.db.run(MIGRATIONS[i]);
      this.db.run(
        'INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)',
        [i + 1, Date.now()]
      );
      this._dirty = true;
    }

    this._flushToDisk();
    console.log(`[DB] Schema version: ${this._getCurrentSchemaVersion()}`);
  }

  _getCurrentSchemaVersion() {
    try {
      const result = this.db.exec('SELECT MAX(version) as v FROM schema_version');
      if (result.length && result[0].values.length) {
        return result[0].values[0][0] || 0;
      }
    } catch (_) {}
    return 0;
  }

  /**
   * Persist database buffer ke disk.
   */
  _flushToDisk() {
    if (!this._dirty) return;
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
    this._dirty = false;
  }

  /**
   * Eksekusi query dengan params. Return rows sebagai array of objects.
   */
  _query(sql, params = []) {
    const result = this.db.exec(sql, params);
    if (!result.length) return [];
    const { columns, values } = result[0];
    return values.map(row =>
      Object.fromEntries(columns.map((col, i) => [col, row[i]]))
    );
  }

  /**
   * Eksekusi statement (INSERT/UPDATE/DELETE).
   */
  _run(sql, params = []) {
    this.db.run(sql, params);
    this._dirty = true;
  }

  // ─── device_config ──────────────────────────────────────────────

  getConfig(key) {
    const rows = this._query(
      'SELECT value FROM device_config WHERE key = ?', [key]
    );
    return rows.length ? rows[0].value : null;
  }

  setConfig(key, value) {
    this._run(
      'INSERT OR REPLACE INTO device_config (key, value) VALUES (?, ?)',
      [key, value]
    );
  }

  getAllConfig() {
    return this._query('SELECT key, value FROM device_config');
  }

  // ─── automerge_docs ─────────────────────────────────────────────

  /**
   * Simpan Automerge document binary.
   * @param {string} docId - misal: "products", "transactions", "users"
   * @param {Uint8Array} binary - hasil Automerge.save(doc)
   * @param {string[]} heads - hasil JSON.stringify(Automerge.getHeads(doc))
   */
  saveDoc(docId, binary, heads) {
    this._run(
      `INSERT OR REPLACE INTO automerge_docs
         (doc_id, doc_binary, heads, updated_at)
       VALUES (?, ?, ?, ?)`,
      [docId, binary, JSON.stringify(heads), Date.now()]
    );
  }

  /**
   * Load Automerge document binary.
   * @param {string} docId
   * @returns {{ doc_binary: Buffer, heads: string[] } | null}
   */
  loadDoc(docId) {
    const rows = this._query(
      'SELECT doc_binary, heads, updated_at FROM automerge_docs WHERE doc_id = ?',
      [docId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      doc_binary: row.doc_binary,
      heads: JSON.parse(row.heads),
      updated_at: row.updated_at,
    };
  }

  getAllDocIds() {
    return this._query('SELECT doc_id, updated_at FROM automerge_docs')
      .map(r => r.doc_id);
  }

  // ─── operation_logs ─────────────────────────────────────────────

  /**
   * Insert satu operation log. Immutable — tidak ada UPDATE.
   * @param {object} op
   */
  insertOp(op) {
    this._run(
      `INSERT INTO operation_logs
         (op_id, node_id, entity_type, op_type, payload, vector_clock, created_at, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        op.op_id,
        op.node_id,
        op.entity_type,
        op.op_type,
        JSON.stringify(op.payload),
        JSON.stringify(op.vector_clock),
        op.created_at || Date.now(),
      ]
    );
  }

  /**
   * Batch insert operations (dari sync).
   */
  insertOpsBatch(ops) {
    for (const op of ops) {
      // Skip jika op_id sudah ada (idempotent)
      const exists = this._query(
        'SELECT 1 FROM operation_logs WHERE op_id = ?', [op.op_id]
      );
      if (!exists.length) {
        this.insertOp(op);
      }
    }
  }

  /**
   * Ambil semua ops untuk entity_type tertentu, urut by created_at ASC.
   */
  getOpsByEntity(entityType) {
    return this._query(
      `SELECT * FROM operation_logs
       WHERE entity_type = ?
       ORDER BY created_at ASC`,
      [entityType]
    ).map(this._parseOp);
  }

  /**
   * Ambil ops yang belum disync.
   */
  getPendingOps() {
    return this._query(
      `SELECT * FROM operation_logs
       WHERE synced = 0
       ORDER BY created_at ASC`
    ).map(this._parseOp);
  }

  /**
   * Ambil ops setelah op_id tertentu (untuk incremental sync).
   */
  getOpsAfter(afterOpId, limit = 500) {
    if (!afterOpId) {
      return this._query(
        `SELECT * FROM operation_logs ORDER BY created_at ASC LIMIT ?`,
        [limit]
      ).map(this._parseOp);
    }

    const ref = this._query(
      'SELECT created_at FROM operation_logs WHERE op_id = ?', [afterOpId]
    );
    if (!ref.length) {
      // If the referenced op_id is unknown on this node (e.g., peer provided
      // an op id we don't have), fall back to returning the earliest ops so
      // the peer can receive missing entries instead of getting nothing.
      return this._query(
        `SELECT * FROM operation_logs ORDER BY created_at ASC LIMIT ?`,
        [limit]
      ).map(this._parseOp);
    }

    return this._query(
      `SELECT * FROM operation_logs
       WHERE created_at >= ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [ref[0].created_at, limit]
    ).map(this._parseOp);
  }

  /**
   * Tandai ops sebagai sudah disync.
   */
  markOpsSynced(opIds) {
    if (!opIds.length) return;
    const placeholders = opIds.map(() => '?').join(',');
    this._run(
      `UPDATE operation_logs SET synced = 1 WHERE op_id IN (${placeholders})`,
      opIds
    );
  }

  getTotalOpCount() {
    const result = this._query('SELECT COUNT(*) as cnt FROM operation_logs');
    return result[0]?.cnt || 0;
  }

  getOpCount(entityType) {
    const result = this._query(
      'SELECT COUNT(*) as cnt FROM operation_logs WHERE entity_type = ?',
      [entityType]
    );
    return result[0]?.cnt || 0;
  }

  _parseOp(row) {
    return {
      ...row,
      payload:      JSON.parse(row.payload),
      vector_clock: JSON.parse(row.vector_clock),
    };
  }

  // ─── sync_metadata ──────────────────────────────────────────────

  upsertSyncMeta(peerNodeId, data) {
    this._run(
      `INSERT OR REPLACE INTO sync_metadata
         (peer_node_id, last_sync_at, last_op_id, last_heads, sync_state)
       VALUES (?, ?, ?, ?, ?)`,
      [
        peerNodeId,
        data.last_sync_at || Date.now(),
        data.last_op_id   || null,
        JSON.stringify(data.last_heads || []),
        data.sync_state   || 'synced',
      ]
    );
  }

  getSyncMeta(peerNodeId) {
    const rows = this._query(
      'SELECT * FROM sync_metadata WHERE peer_node_id = ?', [peerNodeId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return { ...row, last_heads: JSON.parse(row.last_heads || '[]') };
  }

  getAllSyncMeta() {
    return this._query('SELECT * FROM sync_metadata').map(row => ({
      ...row,
      last_heads: JSON.parse(row.last_heads || '[]')
    }));
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  close() {
    if (this._saveTimer) clearInterval(this._saveTimer);
    this._flushToDisk();
    if (this.db) this.db.close();
    console.log('[DB] Database closed.');
  }

  /**
   * Debug: tampilkan ringkasan isi database.
   */
  summary() {
    const docs     = this.getAllDocIds();
    const totalOps = this.getTotalOpCount();
    const peers    = this.getAllSyncMeta();
    const config   = this.getAllConfig();

    return {
      docs,
      totalOps,
      peers: peers.map(p => p.peer_node_id),
      config: config.reduce((acc, c) => ({ ...acc, [c.key]: c.value }), {}),
    };
  }
}

module.exports = { Database };