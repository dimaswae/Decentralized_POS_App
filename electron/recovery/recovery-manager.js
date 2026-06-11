/**
 * electron/recovery/recovery-manager.js
 * Recovery Manager — Crash Recovery & State Rebuild
 */
'use strict';

const Automerge = require('@automerge/automerge');
const crypto    = require('crypto');

class RecoveryManager {
  constructor(db, docManager, posService) {
    this.db         = db;
    this.docManager = docManager;
    this.posService = posService;
  }

  enableWAL() {
    try {
      this.db._run('PRAGMA journal_mode = WAL');
      this.db._run('PRAGMA synchronous = NORMAL');
      this.db._run('PRAGMA cache_size = -8000');
      this.db._run('PRAGMA temp_store = MEMORY');
      console.log('[Recovery] WAL mode enabled');
      return true;
    } catch (err) {
      console.error('[Recovery] WAL enable failed:', err.message);
      return false;
    }
  }

  checkIntegrity() {
    const issues = [];
    try {
      const result = this.db._query('PRAGMA integrity_check');
      if (result[0]?.integrity_check !== 'ok') {
        issues.push('SQLite integrity check failed');
      }
    } catch (err) {
      issues.push('integrity_check error: ' + err.message);
    }
    const requiredTables = ['automerge_docs', 'operation_logs', 'sync_metadata', 'device_config'];
    for (const table of requiredTables) {
      const exists = this.db._query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]
      );
      if (!exists.length) issues.push(`Missing table: ${table}`);
    }
    return { ok: issues.length === 0, issues };
  }

  isDocValid(docId) {
    try {
      const saved = this.db.loadDoc(docId);
      if (!saved || !saved.doc_binary) return false;
      const binary = new Uint8Array(saved.doc_binary);
      Automerge.load(binary);
      return true;
    } catch { return false; }
  }

  rebuildDoc(docId) {
    console.log(`[Recovery] Rebuilding doc: ${docId}...`);
    try {
      const entityMap = { transactions: 'transaction', products: 'product', users: 'user' };
      const entityType = entityMap[docId];
      if (!entityType) return { rebuilt: false, opCount: 0, error: `Unknown docId: ${docId}` };

      const ops = this.db.getOpsByEntity(entityType);
      const genesisActor = crypto.createHash('md5').update(`genesis-${docId}`).digest('hex');
      let doc = Automerge.change(
        Automerge.init(genesisActor),
        `genesis init ${docId}`,
        d => {
          if (docId === 'products' || docId === 'users') { d.items = {}; d.version = 0; }
          else { d.items = []; d.version = 0; }
        }
      );

      let replayed = 0;
      for (const op of ops) {
        try { doc = this._applyOpToDoc(doc, docId, op); replayed++; }
        catch (err) { console.warn(`[Recovery] Skip op ${op.op_id}: ${err.message}`); }
      }

      const binary = Automerge.save(doc);
      const heads  = Automerge.getHeads(doc);
      this.db.saveDoc(docId, binary, heads);
      this.docManager.docs[docId] = doc;
      console.log(`[Recovery] Rebuilt ${docId}: ${replayed} ops replayed`);
      return { rebuilt: true, opCount: replayed };
    } catch (err) {
      return { rebuilt: false, opCount: 0, error: err.message };
    }
  }

  _applyOpToDoc(doc, docId, op) {
    if (docId === 'transactions' && op.op_type === 'add_transaction') {
      return Automerge.change(doc, `replay tx ${op.op_id}`, d => {
        d.items.push(op.payload); d.version = (d.version || 0) + 1;
      });
    }
    if (docId === 'products' && op.op_type === 'upsert_product') {
      return Automerge.change(doc, `replay product ${op.op_id}`, d => {
        d.items[op.payload.id] = op.payload; d.version = (d.version || 0) + 1;
      });
    }
    if (docId === 'users' && op.op_type === 'upsert_user') {
      return Automerge.change(doc, `replay user ${op.op_id}`, d => {
        d.items[op.payload.id] = op.payload; d.version = (d.version || 0) + 1;
      });
    }
    return doc;
  }

  rebuildAllCorruptDocs() {
    const docIds = ['products', 'transactions', 'users'];
    const result = { checked: 0, rebuilt: 0, errors: [] };
    for (const docId of docIds) {
      result.checked++;
      if (!this.isDocValid(docId)) {
        const res = this.rebuildDoc(docId);
        if (res.rebuilt) result.rebuilt++;
        else result.errors.push({ docId, error: res.error });
      }
    }
    return result;
  }

  reconcileOrphanOps() {
    const docTxIds = new Set(this.docManager.getAllTransactions().map(tx => tx.id));
    const logTxOps = this.db.getOpsByEntity('transaction')
      .filter(op => op.op_type === 'add_transaction');
    const orphans  = logTxOps.filter(op => !docTxIds.has(op.payload?.id));

    for (const op of orphans) {
      try {
        if (op.payload?.id) {
          this.docManager.appendTransaction(op.payload);
          console.log(`[Recovery] Re-applied orphan tx: ${op.payload.id}`);
        }
      } catch (err) {
        console.error(`[Recovery] Failed to re-apply orphan tx ${op.op_id}:`, err.message);
      }
    }
    return { orphanOps: orphans.length, cleaned: orphans.length };
  }

  getPendingSyncPeers() {
    return this.db.getAllSyncMeta().filter(m => m.sync_state !== 'synced');
  }

  resetPeerSync(peerNodeId) {
    this.db.upsertSyncMeta(peerNodeId, { last_sync_at: null, last_op_id: null, last_heads: [], sync_state: 'unknown' });
    console.log(`[Recovery] Peer sync reset: ${peerNodeId}`);
  }

  async runStartupRecovery() {
    console.log('[Recovery] Running startup health check...');
    const report = {
      timestamp: Date.now(), db_integrity: null,
      docs_checked: 0, docs_rebuilt: 0,
      orphan_ops: 0, pending_syncs: 0,
      wal_enabled: false, issues: [],
    };

    report.wal_enabled  = this.enableWAL();
    const integrity     = this.checkIntegrity();
    report.db_integrity = integrity.ok ? 'OK' : 'FAILED';
    if (!integrity.ok) report.issues.push(...integrity.issues);

    const docResult     = this.rebuildAllCorruptDocs();
    report.docs_checked = docResult.checked;
    report.docs_rebuilt = docResult.rebuilt;

    const orphanResult  = this.reconcileOrphanOps();
    report.orphan_ops   = orphanResult.orphanOps;

    const pending       = this.getPendingSyncPeers();
    report.pending_syncs = pending.length;

    const status = report.issues.length === 0 ? 'HEALTHY' : 'DEGRADED';
    console.log(`[Recovery] Startup complete: ${status} | docs_rebuilt=${report.docs_rebuilt} | orphans=${report.orphan_ops}`);
    return report;
  }
}

module.exports = { RecoveryManager };
