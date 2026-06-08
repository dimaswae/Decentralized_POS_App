/**
 * electron/pos-service.js
 * POS Business Logic Service
 *
 * Ini adalah entry point untuk semua operasi bisnis POS.
 * Mengkoordinasikan:
 *  - DocManager (Automerge CRDT)
 *  - InventoryProjection (derived stock)
 *  - VectorClock (causal tracking)
 *  - Database (SQLite persistence)
 */

'use strict';

const { v4: uuidv4 }           = require('uuid');
const { DocManager }           = require('./crdt/doc-manager');
const { InventoryProjection }  = require('./crdt/inventory-projection');
const { VectorClock }          = require('./crdt/vector-clock');

class PosService {
  /**
   * @param {Database} db
   * @param {string} nodeId
   */
  constructor(db, nodeId) {
    this.db         = db;
    this.nodeId     = nodeId;
    this.docManager = new DocManager(db, nodeId);
    this.inventory  = new InventoryProjection(db);
    this.vc         = new VectorClock(nodeId);
  }

  /**
   * Inisialisasi service.
   * Harus dipanggil sekali saat startup.
   */
  init() {
    this.docManager.init();
    this._loadVectorClockFromDB();
    console.log(`[PosService] Ready. Node: ${this.nodeId}`);
  }

