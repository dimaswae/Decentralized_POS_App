/**
 * electron/crdt/inventory-projection.js
 * Inventory Projection Engine
 *
 * Inventory BUKAN mutable state di Automerge doc.
 * Inventory adalah PROJECTION (derived state) dari operation_logs.
 *
 * Mengapa?
 *  - Concurrent decrement dari 2 node offline tidak bisa di-merge aman
 *    jika disimpan sebagai single integer
 *  - Dengan projection: semua adjustment ops dijumlahkan → commutative
 *  - Tidak ada konflik karena tidak ada shared mutable value
 *
 * Contoh:
 *  Node A (offline): jual 3 → op { delta: -3 }
 *  Node B (offline): jual 2 → op { delta: -2 }
 *  Setelah sync: stock = initial + (-3) + (-2) = correct ✅
 *
 * Operation types yang mempengaruhi inventory:
 *  - "stock_init"   → delta: +N (inisialisasi stok awal)
 *  - "stock_in"     → delta: +N (stok masuk / restock)
 *  - "stock_out"    → delta: -N (penjualan / dikurangi manual)
 *  - "stock_adjust" → delta: +/- N (koreksi stok)
 */

'use strict';

class InventoryProjection {
  /**
   * @param {Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Hitung stok terkini untuk satu produk.
   * Menjumlahkan semua delta dari operation_logs.
   *
   * @param {string} productId
   * @returns {number} stok terkini
   */
  getStock(productId) {
    const ops = this.db.getOpsByEntity('inventory')
      .filter(op => op.payload.product_id === productId);

    return ops.reduce((sum, op) => sum + (op.payload.delta || 0), 0);
  }

  /**
   * Hitung stok semua produk sekaligus.
   * Efisien — satu pass melalui semua inventory ops.
   *
   * @returns {object} { productId: stock }
   */
  getAllStocks() {
    const ops    = this.db.getOpsByEntity('inventory');
    const stocks = {};

    for (const op of ops) {
      const pid = op.payload.product_id;
      if (!pid) continue;
      stocks[pid] = (stocks[pid] || 0) + (op.payload.delta || 0);
    }

    return stocks;
  }

  /**
   * Dapatkan riwayat semua perubahan stok untuk satu produk.
   *
   * @param {string} productId
   * @returns {object[]}
   */
  getStockHistory(productId) {
    return this.db.getOpsByEntity('inventory')
      .filter(op => op.payload.product_id === productId)
      .map(op => ({
        op_id:       op.op_id,
        op_type:     op.op_type,
        delta:       op.payload.delta,
        note:        op.payload.note    || '',
        tx_id:       op.payload.tx_id   || null,
        node_id:     op.node_id,
        created_at:  op.created_at,
        vector_clock: op.vector_clock,
      }));
  }

  /**
   * Validasi post-merge: cek apakah ada produk dengan stok negatif.
   * Ini adalah semantic conflict yang tidak bisa dicegah CRDT —
   * harus ditangani di application level.
   *
   * @returns {object[]} array produk dengan stok negatif
   */
  detectNegativeStock() {
    const stocks   = this.getAllStocks();
    const anomalies = [];

    for (const [productId, stock] of Object.entries(stocks)) {
      if (stock < 0) {
        anomalies.push({ productId, stock });
      }
    }

    return anomalies;
  }

  /**
   * Buat operation untuk inisialisasi stok awal.
   *
   * @param {string} productId
   * @param {number} initialQty
   * @param {string} nodeId
   * @param {object} vectorClock
   * @returns {object} op object siap di-insert ke DB
   */
  static createStockInitOp(productId, initialQty, nodeId, vectorClock) {
    const { v4: uuidv4 } = require('uuid');
    return {
      op_id:        uuidv4(),
      node_id:      nodeId,
      entity_type:  'inventory',
      op_type:      'stock_init',
      payload: {
        product_id: productId,
        delta:      initialQty,
        note:       'Inisialisasi stok awal',
      },
      vector_clock: vectorClock,
      created_at:   Date.now(),
    };
  }

  /**
   * Buat operation untuk penjualan (stok keluar).
   *
   * @param {string} productId
   * @param {number} qty - jumlah yang dijual (positif)
   * @param {string} txId - transaction ID terkait
   * @param {string} nodeId
   * @param {object} vectorClock
   * @returns {object} op object
   */
  static createStockOutOp(productId, qty, txId, nodeId, vectorClock) {
    const { v4: uuidv4 } = require('uuid');
    return {
      op_id:        uuidv4(),
      node_id:      nodeId,
      entity_type:  'inventory',
      op_type:      'stock_out',
      payload: {
        product_id: productId,
        delta:      -Math.abs(qty),  // selalu negatif
        tx_id:      txId,
        note:       `Penjualan tx:${txId}`,
      },
      vector_clock: vectorClock,
      created_at:   Date.now(),
    };
  }

  /**
   * Buat operation untuk restock (stok masuk).
   */
  static createStockInOp(productId, qty, note, nodeId, vectorClock) {
    const { v4: uuidv4 } = require('uuid');
    return {
      op_id:        uuidv4(),
      node_id:      nodeId,
      entity_type:  'inventory',
      op_type:      'stock_in',
      payload: {
        product_id: productId,
        delta:      Math.abs(qty),   // selalu positif
        note:       note || 'Restock',
      },
      vector_clock: vectorClock,
      created_at:   Date.now(),
    };
  }

  /**
   * Buat operation koreksi stok manual.
   */
  static createStockAdjustOp(productId, delta, note, nodeId, vectorClock) {
    const { v4: uuidv4 } = require('uuid');
    return {
      op_id:        uuidv4(),
      node_id:      nodeId,
      entity_type:  'inventory',
      op_type:      'stock_adjust',
      payload: {
        product_id: productId,
        delta,
        note:       note || 'Koreksi stok',
      },
      vector_clock: vectorClock,
      created_at:   Date.now(),
    };
  }
}

module.exports = { InventoryProjection };