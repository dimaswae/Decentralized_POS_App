/**
 * electron/sync/sync-engine.js
 * Sync Engine — Koordinator sinkronisasi per POS node
 *
 * Tanggung jawab:
 *  1. Connect ke bootstrap relay → peer discovery
 *  2. Terima daftar peer → buka direct WS connection ke tiap peer
 *  3. Jalankan sync protocol (HELLO → SYNC_PUSH → SYNC_OPS → SYNC_DONE)
 *  4. Expose WebSocket server untuk menerima koneksi dari peer lain
 *  5. Heartbeat ke relay
 *  6. Queue sync saat offline, drain saat online
 *
 * State machine per peer connection:
 *  DISCONNECTED → CONNECTING → HANDSHAKING → SYNCING → SYNCED → IDLE
 */

'use strict';

const WebSocket = require('ws');
const {
  MSG, parse,
  mkRegister, mkGetPeers, mkHeartbeat,
  mkHello, mkHelloAck,
  mkSyncPush, mkSyncOps, mkSyncAck, mkSyncDone,
  mkPing, mkPong, mkError,
  decodeChanges,
} = require('./protocol');

const DOC_IDS = ['products', 'transactions', 'users'];

function _broadcastSync(engine) {
  try {
    const { BrowserWindow } = require('electron');
    const payload = {
      peerNodeId: null,
      node_id:    engine.nodeId,
      timestamp:  Date.now(),
    };
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.webContents.send('pos:sync', payload);
        w.webContents.send('pos:products-updated', null);
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* not in Electron context (tests) */ }
}

// State machine states
const PEER_STATE = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING:   'CONNECTING',
  HANDSHAKING:  'HANDSHAKING',
  SYNCING:      'SYNCING',
  SYNCED:       'SYNCED',
  IDLE:         'IDLE',
};

class SyncEngine {
  /**
   * @param {PosService} posService
   * @param {string} nodeId
   * @param {object} opts
   * @param {number} opts.listenPort   - port WS server node ini
   * @param {string} opts.relayUrl     - URL bootstrap relay
   * @param {number} opts.syncInterval - interval sync background (ms)
   */
  constructor(posService, nodeId, opts = {}) {
    this.posService    = posService;
    this.nodeId        = nodeId;
    this.listenPort    = opts.listenPort    || 8080;
    this.relayUrl      = opts.relayUrl      || 'ws://localhost:9000';
    this.syncInterval  = opts.syncInterval  || 30000;

    this.relayWs       = null;          // WS ke relay
    this.peerServer    = null;          // WS server (menerima koneksi masuk)
    this.peerConns     = new Map();     // node_id → { ws, state, ws_url }
    this.knownPeers    = new Map();     // node_id → { ws_url, last_seen }

    this._heartbeatTimer  = null;
    this._syncTimer       = null;
    this._relayRetryTimer = null;
    this._relayReady      = false;

    // Event callbacks (opsional, untuk UI/testing)
    this.onPeerJoined   = null;
    this.onPeerLeft     = null;
    this.onSyncComplete = null;
    this.onSyncError    = null;
  }

  // ──────────────────────────────────────────────────────────────────
  // STARTUP
  // ──────────────────────────────────────────────────────────────────

  /**
   * Start sync engine:
   *  1. Buka WS server (menerima koneksi dari peer)
   *  2. Connect ke relay
   *  3. Mulai heartbeat dan background sync timer
   */
  async start() {
    await this._startPeerServer();
    this._connectToRelay();

    // Background sync: coba sync ke semua known peer secara periodik
    this._syncTimer = setInterval(() => {
      this._syncAllPeers();
    }, this.syncInterval);

    console.log(`[SyncEngine:${this._short()}] Started. Listening on :${this.listenPort}, relay: ${this.relayUrl}`);
  }

  // ──────────────────────────────────────────────────────────────────
  // PEER SERVER (menerima koneksi masuk dari peer lain)
  // ──────────────────────────────────────────────────────────────────

