/**
 * electron/crdt/doc-manager.js
 * Automerge Document Manager
 *
 * Tanggung jawab:
 *  - Manage Automerge documents per entitas (products, transactions, users)
 *  - Load/save docs dari/ke SQLite
 *  - Apply changes dari peer
 *  - Generate changesets untuk sync
 *
 * Dokumen yang dikelola:
 *  - "products"     → Map<productId, ProductData>
 *  - "transactions" → List<Transaction> (append-only)
 *  - "users"        → Map<userId, UserData>
 *
 * CATATAN: Inventory BUKAN Automerge doc.
 *  Inventory = projection dari operation_logs (lihat inventory-projection.js)
 */

'use strict';

const Automerge = require('@automerge/automerge');

// Entitas yang menggunakan Automerge doc
const DOC_IDS = ['products', 'transactions', 'users'];

class DocManager {
  /**
   * @param {Database} db - instance Database
   * @param {string} nodeId - actor ID untuk Automerge
   */
  constructor(db, nodeId) {
    this.db      = db;
    this.nodeId  = nodeId;
    // Automerge actor ID harus valid hex string (16 bytes = 32 hex chars)
    // Gunakan MD5 dari nodeId → deterministik dan selalu valid hex
    const crypto   = require('crypto');
    this.actorId   = crypto.createHash('md5').update(nodeId).digest('hex');
    this.docs      = {};  // { docId: Automerge.Doc }
  }

  /**
   * Inisialisasi semua dokumen.
   * Load dari DB jika ada, buat baru jika belum.
   */
  init() {
    for (const docId of DOC_IDS) {
      const saved = this.db.loadDoc(docId);

      if (saved && saved.doc_binary) {
        try {
          // Load dari binary yang tersimpan
          const binary = new Uint8Array(saved.doc_binary);
          this.docs[docId] = Automerge.load(binary);
          console.log(`[DocManager] Loaded doc: ${docId}`);
        } catch (err) {
          console.error(`[DocManager] Corrupt doc ${docId}, reinitializing:`, err.message);
          this.docs[docId] = this._createEmptyDoc(docId);
          this._persistDoc(docId);
        }
      } else {
        // Buat dokumen baru
        this.docs[docId] = this._createEmptyDoc(docId);
        this._persistDoc(docId);
        console.log(`[DocManager] Created new doc: ${docId}`);
      }
    }
  }

  /**
   * Buat struktur awal dokumen sesuai entitas.
   */
  _createEmptyDoc(docId) {
    // PENTING: genesis actor HARUS deterministik dan sama di semua node.
    // Ini menjamin bahwa "items = {}" assignment hanya ada satu origin actor,
    // sehingga Automerge merge tidak memperlakukan init sebagai LWW conflict.
    // Semua node apply genesis changes ini via getAllChanges saat pertama sync.
    const genesisActor = require('crypto')
      .createHash('md5').update(`genesis-${docId}`).digest('hex');

    const baseDoc = Automerge.change(
      Automerge.init(genesisActor),
      `genesis init ${docId}`,
      doc => {
        if (docId === 'products' || docId === 'users') {
          doc.items = {};
          doc.version = 0;
        } else if (docId === 'transactions') {
          doc.items = [];
          doc.version = 0;
        }
      }
    );

    // Node ini kemudian menjadi "actor" di atas genesis doc
    // Clone mempertahankan semua changes genesis sebagai base
    return Automerge.clone(baseDoc);
  }

  /**
   * Simpan dokumen ke SQLite.
   */
  _persistDoc(docId) {
    const doc    = this.docs[docId];
    const binary = Automerge.save(doc);
    const heads  = Automerge.getHeads(doc);
    this.db.saveDoc(docId, binary, heads);
  }

  // ─── Products ────────────────────────────────────────────────────

  /**
   * Tambah atau update product.
   * @param {object} product - { id, name, price, category, unit, created_at }
   */
  upsertProduct(product) {
    this.docs['products'] = Automerge.change(
      this.docs['products'],
      `upsert product ${product.id}`,
      doc => {
        doc.items[product.id] = {
          id:         product.id,
          name:       product.name,
          price:      product.price,
          category:   product.category || 'umum',
          unit:       product.unit     || 'pcs',
          updated_at: Date.now(),
          node_id:    this.nodeId,
        };
        doc.version = (doc.version || 0) + 1;
      }
    );
    this._persistDoc('products');
    return this.docs['products'].items[product.id];
  }

  getProduct(productId) {
    return this.docs['products'].items[productId] || null;
  }

  getAllProducts() {
    const items = this.docs['products'].items;
    return Object.values(items);
  }

  // ─── Transactions ────────────────────────────────────────────────

