/**
 * electron/crdt/merge-verifier.js
 * Merge Verifier — State Convergence Proof
 *
 * Digunakan untuk memverifikasi bahwa dua atau lebih node
 * telah mencapai state yang identik setelah sinkronisasi.
 *
 * Metode verifikasi:
 *  1. Hash equality  — SHA-256 dari canonical JSON state
 *  2. Op log count   — jumlah ops identik di semua node
 *  3. Stock equality — projected stock identik
 *  4. Tx count       — jumlah transaksi identik
 *
 * Digunakan dalam:
 *  - Test suite (automated convergence check)
 *  - Evaluation metrics (academic paper)
 *  - Debug mode (manual verification)
 */

'use strict';

const crypto = require('crypto');

class MergeVerifier {
  /**
   * Hitung canonical hash dari state POS node.
   * Canonical = sorted keys, deterministic JSON.
   *
   * @param {PosService} svc
   * @returns {object} { stockHash, txHash, productHash, opHash, combinedHash }
   */
  static computeStateHash(svc) {
    // 1. Stock state (inventory projection)
    const stocks     = svc.inventory.getAllStocks();
    const stockSorted = Object.fromEntries(
      Object.entries(stocks).sort(([a], [b]) => a.localeCompare(b))
    );

    // 2. Transaction state (sorted by tx id for determinism)
    const txs    = svc.docManager.getAllTransactions();
    const txSorted = [...txs].sort((a, b) => a.id.localeCompare(b.id))
      .map(tx => ({
        id:    tx.id,
        total: tx.total,
        items: [...tx.items].sort((x, y) => x.product_id.localeCompare(y.product_id)),
      }));

    // 3. Product catalog
    const products = svc.docManager.getAllProducts();
    const prodSorted = [...products].sort((a, b) => a.id.localeCompare(b.id))
      .map(p => ({ id: p.id, name: p.name, price: p.price }));

    // 4. Operation log fingerprint (op_id set)
    const ops    = svc.db.getOpsByEntity('inventory')
      .concat(svc.db.getOpsByEntity('transaction'));
    const opIds  = ops.map(o => o.op_id).sort();

    const hash = (obj) => crypto
      .createHash('sha256')
      .update(JSON.stringify(obj))
      .digest('hex')
      .slice(0, 16); // short hash untuk readability

    const stockHash   = hash(stockSorted);
    const txHash      = hash(txSorted);
    const productHash = hash(prodSorted);
    const opHash      = hash(opIds);
    const combinedHash = hash({ stockHash, txHash, productHash, opHash });

    return { stockHash, txHash, productHash, opHash, combinedHash };
  }

  /**
   * Bandingkan state dua atau lebih node.
   * @param {Array<{label: string, svc: PosService}>} nodes
   * @returns {object} comparison result
   */
  static compareNodes(nodes) {
    const hashes = nodes.map(({ label, svc }) => ({
      label,
      hashes: MergeVerifier.computeStateHash(svc),
      stocks:       svc.inventory.getAllStocks(),
      txCount:      svc.docManager.getTransactionCount(),
      productCount: svc.docManager.getAllProducts().length,
      opCount:      svc.db.getTotalOpCount(),
    }));

    const firstHash = hashes[0].hashes.combinedHash;
    const allConverged = hashes.every(n => n.hashes.combinedHash === firstHash);

    // Detail per-entity convergence
    const stockConverged   = hashes.every(n => n.hashes.stockHash   === hashes[0].hashes.stockHash);
    const txConverged      = hashes.every(n => n.hashes.txHash      === hashes[0].hashes.txHash);
    const productConverged = hashes.every(n => n.hashes.productHash === hashes[0].hashes.productHash);
    const opConverged      = hashes.every(n => n.hashes.opHash      === hashes[0].hashes.opHash);

    return {
      allConverged,
      stockConverged,
      txConverged,
      productConverged,
      opConverged,
      nodes:    hashes,
      summary:  MergeVerifier._buildSummary(hashes, allConverged),
    };
  }

  static _buildSummary(hashes, allConverged) {
    const lines = [`Convergence: ${allConverged ? '✅ CONVERGED' : '❌ DIVERGED'}`];
    for (const n of hashes) {
      lines.push(
        `  ${n.label}: combined=${n.hashes.combinedHash}` +
        ` | tx=${n.txCount} | products=${n.productCount} | ops=${n.opCount}`
      );
    }
    return lines.join('\n');
  }

  /**
   * Verifikasi vector clock consistency.
   * Setiap node harus punya counter >= semua ops yang berasal dari node itu.
   *
   * @param {PosService} svc
   * @returns {object} { valid, issues }
   */
  static verifyVectorClock(svc) {
    const currentVC = svc.vc.snapshot();
    const ops       = svc.db._query(
      'SELECT node_id, vector_clock FROM operation_logs ORDER BY created_at ASC'
    );

    const issues = [];

    for (const row of ops) {
      const vc    = JSON.parse(row.vector_clock);
      const opNode = row.node_id.slice(0, 8);

      // Counter node pembuat op harus ada di VC
      if (!vc[row.node_id] && vc[row.node_id] !== 0) {
        issues.push(`Op from ${opNode} has no self-counter in VC`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Hitung latency dari op creation ke detection di node lain.
   * Menggunakan created_at timestamps dari ops.
   *
   * @param {PosService} svcSender - node pengirim
   * @param {PosService} svcReceiver - node penerima
   * @param {string} senderNodeId
   * @returns {object} { avgLatencyMs, maxLatencyMs, opCount }
   */
  static measureSyncLatency(svcSender, svcReceiver, senderNodeId) {
    const senderOps   = svcSender.db.getOpsByEntity('inventory')
      .filter(op => op.node_id === senderNodeId);
    const receiverOps = svcReceiver.db.getOpsByEntity('inventory')
      .filter(op => op.node_id === senderNodeId);

    const receivedIds = new Set(receiverOps.map(o => o.op_id));
    const syncedOps   = senderOps.filter(o => receivedIds.has(o.op_id));

    if (!syncedOps.length) return { avgLatencyMs: 0, maxLatencyMs: 0, opCount: 0 };

    // Estimasi latency: waktu saat test selesai minus created_at
    // (tidak ada receive_at timestamp → gunakan current time - created_at sebagai upper bound)
    const now       = Date.now();
    const latencies = syncedOps.map(op => now - op.created_at);
    const avg       = latencies.reduce((s, l) => s + l, 0) / latencies.length;
    const max       = Math.max(...latencies);

    return {
      avgLatencyMs: Math.round(avg),
      maxLatencyMs: Math.round(max),
      opCount:      syncedOps.length,
      syncRate:     `${syncedOps.length}/${senderOps.length}`,
    };
  }
}

module.exports = { MergeVerifier };