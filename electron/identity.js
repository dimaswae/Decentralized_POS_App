/**
 * electron/identity.js
 * Node Identity Manager
 *
 * Tanggung jawab:
 *  - Generate UUID v4 sebagai node_id saat pertama kali instalasi
 *  - Persist node_id ke device_config (SQLite) — immutable setelah dibuat
 *  - Expose node_id ke seluruh aplikasi
 *
 * Prinsip:
 *  - node_id === Automerge actor_id
 *  - Tidak pernah berubah sepanjang lifetime instalasi
 *  - Unik secara global (UUID v4)
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

let _nodeId = null;

/**
 * Initialize node identity dari database.
 * Jika belum ada → generate UUID v4 baru dan simpan.
 *
 * @param {object} db - instance Database (dari db/index.js)
 * @returns {string} node_id
 */
function initNodeIdentity(db) {
  const existing = db.getConfig('node_id');

  if (existing) {
    _nodeId = existing;
    console.log(`[Identity] Node ID loaded: ${_nodeId}`);
  } else {
    _nodeId = uuidv4();
    db.setConfig('node_id', _nodeId);
    console.log(`[Identity] Node ID generated: ${_nodeId}`);
  }

  return _nodeId;
}

/**
 * Get current node_id.
 * Harus dipanggil setelah initNodeIdentity().
 *
 * @returns {string} node_id
 */
function getNodeId() {
  if (!_nodeId) {
    throw new Error('[Identity] Node ID belum diinisialisasi. Panggil initNodeIdentity() terlebih dahulu.');
  }
  return _nodeId;
}

/**
 * Get node_id yang aman (tidak throw, kembalikan null jika belum init).
 * Digunakan untuk logging awal.
 *
 * @returns {string|null}
 */
function getNodeIdSafe() {
  return _nodeId;
}

module.exports = { initNodeIdentity, getNodeId, getNodeIdSafe };