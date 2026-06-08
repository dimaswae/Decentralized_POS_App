/**
 * electron/sync/protocol.js
 * Sync Protocol — Message Types & Builders
 *
 * Format pesan: { type, from, payload, ts }
 *
 * RELAY MESSAGES (Node ↔ Relay):
 *   REGISTER, REGISTER_ACK, GET_PEERS, PEER_LIST,
 *   PEER_JOINED, PEER_LEFT, HEARTBEAT, HEARTBEAT_ACK
 *
 * SYNC MESSAGES (Node ↔ Node, direct):
 *   HELLO, HELLO_ACK, SYNC_REQUEST, SYNC_PUSH,
 *   SYNC_OPS, SYNC_ACK, SYNC_DONE, PING, PONG, ERROR
 */

'use strict';

const MSG = {
  REGISTER: 'REGISTER', REGISTER_ACK: 'REGISTER_ACK',
  GET_PEERS: 'GET_PEERS', PEER_LIST: 'PEER_LIST',
  PEER_JOINED: 'PEER_JOINED', PEER_LEFT: 'PEER_LEFT',
  HEARTBEAT: 'HEARTBEAT', HEARTBEAT_ACK: 'HEARTBEAT_ACK',
  HELLO: 'HELLO', HELLO_ACK: 'HELLO_ACK',
  SYNC_REQUEST: 'SYNC_REQUEST', SYNC_PUSH: 'SYNC_PUSH',
  SYNC_OPS: 'SYNC_OPS', SYNC_ACK: 'SYNC_ACK',
  SYNC_DONE: 'SYNC_DONE', PING: 'PING', PONG: 'PONG', ERROR: 'ERROR',
};

function build(type, fromNodeId, payload = {}) {
  return JSON.stringify({ type, from: fromNodeId, payload, ts: Date.now() });
}

function parse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

// Relay
const mkRegister     = (nodeId, wsPort) => build(MSG.REGISTER, nodeId, { node_id: nodeId, ws_port: wsPort });
const mkRegisterAck  = (relayId, nodeId, peers) => build(MSG.REGISTER_ACK, relayId, { node_id: nodeId, peers });
const mkGetPeers     = (nodeId) => build(MSG.GET_PEERS, nodeId, {});
const mkPeerList     = (relayId, peers) => build(MSG.PEER_LIST, relayId, { peers });
const mkPeerJoined   = (relayId, peer) => build(MSG.PEER_JOINED, relayId, { peer });
const mkPeerLeft     = (relayId, nodeId) => build(MSG.PEER_LEFT, relayId, { node_id: nodeId });
const mkHeartbeat    = (nodeId) => build(MSG.HEARTBEAT, nodeId, {});
const mkHeartbeatAck = (relayId, nodeId) => build(MSG.HEARTBEAT_ACK, relayId, { to: nodeId });

// Sync
const mkHello       = (nodeId, vectorClock, allHeads, lastOpId) =>
  build(MSG.HELLO, nodeId, { node_id: nodeId, vector_clock: vectorClock, heads: allHeads, last_op_id: lastOpId });
const mkHelloAck    = (nodeId, vectorClock, allHeads, lastOpId) =>
  build(MSG.HELLO_ACK, nodeId, { node_id: nodeId, vector_clock: vectorClock, heads: allHeads, last_op_id: lastOpId });
const mkSyncRequest = (nodeId, docId, sinceHeads) =>
  build(MSG.SYNC_REQUEST, nodeId, { doc_id: docId, since_heads: sinceHeads });
const mkSyncPush    = (nodeId, docId, changes) =>
  build(MSG.SYNC_PUSH, nodeId, { doc_id: docId, changes: changes.map(c => Array.from(c)) });
const mkSyncOps     = (nodeId, ops) => build(MSG.SYNC_OPS, nodeId, { ops });
const mkSyncAck     = (nodeId, docId, newHeads) =>
  build(MSG.SYNC_ACK, nodeId, { doc_id: docId, new_heads: newHeads });
const mkSyncDone    = (nodeId, vectorClock) => build(MSG.SYNC_DONE, nodeId, { vector_clock: vectorClock });
const mkPing        = (nodeId) => build(MSG.PING, nodeId, { ts: Date.now() });
const mkPong        = (nodeId, pingTs) => build(MSG.PONG, nodeId, { ping_ts: pingTs, ts: Date.now() });
const mkError       = (fromId, code, message) => build(MSG.ERROR, fromId, { code, message });

function decodeChanges(encoded) {
  if (!Array.isArray(encoded)) return [];
  return encoded.map(arr => new Uint8Array(arr));
}

module.exports = {
  MSG, parse,
  mkRegister, mkRegisterAck, mkGetPeers, mkPeerList, mkPeerJoined, mkPeerLeft,
  mkHeartbeat, mkHeartbeatAck,
  mkHello, mkHelloAck, mkSyncRequest, mkSyncPush, mkSyncOps,
  mkSyncAck, mkSyncDone, mkPing, mkPong, mkError,
  decodeChanges,
};