  _startPeerServer() {
    return new Promise((resolve) => {
      this.peerServer = new WebSocket.Server({ port: this.listenPort });

      this.peerServer.on('connection', (ws) => {
        console.log(`[SyncEngine:${this._short()}] Incoming peer connection`);
        this._handleIncomingPeer(ws);
      });

      this.peerServer.on('listening', () => {
        console.log(`[SyncEngine:${this._short()}] Peer server listening on :${this.listenPort}`);
        resolve();
      });

      this.peerServer.on('error', (err) => {
        console.error(`[SyncEngine:${this._short()}] Peer server error:`, err.message);
        resolve(); // jangan block startup
      });
    });
  }

  _handleIncomingPeer(ws) {
    ws._state   = PEER_STATE.HANDSHAKING;
    ws._nodeId  = null;

    ws.on('message', (raw) => {
      const msg = parse(raw);
      if (!msg) return;
      this._handlePeerMessage(ws, msg, /* isIncoming */ true);
    });

    ws.on('close', () => {
      if (ws._nodeId) {
        this._setPeerState(ws._nodeId, PEER_STATE.DISCONNECTED);
        console.log(`[SyncEngine:${this._short()}] Peer disconnected: ${ws._nodeId}`);
      }
    });

    ws.on('error', (err) => {
      console.error(`[SyncEngine:${this._short()}] Peer WS error:`, err.message);
    });

    // Inisiasi HELLO dari sisi penerima juga
    const { vector_clock, heads, last_op_id } = this.posService.getSyncHandshakeData();
    ws.send(mkHello(this.nodeId, vector_clock, heads, last_op_id));
  }

  // ──────────────────────────────────────────────────────────────────
  // RELAY CONNECTION
  // ──────────────────────────────────────────────────────────────────

  _connectToRelay() {
    console.log(`[SyncEngine:${this._short()}] Connecting to relay: ${this.relayUrl}`);

    try {
      this.relayWs = new WebSocket(this.relayUrl);
    } catch (err) {
      console.error(`[SyncEngine:${this._short()}] Relay connect error:`, err.message);
      this._scheduleRelayRetry();
      return;
    }

    this.relayWs.on('open', () => {
      this._relayReady = true;
      console.log(`[SyncEngine:${this._short()}] Relay connected`);
      // Register ke relay
      this.relayWs.send(mkRegister(this.nodeId, this.listenPort));
      // Mulai heartbeat
      this._startHeartbeat();
    });

    this.relayWs.on('message', (raw) => {
      const msg = parse(raw);
      if (!msg) return;
      this._handleRelayMessage(msg);
    });

    this.relayWs.on('close', () => {
      this._relayReady = false;
      console.log(`[SyncEngine:${this._short()}] Relay disconnected, will retry...`);
      this._stopHeartbeat();
      this._scheduleRelayRetry();
    });

    this.relayWs.on('error', (err) => {
      // Error akan di-follow oleh close event
      if (err.code !== 'ECONNREFUSED') {
        console.error(`[SyncEngine:${this._short()}] Relay WS error:`, err.message);
      }
    });
  }

  _scheduleRelayRetry() {
    if (this._relayRetryTimer) return;
    this._relayRetryTimer = setTimeout(() => {
      this._relayRetryTimer = null;
      this._connectToRelay();
    }, 5000);
  }

  // ──────────────────────────────────────────────────────────────────
  // RELAY MESSAGE HANDLER
  // ──────────────────────────────────────────────────────────────────

