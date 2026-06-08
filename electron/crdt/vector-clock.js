/**
 * electron/crdt/vector-clock.js
 * Vector Clock Manager
 *
 * Digunakan untuk melacak kausalitas antar operasi di semua node.
 *
 * Aturan:
 *  - Setiap operasi → increment counter node sendiri
 *  - Terima op dari peer → merge: max(own[k], peer[k]) untuk tiap k
 *  - A happened-before B: A[k] <= B[k] untuk semua k
 *  - Concurrent: tidak ada dominasi → Automerge merge otomatis
 */

'use strict';

class VectorClock {
  /**
   * @param {string} nodeId - ID node lokal
   * @param {object} initial - state awal { nodeId: counter }
   */
  constructor(nodeId, initial = {}) {
    this.nodeId = nodeId;
    this.clock  = { ...initial };
    if (!this.clock[nodeId]) {
      this.clock[nodeId] = 0;
    }
  }

  /**
   * Increment counter node lokal sebelum mengirim operasi.
   * @returns {object} snapshot clock setelah increment
   */
  tick() {
    this.clock[this.nodeId] = (this.clock[this.nodeId] || 0) + 1;
    return this.snapshot();
  }

  /**
   * Merge dengan vector clock dari peer.
   * Ambil max di setiap komponen.
   * @param {object} remoteClock - clock dari peer
   */
  merge(remoteClock) {
    for (const [nodeId, counter] of Object.entries(remoteClock)) {
      this.clock[nodeId] = Math.max(
        this.clock[nodeId] || 0,
        counter
      );
    }
  }

  /**
   * Cek apakah operasi A happened-before B.
   * @param {object} clockA
   * @param {object} clockB
   * @returns {boolean}
   */
  static happenedBefore(clockA, clockB) {
    const allNodes = new Set([...Object.keys(clockA), ...Object.keys(clockB)]);
    let strictlyLess = false;

    for (const node of allNodes) {
      const a = clockA[node] || 0;
      const b = clockB[node] || 0;
      if (a > b) return false;
      if (a < b) strictlyLess = true;
    }

    return strictlyLess;
  }

  /**
   * Cek apakah dua operasi concurrent (tidak ada happened-before).
   * @param {object} clockA
   * @param {object} clockB
   * @returns {boolean}
   */
  static isConcurrent(clockA, clockB) {
    return (
      !VectorClock.happenedBefore(clockA, clockB) &&
      !VectorClock.happenedBefore(clockB, clockA)
    );
  }

  /**
   * Snapshot clock saat ini (deep copy).
   * @returns {object}
   */
  snapshot() {
    return { ...this.clock };
  }

  /**
   * Load dari snapshot (setelah restart dari DB).
   * @param {object} snapshot
   */
  load(snapshot) {
    this.clock = { ...snapshot };
    if (!this.clock[this.nodeId]) {
      this.clock[this.nodeId] = 0;
    }
  }

  toString() {
    return JSON.stringify(this.clock);
  }
}

module.exports = { VectorClock };