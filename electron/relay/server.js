/**
 * relay/server.js
 * Bootstrap Relay Server
 *
 * Fungsi TERBATAS:
 *  - Peer registry (in-memory, tidak persisten)
 *  - Peer discovery
 *  - Broadcast PEER_JOINED / PEER_LEFT
 *  - Heartbeat keepalive
 *
 * TIDAK menyimpan business data apapun.
 * Setelah peer discovery → sync langsung antar node (relay tidak terlibat).
 */

'use strict';

const WebSocket = require('ws');
const { MSG, parse, mkRegisterAck, mkPeerList, mkPeerJoined, mkPeerLeft, mkHeartbeatAck, mkError } = require('../electron/sync/protocol');

const RELAY_ID          = 'relay-server';
const HEARTBEAT_TIMEOUT = 30000; // 30s tanpa heartbeat → anggap mati

class RelayServer {
  constructor(port = 9000) {
    this.port  = port;
    this.peers = new Map(); // node_id → { ws, ws_url, last_seen, node_id }
    this.wss   = null;
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('connection', (ws, req) => {
      const remoteIp = req.socket.remoteAddress;
      console.log(`[Relay] New connection from ${remoteIp}`);

      ws._nodeId = null; // set saat REGISTER

      ws.on('message', (raw) => this._handleMessage(ws, raw, remoteIp));

      ws.on('close', () => {
        if (ws._nodeId) {
          this._removePeer(ws._nodeId);
        }
      });

      ws.on('error', (err) => {
        console.error(`[Relay] WS error (${ws._nodeId || 'unregistered'}):`, err.message);
      });
    });

    // Interval: bersihkan peer yang tidak heartbeat
    this._cleanupInterval = setInterval(() => this._cleanupStale(), 15000);

    console.log(`[Relay] Bootstrap relay listening on ws://localhost:${this.port}`);
    return this;
  }

  _handleMessage(ws, raw, remoteIp) {
    const msg = parse(raw);
    if (!msg) {
      ws.send(mkError(RELAY_ID, 'PARSE_ERROR', 'Invalid JSON'));
      return;
    }

    switch (msg.type) {
      case MSG.REGISTER:
        this._handleRegister(ws, msg, remoteIp);
        break;

      case MSG.GET_PEERS:
        this._handleGetPeers(ws, msg);
        break;

      case MSG.HEARTBEAT:
        this._handleHeartbeat(ws, msg);
        break;

      default:
        // Relay tidak handle sync messages — arahkan node untuk direct connect
        ws.send(mkError(RELAY_ID, 'UNSUPPORTED', `Relay tidak handle: ${msg.type}. Gunakan direct peer connection.`));
    }
  }

  _handleRegister(ws, msg, remoteIp) {
    const { node_id, ws_port } = msg.payload;
    if (!node_id) {
      ws.send(mkError(RELAY_ID, 'MISSING_NODE_ID', 'node_id wajib'));
      return;
    }

    // Jika node_id sudah ada → update (reconnect)
    if (this.peers.has(node_id)) {
      const old = this.peers.get(node_id);
      // Tutup koneksi lama jika masih open
      if (old.ws !== ws && old.ws.readyState === WebSocket.OPEN) {
        old.ws.close(1000, 'Replaced by new connection');
      }
    }

    const wsUrl = `ws://${remoteIp.replace('::ffff:', '').replace('::1', '127.0.0.1')}:${ws_port || 8080}`;

    const peerInfo = { ws, ws_url: wsUrl, last_seen: Date.now(), node_id };
    this.peers.set(node_id, peerInfo);
    ws._nodeId = node_id;

    // Kirim ACK + daftar peer yang sudah ada
    const currentPeers = this._getPeerList(node_id);
    ws.send(mkRegisterAck(RELAY_ID, node_id, currentPeers));

    // Broadcast ke peer lain: ada node baru
    this._broadcast(mkPeerJoined(RELAY_ID, { node_id, ws_url: wsUrl }), node_id);

    console.log(`[Relay] Registered: ${node_id} @ ${wsUrl} | Total peers: ${this.peers.size}`);
  }

  _handleGetPeers(ws, msg) {
    const nodeId = msg.from;
    const peers  = this._getPeerList(nodeId);
    ws.send(mkPeerList(RELAY_ID, peers));
  }

  _handleHeartbeat(ws, msg) {
    const nodeId = msg.from;
    if (this.peers.has(nodeId)) {
      this.peers.get(nodeId).last_seen = Date.now();
    }
    ws.send(mkHeartbeatAck(RELAY_ID, nodeId));
  }

  _getPeerList(excludeNodeId) {
    return Array.from(this.peers.values())
      .filter(p => p.node_id !== excludeNodeId)
      .map(p => ({ node_id: p.node_id, ws_url: p.ws_url, last_seen: p.last_seen }));
  }

  _broadcast(message, excludeNodeId = null) {
    for (const [nodeId, peer] of this.peers) {
      if (nodeId === excludeNodeId) continue;
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(message);
      }
    }
  }

  _removePeer(nodeId) {
    if (!this.peers.has(nodeId)) return;
    this.peers.delete(nodeId);
    this._broadcast(mkPeerLeft(RELAY_ID, nodeId));
    console.log(`[Relay] Peer left: ${nodeId} | Remaining: ${this.peers.size}`);
  }

  _cleanupStale() {
    const now     = Date.now();
    const stale   = [];
    for (const [nodeId, peer] of this.peers) {
      if (now - peer.last_seen > HEARTBEAT_TIMEOUT) {
        stale.push(nodeId);
      }
    }
    for (const nodeId of stale) {
      console.log(`[Relay] Stale peer removed: ${nodeId}`);
      this._removePeer(nodeId);
    }
  }

  getPeerCount() { return this.peers.size; }

  stop() {
    clearInterval(this._cleanupInterval);
    if (this.wss) {
      this.wss.close();
      console.log('[Relay] Server stopped.');
    }
  }
}

module.exports = { RelayServer };

// Jalankan langsung jika dipanggil sebagai script
if (require.main === module) {
  const port = parseInt(process.env.RELAY_PORT || '9000', 10);
  const relay = new RelayServer(port);
  relay.start();

  process.on('SIGINT', () => {
    relay.stop();
    process.exit(0);
  });
}