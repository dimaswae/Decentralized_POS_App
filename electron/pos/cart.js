/**
 * electron/pos/cart.js
 * Cart Manager — Local device state (NOT synced)
 *
 * Cart adalah ephemeral state per sesi transaksi.
 * Tidak ada sync, tidak ada persistence.
 * Saat checkout → PosService.createTransaction() yang menyimpan ke distributed state.
 */
'use strict';

class CartManager {
  /**
   * @param {PosService} posService
   * @param {AuthService} authService
   */
  constructor(posService, authService) {
    this.posService  = posService;
    this.authService = authService;
    this._items      = new Map(); // productId → { product, qty, subtotal }
    this._note       = '';
    this._createdAt  = Date.now();
  }

  // ─── Cart operations ──────────────────────────────────────────────

  /**
   * Tambah atau update item di cart.
   * @param {string} productId
   * @param {number} qty - jumlah yang akan ditambahkan (bukan total)
   * @returns {{ ok: boolean, item?, error? }}
   */
  addItem(productId, qty = 1) {
    if (qty <= 0) return { ok: false, error: 'Qty harus > 0' };

    const product = this.posService.getProduct(productId);
    if (!product)  return { ok: false, error: `Produk tidak ditemukan: ${productId}` };

    const currentStock = this.posService.getStock(productId);
    const cartQty      = (this._items.get(productId)?.qty || 0) + qty;

    // Soft warning (tidak block — CRDT tetap catat)
    if (cartQty > currentStock) {
      console.warn(`[Cart] ⚠️  Qty ${cartQty} > stok ${currentStock} untuk ${product.name}`);
    }

    if (this._items.has(productId)) {
      const existing = this._items.get(productId);
      existing.qty      += qty;
      existing.subtotal  = existing.qty * product.price;
    } else {
      this._items.set(productId, {
        product_id:     productId,
        name:           product.name,
        price_at_sale:  product.price,
        qty,
        subtotal:       qty * product.price,
      });
    }

    return { ok: true, item: this._items.get(productId) };
  }

  /**
   * Set qty absolut untuk item.
   */
  setQty(productId, qty) {
    if (qty <= 0) return this.removeItem(productId);

    const product = this.posService.getProduct(productId);
    if (!product)  return { ok: false, error: `Produk tidak ditemukan: ${productId}` };

    this._items.set(productId, {
      product_id:    productId,
      name:          product.name,
      price_at_sale: product.price,
      qty,
      subtotal:      qty * product.price,
    });
    return { ok: true, item: this._items.get(productId) };
  }

  removeItem(productId) {
    const existed = this._items.delete(productId);
    return { ok: existed, removed: existed };
  }

  clear() {
    this._items.clear();
    this._note      = '';
    this._createdAt = Date.now();
    return { ok: true };
  }

  setNote(note) { this._note = note; }

  // ─── Cart state ───────────────────────────────────────────────────

  getItems() {
    return Array.from(this._items.values());
  }

  getItemCount()  { return this._items.size; }
  isEmpty()       { return this._items.size === 0; }

  getTotal() {
    return Array.from(this._items.values())
      .reduce((sum, item) => sum + item.subtotal, 0);
  }

  getSummary() {
    return {
      items:      this.getItems(),
      itemCount:  this.getItemCount(),
      total:      this.getTotal(),
      note:       this._note,
      createdAt:  this._createdAt,
    };
  }

  // ─── Checkout ─────────────────────────────────────────────────────

  /**
   * Checkout cart → buat transaksi di PosService.
   * @param {{ payment, change }} paymentInfo
   * @returns {{ ok: boolean, transaction?, receipt?, error? }}
   */
  checkout(paymentInfo = {}) {
    if (this.isEmpty()) {
      return { ok: false, error: 'Cart kosong' };
    }

    let session;
    try {
      session = this.authService.requireAuth();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const total   = this.getTotal();

    if (paymentInfo.payment !== undefined && paymentInfo.payment < total) {
      return { ok: false, error: `Pembayaran kurang: ${paymentInfo.payment} < ${total}` };
    }

    // Buat transaksi
    const items = this.getItems().map(item => ({
      product_id:    item.product_id,
      qty:           item.qty,
      price_at_sale: item.price_at_sale,
    }));

    const { transaction, ops, anomalies } = this.posService.createTransaction({
      cashier_id: session.userId,
      items,
    });

    // Buat receipt
    const receipt = {
      transaction_id: transaction.id,
      items:          this.getItems(),
      total,
      payment:        paymentInfo.payment || total,
      change:         (paymentInfo.payment || total) - total,
      cashier:        session.name,
      node_id:        this.posService.nodeId,
      timestamp:      transaction.created_at,
      note:           this._note,
      anomalies,
    };

    // Bersihkan cart setelah checkout
    this.clear();

    console.log(`[Cart] Checkout success: ${transaction.id} | total: ${total}`);
    return { ok: true, transaction, receipt, ops };
  }
}

module.exports = { CartManager };