  /**
   * Append transaksi baru (immutable — tidak ada delete/update).
   * @param {object} tx - { id, items, total, cashier_id, node_id, created_at }
   */
  appendTransaction(tx) {
    this.docs['transactions'] = Automerge.change(
      this.docs['transactions'],
      `add transaction ${tx.id}`,
      doc => {
        doc.items.push({
          id:         tx.id,
          items:      tx.items,      // [{ product_id, qty, price_at_sale }]
          total:      tx.total,
          cashier_id: tx.cashier_id,
          node_id:    tx.node_id || this.nodeId,
          created_at: tx.created_at || Date.now(),
        });
        doc.version = (doc.version || 0) + 1;
      }
    );
    this._persistDoc('transactions');
  }

  getAllTransactions() {
    return [...this.docs['transactions'].items];
  }

  getTransactionCount() {
    return this.docs['transactions'].items.length;
  }

  // ─── Users ───────────────────────────────────────────────────────

  upsertUser(user) {
    this.docs['users'] = Automerge.change(
      this.docs['users'],
      `upsert user ${user.id}`,
      doc => {
        doc.items[user.id] = {
          id:         user.id,
          name:       user.name,
          role:       user.role || 'cashier', // 'admin' | 'cashier'
          pin_hash:   user.pin_hash || '',
          updated_at: Date.now(),
        };
        doc.version = (doc.version || 0) + 1;
      }
    );
    this._persistDoc('users');
  }

  getUser(userId) {
    return this.docs['users'].items[userId] || null;
  }

  getAllUsers() {
    return Object.values(this.docs['users'].items);
  }

  // ─── Sync support ────────────────────────────────────────────────

  /**
   * Dapatkan heads (untuk dikirim ke peer saat handshake).
   * @param {string} docId
   * @returns {string[]}
   */
  getHeads(docId) {
    return Automerge.getHeads(this.docs[docId]);
  }

  /**
   * Dapatkan semua heads untuk semua dokumen.
   * @returns {object} { docId: heads[] }
   */
  getAllHeads() {
    const result = {};
    for (const docId of DOC_IDS) {
      result[docId] = this.getHeads(docId);
    }
    return result;
  }

  /**
   * Dapatkan changesets sejak heads tertentu (untuk dikirim ke peer).
   * @param {string} docId
   * @param {string[]} sinceHeads - heads milik peer (dari handshake)
   * @returns {Uint8Array[]} array of changes
   */
  /**
   * Automerge v2: selalu kirim ALL changes — applyChanges bersifat idempotent.
   * Peer yang sudah punya changes akan skip otomatis via hash deduplication.
   */
  getChangesSince(docId, _sinceHeads) {
    return Automerge.getAllChanges(this.docs[docId]);
  }

  /**
   * Apply changesets yang diterima dari peer.
   * @param {string} docId
   * @param {Uint8Array[]} changes
   * @returns {{ newDoc, patches }} hasil merge
   */
  applyChanges(docId, changes) {
    if (!changes || changes.length === 0) {
      return { newDoc: this.docs[docId], patches: [] };
    }

    try {
      // Automerge v2: applyChanges returns [newDoc] only (no patches)
      const [newDoc] = Automerge.applyChanges(
        this.docs[docId],
        changes.map(c => new Uint8Array(c))
      );
      this.docs[docId] = newDoc;
      this._persistDoc(docId);

      console.log(`[DocManager] Applied ${changes.length} changes to ${docId}`);
      return { newDoc, patches: [] };
    } catch (err) {
      console.error(`[DocManager] applyChanges error for ${docId}:`, err.message);
      return { newDoc: this.docs[docId], patches: [], error: err.message };
    }
  }

  /**
   * Merge dua docs (digunakan saat rebuild dari scratch).
   */
  mergeWith(docId, otherDoc) {
    this.docs[docId] = Automerge.merge(this.docs[docId], otherDoc);
    this._persistDoc(docId);
  }

  /**
   * Rebuild doc dari scratch menggunakan getAllChanges
   * (digunakan untuk verifikasi konsistensi).
   */
  rebuildFromChanges(docId, allChanges) {
    let doc = Automerge.init(this.actorId);
    const [rebuilt] = Automerge.applyChanges(doc, allChanges);
    this.docs[docId] = rebuilt;
    this._persistDoc(docId);
    console.log(`[DocManager] Rebuilt doc: ${docId}`);
  }

  /**
   * Ringkasan status semua dokumen.
   */
  summary() {
    return {
      products:     this.getAllProducts().length,
      transactions: this.getTransactionCount(),
      users:        this.getAllUsers().length,
      heads: this.getAllHeads(),
    };
  }
}

module.exports = { DocManager, DOC_IDS };