  _handleRelayMessage(msg) {
    switch (msg.type) {
      case MSG.REGISTER_ACK: {
        const { peers } = msg.payload;
        console.log(`[SyncEngine:${this._short()}] Registered. Peers: ${peers.length}`);
        for (const peer of peers) {
          this._addKnownPeer(peer.node_id, peer.ws_url);
          this._connectToPeer(peer.node_id, peer.ws_url);
        }
        break;
      }

      case MSG.PEER_LIST: {
        const { peers } = msg.payload;
        for (const peer of peers) {
          this._addKnownPeer(peer.node_id, peer.ws_url);
          if (!this._isPeerConnected(peer.node_id)) {
            this._connectToPeer(peer.node_id, peer.ws_url);
          }
        }
        break;
      }

      case MSG.PEER_JOINED: {
        const { peer } = msg.payload;
        console.log(`[SyncEngine:${this._short()}] Peer joined: ${peer.node_id}`);
        this._addKnownPeer(peer.node_id, peer.ws_url);
        this._connectToPeer(peer.node_id, peer.ws_url);
        if (this.onPeerJoined) this.onPeerJoined(peer.node_id);
        break;
      }

      case MSG.PEER_LEFT: {
        const { node_id } = msg.payload;
        console.log(`[SyncEngine:${this._short()}] Peer left: ${node_id}`);
        this._setPeerState(node_id, PEER_STATE.DISCONNECTED);
        if (this.onPeerLeft) this.onPeerLeft(node_id);
        break;
      }

      case MSG.HEARTBEAT_ACK:
        break; // nothing to do

      case MSG.ERROR:
        console.error(`[SyncEngine:${this._short()}] Relay error:`, msg.payload);
        break;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // PEER CONNECTION (outgoing)
  // ──────────────────────────────────────────────────────────────────

  _connectToPeer(peerNodeId, wsUrl) {
    if (peerNodeId === this.nodeId) return;
    if (this._isPeerConnected(peerNodeId)) return;

    this._setPeerState(peerNodeId, PEER_STATE.CONNECTING);
    console.log(`[SyncEngine:${this._short()}] Connecting to peer: ${peerNodeId} @ ${wsUrl}`);

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error(`[SyncEngine:${this._short()}] Cannot connect to peer ${peerNodeId}:`, err.message);
      this._setPeerState(peerNodeId, PEER_STATE.DISCONNECTED);
      return;
    }

    // Simpan ke peerConns
    this.peerConns.set(peerNodeId, { ws, state: PEER_STATE.CONNECTING, ws_url: wsUrl });
    ws._nodeId = peerNodeId;
    ws._state  = PEER_STATE.CONNECTING;

    ws.on('open', () => {
      ws._state = PEER_STATE.HANDSHAKING;
      this._setPeerState(peerNodeId, PEER_STATE.HANDSHAKING);
      // Kirim HELLO
      const { vector_clock, heads, last_op_id } = this.posService.getSyncHandshakeData();
      ws.send(mkHello(this.nodeId, vector_clock, heads, last_op_id));
      console.log(`[SyncEngine:${this._short()}] HELLO sent to ${peerNodeId}`);
    });

    ws.on('message', (raw) => {
      const msg = parse(raw);
      if (!msg) return;
      this._handlePeerMessage(ws, msg, /* isIncoming */ false);
    });

    ws.on('close', () => {
      this._setPeerState(peerNodeId, PEER_STATE.DISCONNECTED);
      console.log(`[SyncEngine:${this._short()}] Peer connection closed: ${peerNodeId}`);
    });

    ws.on('error', (err) => {
      if (err.code !== 'ECONNREFUSED') {
        console.error(`[SyncEngine:${this._short()}] Peer ${peerNodeId} error:`, err.message);
      }
      this._setPeerState(peerNodeId, PEER_STATE.DISCONNECTED);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // PEER MESSAGE HANDLER (sync protocol)
  // ──────────────────────────────────────────────────────────────────

  _handlePeerMessage(ws, msg, isIncoming) {
    const fromNodeId = msg.from;
    if (!fromNodeId) return;

    // Set nodeId pada ws jika belum (koneksi masuk)
    if (isIncoming && !ws._nodeId) {
      ws._nodeId = fromNodeId;
      this.peerConns.set(fromNodeId, { ws, state: PEER_STATE.HANDSHAKING, ws_url: null });
    }

    switch (msg.type) {
      case MSG.HELLO:
        this._onHello(ws, msg);
        break;

      case MSG.HELLO_ACK:
        this._onHelloAck(ws, msg);
        break;

      case MSG.SYNC_PUSH:
        this._onSyncPush(ws, msg);
        break;

      case MSG.SYNC_OPS:
        this._onSyncOps(ws, msg);
        break;

      case MSG.SYNC_ACK:
        this._onSyncAck(ws, msg);
        break;

      case MSG.SYNC_DONE:
        this._onSyncDone(ws, msg);
        break;

      case MSG.PING:
        ws.send(mkPong(this.nodeId, msg.payload.ts));
        break;

      case MSG.PONG:
        break; // bisa digunakan untuk latency measurement

      case MSG.ERROR:
        console.error(`[SyncEngine:${this._short()}] Peer error from ${fromNodeId}:`, msg.payload);
        break;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // SYNC PROTOCOL HANDLERS
  // ──────────────────────────────────────────────────────────────────

  /**
   * Terima HELLO dari peer → balas dengan HELLO_ACK + mulai push changes.
   */
  _onHello(ws, msg) {
    const peerNodeId    = msg.from;
    const peerHeads     = msg.payload.heads     || {};
    const peerVc        = msg.payload.vector_clock || {};
    const peerLastOpId  = msg.payload.last_op_id;

    console.log(`[SyncEngine:${this._short()}] HELLO from ${peerNodeId}`);
    this._setPeerState(peerNodeId, PEER_STATE.SYNCING);

    // Kirim HELLO_ACK
    const { vector_clock, heads, last_op_id } = this.posService.getSyncHandshakeData();
    ws.send(mkHelloAck(this.nodeId, vector_clock, heads, last_op_id));

    // Push semua changes yang peer belum punya (berdasarkan peerHeads)
    this._pushChangesToPeer(ws, peerNodeId, peerHeads);

    // Push ops yang peer belum punya (untuk inventory)
    this._pushOpsToPeer(ws, peerNodeId, peerLastOpId);
  }

  /**
   * Terima HELLO_ACK dari peer → mulai push changes ke arah lain.
   */
  _onHelloAck(ws, msg) {
    const peerNodeId   = msg.from;
    const peerHeads    = msg.payload.heads       || {};
    const peerLastOpId = msg.payload.last_op_id;

    console.log(`[SyncEngine:${this._short()}] HELLO_ACK from ${peerNodeId}`);
    this._setPeerState(peerNodeId, PEER_STATE.SYNCING);

    // Push changes ke peer
    this._pushChangesToPeer(ws, peerNodeId, peerHeads);
    this._pushOpsToPeer(ws, peerNodeId, peerLastOpId);
  }

  /**
   * Kirim Automerge changesets untuk semua doc ke peer.
   * @param {object} peerHeads - { docId: heads[] }
   */
  _pushChangesToPeer(ws, peerNodeId, peerHeads) {
    for (const docId of DOC_IDS) {
      const sinceHeads = peerHeads[docId] || [];
      let changes;
      try {
        changes = this.posService.getChangesForPeer(docId, sinceHeads);
      } catch (err) {
        console.error(`[SyncEngine:${this._short()}] getChangesForPeer error (${docId}):`, err.message);
        continue;
      }

      if (changes && changes.length > 0) {
        ws.send(mkSyncPush(this.nodeId, docId, changes));
        console.log(`[SyncEngine:${this._short()}] SYNC_PUSH → ${peerNodeId}: ${docId} (${changes.length} changes)`);
      }
    }
  }

  /**
   * Kirim operation logs yang peer belum punya.
   */
  _pushOpsToPeer(ws, peerNodeId, peerLastOpId) {
    const ops = this.posService.db.getOpsAfter(peerLastOpId, 500);
    if (ops.length > 0) {
      ws.send(mkSyncOps(this.nodeId, ops));
      console.log(`[SyncEngine:${this._short()}] SYNC_OPS → ${peerNodeId}: ${ops.length} ops`);
    }
  }

  /**
   * Terima SYNC_PUSH → apply Automerge changes.
   */
  _onSyncPush(ws, msg) {
    const { doc_id, changes: encodedChanges } = msg.payload;
    const peerNodeId = msg.from;

    const changes = decodeChanges(encodedChanges);
    if (!changes.length) return;

    console.log(`[SyncEngine:${this._short()}] SYNC_PUSH ← ${peerNodeId}: ${doc_id} (${changes.length} changes)`);

    const { newDoc, error } = this.posService.applyPeerChanges(doc_id, changes);

    if (error) {
      ws.send(mkError(this.nodeId, 'APPLY_CHANGES_FAILED', error));
      return;
    }

    // Kirim ACK dengan heads terbaru
    const newHeads = this.posService.docManager.getHeads(doc_id);
    ws.send(mkSyncAck(this.nodeId, doc_id, newHeads));
  }

  /**
   * Terima SYNC_OPS → apply operation logs (inventory + audit).
   */
  _onSyncOps(ws, msg) {
    const { ops }    = msg.payload;
    const peerNodeId = msg.from;

    if (!ops || !ops.length) return;

    console.log(`[SyncEngine:${this._short()}] SYNC_OPS ← ${peerNodeId}: ${ops.length} ops`);

    const { applied, anomalies } = this.posService.applyPeerOps(ops);

    if (anomalies.length) {
      console.warn(`[SyncEngine:${this._short()}] ⚠️  Negative stock after sync:`, anomalies);
    }

    // Update sync metadata
    const lastOp = ops[ops.length - 1];
    this.posService.db.upsertSyncMeta(peerNodeId, {
      last_sync_at: Date.now(),
      last_op_id:   lastOp.op_id,
      sync_state:   'synced',
    });
  }

  /**
   * Terima SYNC_ACK → update sync metadata peer.
   */
  _onSyncAck(ws, msg) {
    const { doc_id, new_heads } = msg.payload;
    const peerNodeId = msg.from;

    console.log(`[SyncEngine:${this._short()}] SYNC_ACK ← ${peerNodeId}: ${doc_id}`);

    // Update known heads untuk peer ini
    const existing = this.posService.db.getSyncMeta(peerNodeId) || {};
    this.posService.db.upsertSyncMeta(peerNodeId, {
      ...existing,
      last_sync_at: Date.now(),
      sync_state:   'synced',
    });
  }

  /**
   * Terima SYNC_DONE → sync selesai dari peer.
   */
  _onSyncDone(ws, msg) {
    const peerNodeId  = msg.from;
    const peerVc      = msg.payload.vector_clock;

    console.log(`[SyncEngine:${this._short()}] SYNC_DONE ← ${peerNodeId} ✅`);
    this._setPeerState(peerNodeId, PEER_STATE.SYNCED);

    // Merge vector clock dari peer
    if (peerVc) this.posService.vc.merge(peerVc);

    // Balas dengan SYNC_DONE juga (bilateral confirmation)
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(mkSyncDone(this.nodeId, this.posService.vc.snapshot()));
    }

    if (this.onSyncComplete) {
      this.onSyncComplete(peerNodeId);
    }
    _broadcastSync(this);
  }

  // ──────────────────────────────────────────────────────────────────
  // BACKGROUND SYNC
  // ──────────────────────────────────────────────────────────────────

  /**
   * Coba sync ke semua known peer.
   * Dipanggil oleh interval timer.
   */
  _syncAllPeers() {
    for (const [nodeId, peerInfo] of this.knownPeers) {
      if (!this._isPeerConnected(nodeId)) {
        // Coba reconnect
        this._connectToPeer(nodeId, peerInfo.ws_url);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // HEARTBEAT
  // ──────────────────────────────────────────────────────────────────

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
        this.relayWs.send(mkHeartbeat(this.nodeId));
      }
    }, 10000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────

  _addKnownPeer(nodeId, wsUrl) {
    if (nodeId === this.nodeId) return;
    this.knownPeers.set(nodeId, { ws_url: wsUrl, last_seen: Date.now() });
  }

  _isPeerConnected(nodeId) {
    const conn = this.peerConns.get(nodeId);
    if (!conn) return false;
    return conn.ws.readyState === WebSocket.OPEN &&
           conn.state !== PEER_STATE.DISCONNECTED;
  }

  _setPeerState(nodeId, state) {
    const conn = this.peerConns.get(nodeId);
    if (conn) {
      conn.state    = state;
      conn.ws._state = state;
    }
  }

  _short() {
    return this.nodeId.substring(0, 8);
  }

  getStatus() {
    const peers = {};
    for (const [nodeId, conn] of this.peerConns) {
      peers[nodeId] = {
        state:     conn.state,
        ws_status: conn.ws.readyState,
        ws_url:    conn.ws_url,
      };
    }
    return {
      node_id:     this.nodeId,
      relay_ready: this._relayReady,
      known_peers: this.knownPeers.size,
      connections: peers,
    };
  }

  stop() {
    this._stopHeartbeat();
    if (this._syncTimer)       clearInterval(this._syncTimer);
    if (this._relayRetryTimer) clearTimeout(this._relayRetryTimer);

    if (this.relayWs) {
      this.relayWs.removeAllListeners();
      this.relayWs.close();
    }

    for (const [, conn] of this.peerConns) {
      conn.ws.removeAllListeners();
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close();
    }

    if (this.peerServer) this.peerServer.close();
    console.log(`[SyncEngine:${this._short()}] Stopped.`);
  }
}

module.exports = { SyncEngine, PEER_STATE };