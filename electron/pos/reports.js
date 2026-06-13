/**
 * electron/pos/reports.js
 * Reports — Derived projections dari operation_logs + Automerge docs
 *
 * Semua report dihitung secara lokal dari data yang tersedia.
 * Tidak ada server-side aggregation.
 */
'use strict';

class ReportsService {
  /**
   * @param {PosService} posService
   */
  constructor(posService) {
    this.posService = posService;
  }

  // ─── Daily sales ──────────────────────────────────────────────────

  /**
   * Ringkasan penjualan hari ini.
   * @param {number} dateTs - unix timestamp hari target (default: hari ini)
   */
  getDailySummary(dateTs = Date.now()) {
    const dayStart = this._startOfDay(dateTs);
    const dayEnd   = dayStart + 86400000;

    const txs = this.posService.getAllTransactions()
      .filter(tx => tx.created_at >= dayStart && tx.created_at < dayEnd);

    const totalRevenue = txs.reduce((s, tx) => s + tx.total, 0);
    const itemsSold    = txs.flatMap(tx => tx.items)
      .reduce((sum, item) => sum + item.qty, 0);

    // Per-product breakdown
    const byProduct = {};
    for (const tx of txs) {
      for (const item of tx.items) {
        if (!byProduct[item.product_id]) {
          const prod = this.posService.getProduct(item.product_id);
          byProduct[item.product_id] = {
            product_id:  item.product_id,
            name:        prod?.name || 'Unknown',
            qty_sold:    0,
            revenue:     0,
          };
        }
        byProduct[item.product_id].qty_sold += item.qty;
        byProduct[item.product_id].revenue  += item.qty * item.price_at_sale;
      }
    }

    // Per-node breakdown
    const byNode = {};
    for (const tx of txs) {
      const nid = tx.node_id || 'unknown';
      if (!byNode[nid]) byNode[nid] = { node_id: nid, tx_count: 0, revenue: 0 };
      byNode[nid].tx_count++;
      byNode[nid].revenue += tx.total;
    }

    return {
      date:          new Date(dayStart).toISOString().slice(0, 10),
      tx_count:      txs.length,
      total_revenue: totalRevenue,
      items_sold:    itemsSold,
      avg_tx_value:  txs.length ? Math.round(totalRevenue / txs.length) : 0,
      by_product:    Object.values(byProduct)
        .sort((a, b) => b.revenue - a.revenue),
      by_node:       Object.values(byNode),
    };
  }

  // ─── Inventory report ─────────────────────────────────────────────

  /**
   * Laporan stok saat ini + produk low-stock.
   * @param {number} lowStockThreshold
   */
  getInventoryReport(lowStockThreshold = 10) {
    const products   = this.posService.getAllProducts(); // includes stock
    const lowStock   = products.filter(p => p.stock <= lowStockThreshold && p.stock > 0);
    const outOfStock = products.filter(p => p.stock <= 0);
    const negative   = this.posService.inventory.detectNegativeStock();

    return {
      total_products:    products.length,
      low_stock_count:   lowStock.length,
      out_of_stock_count: outOfStock.length,
      negative_stock_count: negative.length,
      low_stock:         lowStock.map(p => ({ id: p.id, name: p.name, stock: p.stock })),
      out_of_stock:      outOfStock.map(p => ({ id: p.id, name: p.name })),
      negative_stock:    negative,
    };
  }

  // ─── Transaction history ──────────────────────────────────────────

  /**
   * Riwayat transaksi dengan filter.
   */
  getTransactionHistory({ limit = 50, cashierId, nodeId, fromTs, toTs } = {}) {
    let txs = this.posService.getAllTransactions();

    if (cashierId) txs = txs.filter(tx => tx.cashier_id === cashierId);
    if (nodeId)    txs = txs.filter(tx => tx.node_id === nodeId);
    if (fromTs)    txs = txs.filter(tx => tx.created_at >= fromTs);
    if (toTs)      txs = txs.filter(tx => tx.created_at <= toTs);

    // Sort descending (terbaru dulu)
    txs = txs.sort((a, b) => b.created_at - a.created_at).slice(0, limit);

    return {
      count: txs.length,
      transactions: txs.map(tx => ({
        ...tx,
        item_count: tx.items?.length || 0,
        items: (tx.items || []).map(item => {
          const prod = this.posService.getProduct(item.product_id);
          return {
            ...item,
            name:  prod?.name || item.name || item.product_id,
            price: item.price_at_sale ?? item.price,
          };
        }),
        cashier: this.posService.getUser(tx.cashier_id)?.name || tx.cashier_id,
      })),
    };
  }

  // ─── Sync status ──────────────────────────────────────────────────

  /**
   * Status sinkronisasi dengan semua peer.
   */
  getSyncStatus() {
    const peers     = this.posService.db.getAllSyncMeta();
    const pendingOps = this.posService.db.getPendingOps().length;

    return {
      pending_ops:  pendingOps,
      peers:        peers.map(p => ({
        node_id:     p.peer_node_id,
        state:       p.sync_state,
        last_sync:   p.last_sync_at
          ? new Date(p.last_sync_at).toISOString()
          : 'never',
      })),
      vector_clock: this.posService.vc.snapshot(),
    };
  }

  // ─── Top products ─────────────────────────────────────────────────

  getTopProducts(limit = 5) {
    const summary = this.getDailySummary();
    return summary.by_product.slice(0, limit);
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  _startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}

module.exports = { ReportsService };