  /**
   * Load vector clock dari op log terbaru (setelah restart).
   */
  _loadVectorClockFromDB() {
    const allOps = this.db._query(
      'SELECT vector_clock FROM operation_logs ORDER BY created_at DESC LIMIT 1'
    );
    if (allOps.length) {
      const lastVC = JSON.parse(allOps[0].vector_clock);
      this.vc.load(lastVC);
      console.log(`[PosService] Vector clock restored: ${JSON.stringify(lastVC)}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // PRODUCTS
  // ──────────────────────────────────────────────────────────────────

  /**
   * Tambah produk baru.
   * @param {{ name, price, category, unit }} data
   * @returns {object} produk yang dibuat
   */
  addProduct(data) {
    const product = {
      id:         uuidv4(),
      name:       data.name,
      price:      data.price,
      category:   data.category || 'umum',
      unit:       data.unit     || 'pcs',
    };

    this.docManager.upsertProduct(product);
    console.log(`[PosService] Product added: ${product.id} — ${product.name}`);
    return product;
  }

  /**
   * Update produk (harga, nama, dll).
   */
  updateProduct(productId, updates) {
    const existing = this.docManager.getProduct(productId);
    if (!existing) throw new Error(`Product not found: ${productId}`);

    const updated = { ...existing, ...updates };
    this.docManager.upsertProduct(updated);
    return updated;
  }

  getProduct(productId) {
    return this.docManager.getProduct(productId);
  }

  getAllProducts() {
    const products = this.docManager.getAllProducts();
    const stocks   = this.inventory.getAllStocks();

    // Gabungkan produk dengan stok terkini
    return products.map(p => ({
      ...p,
      stock: stocks[p.id] || 0,
    }));
  }

  // ──────────────────────────────────────────────────────────────────
  // INVENTORY
  // ──────────────────────────────────────────────────────────────────

  /**
   * Set stok awal produk (biasanya saat produk baru ditambah).
   */
  initStock(productId, qty, note = 'Stok awal') {
    const vcSnapshot = this.vc.tick();
    const op = InventoryProjection.createStockInitOp(
      productId, qty, this.nodeId, vcSnapshot
    );
    this.db.insertOp(op);

    const newStock = this.inventory.getStock(productId);
    console.log(`[PosService] Stock init: ${productId} = ${newStock}`);
    return { stock: newStock, op };
  }

  /**
   * Tambah stok (restock).
   */
  addStock(productId, qty, note = 'Restock') {
    const vcSnapshot = this.vc.tick();
    const op = InventoryProjection.createStockInOp(
      productId, qty, note, this.nodeId, vcSnapshot
    );
    this.db.insertOp(op);

    const newStock = this.inventory.getStock(productId);
    console.log(`[PosService] Stock in: ${productId} +${qty} = ${newStock}`);
    return { stock: newStock, op };
  }

  getStock(productId) {
    return this.inventory.getStock(productId);
  }

  getAllStocks() {
    return this.inventory.getAllStocks();
  }

  getStockHistory(productId) {
    return this.inventory.getStockHistory(productId);
  }

  // ──────────────────────────────────────────────────────────────────
  // TRANSACTIONS
  // ──────────────────────────────────────────────────────────────────

  /**
   * Buat transaksi penjualan baru.
   *
   * @param {{
   *   items: [{ product_id, qty, price_at_sale }],
   *   cashier_id: string
   * }} data
   * @returns {{ transaction, ops, anomalies }}
   */
  createTransaction(data) {
    // Validasi: semua produk harus ada
    for (const item of data.items) {
      const product = this.docManager.getProduct(item.product_id);
      if (!product) {
        throw new Error(`Product not found: ${item.product_id}`);
      }
    }

    // Hitung total
    const total = data.items.reduce(
      (sum, item) => sum + (item.price_at_sale * item.qty), 0
    );

    const txId = uuidv4();
    const tx   = {
      id:         txId,
      items:      data.items,
      total,
      cashier_id: data.cashier_id || 'unknown',
      node_id:    this.nodeId,
      created_at: Date.now(),
    };

    // 1. Append transaction ke Automerge doc
    this.docManager.appendTransaction(tx);

    // 2. Buat inventory ops (satu per item)
    const inventoryOps = [];
    for (const item of data.items) {
      const vcSnapshot = this.vc.tick();
      const op = InventoryProjection.createStockOutOp(
        item.product_id,
        item.qty,
        txId,
        this.nodeId,
        vcSnapshot
      );
      this.db.insertOp(op);
      inventoryOps.push(op);
    }

    // 3. Buat transaction op log entry
    const txVcSnapshot = this.vc.tick();
    const txOp = {
      op_id:        uuidv4(),
      node_id:      this.nodeId,
      entity_type:  'transaction',
      op_type:      'add_transaction',
      payload:      tx,
      vector_clock: txVcSnapshot,
      created_at:   Date.now(),
    };
    this.db.insertOp(txOp);

    // 4. Cek semantic conflict (stok negatif)
    const anomalies = this.inventory.detectNegativeStock();
    if (anomalies.length) {
      console.warn('[PosService] ⚠️ Negative stock detected:', anomalies);
    }

    console.log(`[PosService] Transaction created: ${txId}, total: ${total}, items: ${data.items.length}`);

    return { transaction: tx, ops: [txOp, ...inventoryOps], anomalies };
  }

  getAllTransactions() {
    return this.docManager.getAllTransactions();
  }

  getTransactionCount() {
    return this.docManager.getTransactionCount();
  }

  // ──────────────────────────────────────────────────────────────────
  // USERS
  // ──────────────────────────────────────────────────────────────────

  addUser(data) {
    const user = {
      id:       uuidv4(),
      name:     data.name,
      role:     data.role     || 'cashier',
      pin_hash: data.pin_hash || '',
    };
    this.docManager.upsertUser(user);
    return user;
  }

  getUser(userId) {
    return this.docManager.getUser(userId);
  }

  getAllUsers() {
    return this.docManager.getAllUsers();
  }

  // ──────────────────────────────────────────────────────────────────
  // SYNC SUPPORT
  // ──────────────────────────────────────────────────────────────────

  /**
   * Dapatkan semua data yang dibutuhkan untuk sync handshake.
   */
  getSyncHandshakeData() {
    return {
      node_id:     this.nodeId,
      vector_clock: this.vc.snapshot(),
      heads:        this.docManager.getAllHeads(),
      last_op_id:   this._getLastOpId(),
    };
  }

  _getLastOpId() {
    const ops = this.db._query(
      'SELECT op_id FROM operation_logs ORDER BY created_at DESC LIMIT 1'
    );
    return ops.length ? ops[0].op_id : null;
  }

  /**
   * Dapatkan changesets untuk dikirim ke peer.
   * @param {string} docId
   * @param {string[]} peerHeads - heads peer (dari handshake)
   * @returns {Uint8Array[]}
   */
  getChangesForPeer(docId, peerHeads) {
    return this.docManager.getChangesSince(docId, peerHeads);
  }

  /**
   * Apply changesets dari peer.
   * @param {string} docId
   * @param {Uint8Array[]} changes
   */
  applyPeerChanges(docId, changes) {
    return this.docManager.applyChanges(docId, changes);
  }

  /**
   * Apply operation logs dari peer (untuk inventory projection).
   * @param {object[]} ops
   */
  applyPeerOps(ops) {
    this.db.insertOpsBatch(ops);

    // Merge vector clock dari semua ops yang diterima
    for (const op of ops) {
      this.vc.merge(op.vector_clock);
    }

    // Cek semantic conflict setelah menerima ops dari peer
    const anomalies = this.inventory.detectNegativeStock();
    if (anomalies.length) {
      console.warn('[PosService] ⚠️ Post-sync negative stock detected:', anomalies);
    }

    return { applied: ops.length, anomalies };
  }

  // ──────────────────────────────────────────────────────────────────
  // DEBUG & STATUS
  // ──────────────────────────────────────────────────────────────────

  getSystemStatus() {
    return {
      node_id:      this.nodeId,
      vector_clock: this.vc.snapshot(),
      docs:         this.docManager.summary(),
      db:           this.db.summary(),
      stocks:       this.inventory.getAllStocks(),
      anomalies:    this.inventory.detectNegativeStock(),
    };
  }
}

module.exports = { PosService };