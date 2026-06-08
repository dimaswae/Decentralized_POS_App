/**
 * tests/run.js
 * Test Runner — Phase 3 Validation
 *
 * Menjalankan semua test secara sequential.
 * Output: PASS / FAIL per test case.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── Test helper ─────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
    results.push({ label, ok: true });
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
    results.push({ label, ok: false });
  }
}

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
    results.push({ label, ok: true });
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    console.error(`     expected: ${JSON.stringify(expected)}`);
    console.error(`     actual:   ${JSON.stringify(actual)}`);
    failed++;
    results.push({ label, ok: false });
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(55)}`);
}

// ─── Test: Database ───────────────────────────────────────────────
async function testDatabase(db) {
  section('TEST SUITE: Database');

  // device_config
  db.setConfig('test_key', 'test_value');
  assertEq(db.getConfig('test_key'), 'test_value', 'setConfig / getConfig');

  db.setConfig('test_key', 'updated_value');
  assertEq(db.getConfig('test_key'), 'updated_value', 'setConfig overwrite (REPLACE)');

  assertEq(db.getConfig('nonexistent'), null, 'getConfig nonexistent → null');

  // operation_logs
  const { v4: uuidv4 } = require('uuid');
  const op1 = {
    op_id:        uuidv4(),
    node_id:      'node-test',
    entity_type:  'inventory',
    op_type:      'stock_init',
    payload:      { product_id: 'prod-1', delta: 100 },
    vector_clock: { 'node-test': 1 },
    created_at:   Date.now(),
  };
  db.insertOp(op1);

  const ops = db.getOpsByEntity('inventory');
  assert(ops.length >= 1, 'insertOp + getOpsByEntity');
  assertEq(ops.find(o => o.op_id === op1.op_id)?.payload?.delta, 100, 'op payload preserved');

  // Idempotent insert (duplicate op_id harus diabaikan)
  db.insertOpsBatch([op1, op1]);
  const opsAfterDupe = db.getOpsByEntity('inventory');
  assertEq(
    opsAfterDupe.filter(o => o.op_id === op1.op_id).length,
    1,
    'insertOpsBatch idempotent (no duplicate)'
  );

  // Pending ops
  const pending = db.getPendingOps();
  assert(pending.some(o => o.op_id === op1.op_id), 'getPendingOps includes new op');

  // Mark synced
  db.markOpsSynced([op1.op_id]);
  const pendingAfter = db.getPendingOps();
  assert(!pendingAfter.some(o => o.op_id === op1.op_id), 'markOpsSynced removes from pending');

  // sync_metadata
  db.upsertSyncMeta('peer-node-1', {
    last_sync_at: Date.now(),
    last_op_id:   op1.op_id,
    last_heads:   ['abc123'],
    sync_state:   'synced',
  });
  const meta = db.getSyncMeta('peer-node-1');
  assert(meta !== null, 'upsertSyncMeta + getSyncMeta');
  assertEq(meta.sync_state, 'synced', 'sync_metadata sync_state correct');
  assertEq(meta.last_heads, ['abc123'], 'sync_metadata last_heads parsed correctly');

  // automerge_docs
  db.saveDoc('test_doc', new Uint8Array([1,2,3,4,5]), ['head1', 'head2']);
  const loaded = db.loadDoc('test_doc');
  assert(loaded !== null, 'saveDoc + loadDoc');
  assertEq(loaded.heads, ['head1', 'head2'], 'loadDoc heads correct');

  // summary
  const summary = db.summary();
  assert(typeof summary.totalOps === 'number', 'summary() works');
}

// ─── Test: VectorClock ────────────────────────────────────────────
function testVectorClock() {
  section('TEST SUITE: VectorClock');

  const { VectorClock } = require('../electron/crdt/vector-clock');

  const vc = new VectorClock('node-A');
  assertEq(vc.clock['node-A'], 0, 'Initial clock node-A = 0');

  const snap1 = vc.tick();
  assertEq(snap1['node-A'], 1, 'tick() increments counter');

  vc.merge({ 'node-A': 2, 'node-B': 5 });
  assertEq(vc.clock['node-A'], 2, 'merge() takes max for node-A');
  assertEq(vc.clock['node-B'], 5, 'merge() adds node-B');

  vc.tick();
  assertEq(vc.clock['node-A'], 3, 'tick() after merge increments correctly');

  // happened-before
  const clockA = { 'node-A': 1, 'node-B': 0 };
  const clockB = { 'node-A': 2, 'node-B': 1 };
  assert(VectorClock.happenedBefore(clockA, clockB), 'A happened-before B (correct)');
  assert(!VectorClock.happenedBefore(clockB, clockA), 'B not happened-before A');

  // concurrent
  const clockC = { 'node-A': 2, 'node-B': 0 };
  const clockD = { 'node-A': 0, 'node-B': 2 };
  assert(VectorClock.isConcurrent(clockC, clockD), 'C and D are concurrent');
  assert(!VectorClock.isConcurrent(clockA, clockB), 'A and B not concurrent');

  // snapshot immutability
  const snap = vc.snapshot();
  snap['node-A'] = 999;
  assert(vc.clock['node-A'] !== 999, 'snapshot() returns copy, not reference');
}

// ─── Test: InventoryProjection ────────────────────────────────────
function testInventoryProjection(db) {
  section('TEST SUITE: InventoryProjection');

  const { InventoryProjection } = require('../electron/crdt/inventory-projection');
  const { v4: uuidv4 }          = require('uuid');

  const projection = new InventoryProjection(db);

  const prodId = 'inv-test-prod-' + Date.now();

  // Stok awal
  const op1 = InventoryProjection.createStockInitOp(prodId, 50, 'node-test', { 'node-test': 1 });
  db.insertOp(op1);
  assertEq(projection.getStock(prodId), 50, 'Stock after init = 50');

  // Restock
  const op2 = InventoryProjection.createStockInOp(prodId, 20, 'Restock', 'node-test', { 'node-test': 2 });
  db.insertOp(op2);
  assertEq(projection.getStock(prodId), 70, 'Stock after restock = 70');

  // Penjualan (out)
  const op3 = InventoryProjection.createStockOutOp(prodId, 5, 'tx-001', 'node-test', { 'node-test': 3 });
  db.insertOp(op3);
  assertEq(projection.getStock(prodId), 65, 'Stock after sale of 5 = 65');

  // CRDT concurrent scenario: Node A dan B keduanya jual bersamaan (offline)
  const opA = InventoryProjection.createStockOutOp(prodId, 10, 'tx-A', 'node-A', { 'node-A': 1, 'node-B': 0 });
  const opB = InventoryProjection.createStockOutOp(prodId, 8, 'tx-B', 'node-B', { 'node-A': 0, 'node-B': 1 });
  db.insertOp(opA);
  db.insertOp(opB);
  // Setelah merge: 65 - 10 - 8 = 47
  assertEq(projection.getStock(prodId), 47, 'Concurrent CRDT: 65 - 10 - 8 = 47 (commutative, no conflict)');

  // getAllStocks
  const allStocks = projection.getAllStocks();
  assert(typeof allStocks[prodId] === 'number', 'getAllStocks() includes product');
  assertEq(allStocks[prodId], 47, 'getAllStocks() value matches getStock()');

  // history
  const history = projection.getStockHistory(prodId);
  assert(history.length >= 5, 'getStockHistory() has all ops');
  assert(history.every(h => h.product_id === undefined || h.op_id), 'history entries have op_id');

  // detectNegativeStock (force scenario)
  const negProdId = 'neg-test-' + Date.now();
  const opNeg = InventoryProjection.createStockOutOp(negProdId, 10, 'tx-neg', 'node-test', { 'node-test': 99 });
  db.insertOp(opNeg);
  const anomalies = projection.detectNegativeStock();
  assert(anomalies.some(a => a.productId === negProdId), 'detectNegativeStock() catches negative stock');
}

// ─── Test: DocManager ─────────────────────────────────────────────
async function testDocManager(db) {
  section('TEST SUITE: DocManager (Automerge)');

  const { DocManager } = require('../electron/crdt/doc-manager');

  const dm = new DocManager(db, 'test-actor-node');
  dm.init();

  // Products
  const p1 = dm.upsertProduct({ id: 'prod-dm-1', name: 'Kopi Arabika', price: 25000, category: 'minuman', unit: 'kg' });
  assert(p1.id === 'prod-dm-1', 'upsertProduct returns product');

  const retrieved = dm.getProduct('prod-dm-1');
  assertEq(retrieved.name, 'Kopi Arabika', 'getProduct() correct');
  assertEq(retrieved.price, 25000, 'getProduct() price correct');

  dm.upsertProduct({ id: 'prod-dm-1', name: 'Kopi Arabika Premium', price: 30000, category: 'minuman', unit: 'kg' });
  assertEq(dm.getProduct('prod-dm-1').price, 30000, 'upsertProduct LWW update works');

  const products = dm.getAllProducts();
  assert(products.length >= 1, 'getAllProducts() returns array');

  // Transactions (append-only)
  const tx1 = {
    id:         'tx-dm-001',
    items:      [{ product_id: 'prod-dm-1', qty: 2, price_at_sale: 30000 }],
    total:      60000,
    cashier_id: 'user-1',
    node_id:    'test-actor-node',
    created_at: Date.now(),
  };
  dm.appendTransaction(tx1);
  assertEq(dm.getTransactionCount(), 1, 'appendTransaction adds one tx');

  const txs = dm.getAllTransactions();
  assertEq(txs[0].id, 'tx-dm-001', 'getAllTransactions() correct');
  assertEq(txs[0].total, 60000, 'transaction total correct');

  // Users
  dm.upsertUser({ id: 'user-dm-1', name: 'Budi Kasir', role: 'cashier' });
  assertEq(dm.getUser('user-dm-1').name, 'Budi Kasir', 'upsertUser + getUser works');

  // Heads
  const heads = dm.getHeads('products');
  assert(Array.isArray(heads) && heads.length > 0, 'getHeads() returns non-empty array');

  const allHeads = dm.getAllHeads();
  assert(allHeads.products && allHeads.transactions && allHeads.users, 'getAllHeads() has all docs');

  // getAllChanges + applyChanges (simulate sync)
  const dm2 = new DocManager(db, 'test-actor-node-2');
  dm2.init();  // empty docs

  // Ambil semua changes dari dm1
  const changes = dm.getChangesSince('products', []);
  assert(changes.length > 0, 'getChangesSince() returns changes');

  // Apply ke dm2
  const { newDoc, patches } = dm2.applyChanges('products', changes);
  assert(newDoc !== null, 'applyChanges() returns newDoc');

  // summary
  const summary = dm.summary();
  assert(summary.products >= 1, 'summary() products count');
  assert(summary.transactions >= 1, 'summary() transactions count');
}

// ─── Test: PosService Integration ────────────────────────────────
async function testPosService(_sharedDb) {
  section('TEST SUITE: PosService (Integration)');

  // DB terisolasi — hindari kontaminasi negative stock dari suite sebelumnya
  const isolatedDbPath = '/tmp/pos-crdt-test-service.db';
  if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);
  const { Database }   = require('../electron/db/index');
  const { PosService } = require('../electron/pos-service');
  const db = new Database();
  await db.init(isolatedDbPath);

  const service = new PosService(db, 'integration-test-node');
  service.init();

  // Add product
  const product = service.addProduct({
    name:     'Gula Pasir',
    price:    15000,
    category: 'sembako',
    unit:     'kg',
  });
  assert(product.id, 'addProduct() returns product with id');
  assertEq(product.name, 'Gula Pasir', 'addProduct() name correct');

  // Init stock
  const { stock: stock1 } = service.initStock(product.id, 100, 'Stok awal');
  assertEq(stock1, 100, 'initStock() sets stock to 100');

  // Add more stock
  const { stock: stock2 } = service.addStock(product.id, 50, 'Restock batch 1');
  assertEq(stock2, 150, 'addStock() 150 total');

  // getStock
  assertEq(service.getStock(product.id), 150, 'getStock() matches');

  // Create transaction
  const product2 = service.addProduct({ name: 'Minyak Goreng', price: 20000, unit: 'liter' });
  service.initStock(product2.id, 200);

  const { transaction, ops, anomalies } = service.createTransaction({
    cashier_id: 'kasir-1',
    items: [
      { product_id: product.id,  qty: 3, price_at_sale: 15000 },
      { product_id: product2.id, qty: 2, price_at_sale: 20000 },
    ],
  });

  assert(transaction.id, 'createTransaction() returns tx with id');
  assertEq(transaction.total, 3*15000 + 2*20000, 'transaction total correct');
  assertEq(ops.length >= 3, true, 'createTransaction() creates ops (1 tx + N inventory)');
  assertEq(anomalies.length, 0, 'no negative stock anomaly');

  // Stock after transaction
  assertEq(service.getStock(product.id),  150 - 3,   'stock after tx: gula = 147');
  assertEq(service.getStock(product2.id), 200 - 2,   'stock after tx: minyak = 198');

  // getAllProducts includes stock
  const allProducts = service.getAllProducts();
  const gulaWithStock = allProducts.find(p => p.id === product.id);
  assert(gulaWithStock, 'getAllProducts() includes gula');
  assertEq(gulaWithStock.stock, 147, 'getAllProducts() stock correct');

  // getAllTransactions
  const txs = service.getAllTransactions();
  assert(txs.length >= 1, 'getAllTransactions() has tx');

  // getSystemStatus
  const status = service.getSystemStatus();
  assert(status.node_id === 'integration-test-node', 'getSystemStatus() node_id correct');
  assert(typeof status.vector_clock === 'object', 'getSystemStatus() has vector_clock');
  assert(typeof status.stocks === 'object', 'getSystemStatus() has stocks');

  // getSyncHandshakeData
  const handshake = service.getSyncHandshakeData();
  assert(handshake.node_id === 'integration-test-node', 'getSyncHandshakeData() node_id');
  assert(handshake.heads.products, 'getSyncHandshakeData() has doc heads');

  // Cleanup isolated DB
  db.close();
  if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);
}

// ─── Test: Node Identity ──────────────────────────────────────────
function testNodeIdentity(db) {
  section('TEST SUITE: Node Identity');

  const { initNodeIdentity, getNodeId, getNodeIdSafe } = require('../electron/identity');

  // First call: generate
  const nodeId = initNodeIdentity(db);
  assert(typeof nodeId === 'string' && nodeId.length === 36, 'Generated node_id is valid UUID v4');

  // Second call: load dari DB (sama)
  const nodeId2 = initNodeIdentity(db);
  assertEq(nodeId, nodeId2, 'node_id persistent across calls (idempotent)');

  // Verify tersimpan di DB
  const stored = db.getConfig('node_id');
  assertEq(stored, nodeId, 'node_id stored in device_config');

  // getNodeId
  assertEq(getNodeId(), nodeId, 'getNodeId() returns correct value');
  assertEq(getNodeIdSafe(), nodeId, 'getNodeIdSafe() returns value after init');
}

// ─── Main runner ─────────────────────────────────────────────────
async function runAll() {
  console.log('\n' + '═'.repeat(55));
  console.log('  PHASE 3 VALIDATION — Local-First POS CRDT');
  console.log('  Node.js Test Runner');
  console.log('═'.repeat(55));

  // Setup test DB (in-memory path)
  const testDbPath = '/tmp/pos-crdt-test.db';
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const { Database } = require('../electron/db/index');
  const db = new Database();
  await db.init(testDbPath);

  try {
    await testDatabase(db);
    testVectorClock();
    testInventoryProjection(db);
    await testDocManager(db);
    testNodeIdentity(db);
    await testPosService(db);
  } catch (err) {
    console.error('\n💥 UNEXPECTED ERROR:', err.message);
    console.error(err.stack);
    failed++;
  }

  db.close();

  // Cleanup
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  // Summary
  console.log('\n' + '═'.repeat(55));
  console.log(`  HASIL: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  🎉 ALL TESTS PASSED — Phase 3 Validated!');
  } else {
    console.log('  ⚠️  BEBERAPA TEST GAGAL — perlu diperbaiki');
    results.filter(r => !r.ok).forEach(r => console.log(`     ❌ ${r.label}`));
  }
  console.log('═'.repeat(55) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAll();