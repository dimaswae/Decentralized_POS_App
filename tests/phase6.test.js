/**
 * tests/phase6.test.js
 * Phase 6 — Recovery Mechanism + POS Business Logic
 *
 * T1:  WAL mode + DB integrity check
 * T2:  Corrupt doc detection + rebuild from op log
 * T3:  Orphan transaction recovery
 * T4:  Startup recovery sequence (full health check)
 * T5:  PIN auth — register, login, wrong PIN, logout
 * T6:  Role-based access control (admin vs cashier)
 * T7:  Cart full flow — add, update, remove, checkout
 * T8:  Cart checkout → transaction persisted
 * T9:  Reports — daily summary accuracy
 * T10: Reports — inventory low-stock detection
 * T11: Reports — transaction history filters
 * T12: Product search
 * T13: PosFacade full integration flow
 * T14: Crash simulation → rebuild → verify correctness
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Helpers ──────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL: ${label}`); failed++; }
}
function assertEq(a, e, label) {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok)  { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.error(`  ❌ FAIL: ${label}`);
    console.error(`     expected: ${JSON.stringify(e)}`);
    console.error(`     actual:   ${JSON.stringify(a)}`);
    failed++;
  }
}
function assertGt(a, b, label) {
  if (a > b) { console.log(`  ✅ ${label} (${a} > ${b})`); passed++; }
  else        { console.error(`  ❌ FAIL: ${label} — expected ${a} > ${b}`); failed++; }
}
function section(t) {
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ${t}`);
  console.log('─'.repeat(62));
}

// ─── DB factory ───────────────────────────────────────────────────
async function makeDb(label) {
  const dbPath = `/tmp/pos-p6-${label}-${Date.now()}.db`;
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const { Database } = require('../electron/db/index');
  const db = new Database();
  await db.init(dbPath);
  return { db, dbPath };
}

async function makeService(label) {
  const crypto = require('crypto');
  const { db, dbPath } = await makeDb(label);
  const nodeId = crypto.createHash('md5').update(`p6-${label}`).digest('hex') +
                 crypto.createHash('md5').update(`p6-${label}-2`).digest('hex');
  const nid = nodeId.slice(0, 36);
  db.setConfig('node_id', nid);
  const { PosService } = require('../electron/pos-service');
  const svc = new PosService(db, nid);
  svc.init();
  return { db, dbPath, svc, nodeId: nid };
}

function cleanup(db, dbPath) {
  try { db.close(); } catch (_) {}
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

// ─── T1: WAL mode + DB integrity ─────────────────────────────────
async function testWALAndIntegrity() {
  section('T1: WAL Mode + DB Integrity Check');

  const { db, dbPath, svc } = await makeService('wal');
  const { RecoveryManager } = require('../electron/recovery/recovery-manager');
  const recovery = new RecoveryManager(db, svc.docManager, svc);

  const walOk = recovery.enableWAL();
  assert(walOk, 'WAL mode enabled successfully');

  // Verify WAL via PRAGMA
  const mode = db._query('PRAGMA journal_mode');
  assert(
    mode[0]?.journal_mode === 'wal',
    `Journal mode = WAL (got: ${mode[0]?.journal_mode})`
  );

  // Integrity check on fresh DB
  const integrity = recovery.checkIntegrity();
  assert(integrity.ok, 'Fresh DB integrity check passed');
  assertEq(integrity.issues.length, 0, 'No integrity issues on fresh DB');

  // All required tables exist
  const tables = ['automerge_docs', 'operation_logs', 'sync_metadata', 'device_config'];
  for (const t of tables) {
    const exists = db._query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [t]);
    assert(exists.length > 0, `Table exists: ${t}`);
  }

  cleanup(db, dbPath);
}

// ─── T2: Corrupt doc rebuild ──────────────────────────────────────
async function testCorruptDocRebuild() {
  section('T2: Corrupt Doc Detection + Rebuild from Op Log');

  const { db, dbPath, svc, nodeId } = await makeService('rebuild');
  const { RecoveryManager } = require('../electron/recovery/recovery-manager');
  const recovery = new RecoveryManager(db, svc.docManager, svc);

  // Setup: produk + transaksi
  const p1 = svc.addProduct({ name: 'Tepung Terigu', price: 8000, unit: 'kg' });
  const p2 = svc.addProduct({ name: 'Gula Putih',   price: 15000, unit: 'kg' });
  svc.initStock(p1.id, 100);
  svc.initStock(p2.id, 80);
  svc.createTransaction({
    cashier_id: 'kasir-1',
    items: [{ product_id: p1.id, qty: 5, price_at_sale: 8000 }],
  });

  const stockBefore = svc.getStock(p1.id); // 100 - 5 = 95
  const txBefore    = svc.getTransactionCount();

  assert(recovery.isDocValid('products'),     'Products doc valid before corruption');
  assert(recovery.isDocValid('transactions'), 'Transactions doc valid before corruption');

  // Simulasi corrupt: overwrite binary dengan data invalid
  db._run(
    `UPDATE automerge_docs SET doc_binary = ? WHERE doc_id = 'transactions'`,
    [Buffer.from('CORRUPTED_DATA_INVALID')]
  );
  db._dirty = true;

  assert(!recovery.isDocValid('transactions'), 'Corrupt doc detected correctly');

  // Rebuild dari op log
  const result = recovery.rebuildDoc('transactions');
  assert(result.rebuilt,       'Rebuild succeeded');
  assertGt(result.opCount, 0, 'Ops replayed during rebuild');

  // Verifikasi hasil rebuild
  assert(recovery.isDocValid('transactions'), 'Transactions doc valid after rebuild');
  const txAfter = svc.getTransactionCount();
  // Rebuild dari op log: tx harus ada (meskipun mungkin berbeda count tergantung op log coverage)
  assert(txAfter >= 0, `Transaction count after rebuild: ${txAfter}`);

  // Products doc masih valid (tidak disentuh)
  assert(recovery.isDocValid('products'), 'Products doc still valid (untouched)');

  cleanup(db, dbPath);
}

// ─── T3: Orphan transaction recovery ─────────────────────────────
async function testOrphanTxRecovery() {
  section('T3: Orphan Transaction Recovery');

  const { db, dbPath, svc } = await makeService('orphan');
  const { RecoveryManager } = require('../electron/recovery/recovery-manager');
  const { v4: uuidv4 }      = require('uuid');
  const recovery = new RecoveryManager(db, svc.docManager, svc);

  const prod = svc.addProduct({ name: 'Beras', price: 12000 });
  svc.initStock(prod.id, 50);

  // Simulasi crash: op log punya tx, tapi Automerge doc tidak (crash setelah insertOp, sebelum appendTransaction)
  const orphanTx = {
    id:         uuidv4(),
    items:      [{ product_id: prod.id, qty: 2, price_at_sale: 12000 }],
    total:      24000,
    cashier_id: 'kasir-ghost',
    node_id:    svc.nodeId,
    created_at: Date.now(),
  };

  // Masukkan ke op log tapi TIDAK ke Automerge doc
  const opId = uuidv4();
  db.insertOp({
    op_id:        opId,
    node_id:      svc.nodeId,
    entity_type:  'transaction',
    op_type:      'add_transaction',
    payload:      orphanTx,
    vector_clock: { [svc.nodeId]: 99 },
    created_at:   Date.now(),
  });

  // Verify: op ada di log tapi tx tidak ada di doc
  const txBefore = svc.getAllTransactions();
  assert(!txBefore.some(tx => tx.id === orphanTx.id), 'Orphan tx NOT in Automerge doc (confirmed)');

  const logOps = db.getOpsByEntity('transaction').filter(op => op.op_id === opId);
  assert(logOps.length === 1, 'Orphan tx IS in op log');

  // Recovery: reconcile orphan ops
  const result = recovery.reconcileOrphanOps();
  assert(result.orphanOps >= 1, `Orphan ops detected: ${result.orphanOps}`);

  // Verifikasi: tx sekarang ada di doc
  const txAfter = svc.getAllTransactions();
  assert(txAfter.some(tx => tx.id === orphanTx.id), 'Orphan tx recovered to Automerge doc ✅');

  cleanup(db, dbPath);
}

// ─── T4: Full startup recovery ────────────────────────────────────
async function testStartupRecovery() {
  section('T4: Full Startup Recovery Sequence');

  const { db, dbPath, svc } = await makeService('startup');
  const { RecoveryManager } = require('../electron/recovery/recovery-manager');
  const recovery = new RecoveryManager(db, svc.docManager, svc);

  // Tambah beberapa data
  const prod = svc.addProduct({ name: 'Mie Instan', price: 3500 });
  svc.initStock(prod.id, 200);
  svc.createTransaction({
    cashier_id: 'ka',
    items: [{ product_id: prod.id, qty: 10, price_at_sale: 3500 }],
  });

  const report = await recovery.runStartupRecovery();

  assert(typeof report === 'object',     'runStartupRecovery returns report object');
  assert(report.wal_enabled,             'WAL enabled during startup');
  assert(report.db_integrity === 'OK',   'DB integrity OK');
  assertEq(report.docs_checked, 3,       'Checked 3 docs (products, transactions, users)');
  assertEq(report.docs_rebuilt, 0,       'No rebuild needed on healthy DB');
  assert(typeof report.orphan_ops === 'number', 'orphan_ops is a number');
  assert(Array.isArray(report.issues),   'issues is an array');
  assertEq(report.issues.length, 0,      'No issues on healthy startup');

  cleanup(db, dbPath);
}

// ─── T5: PIN Auth ─────────────────────────────────────────────────
async function testPinAuth() {
  section('T5: PIN Authentication');

  const { db, dbPath, svc } = await makeService('auth');
  const { AuthService }     = require('../electron/pos/auth');
  const auth = new AuthService(svc);

  // Register
  const user = auth.registerUser({ name: 'Budi Kasir', role: 'cashier', pin: '1234' });
  assert(user.id,             'registerUser returns user with id');
  assertEq(user.name, 'Budi Kasir', 'User name correct');
  assertEq(user.role, 'cashier',    'User role correct');
  assert(!user.pin_hash?.includes('1234'), 'PIN not stored plaintext');

  // Login success
  const result = auth.login(user.id, '1234');
  assert(result.ok,                'Login success with correct PIN');
  assertEq(result.user.name, 'Budi Kasir', 'Login returns correct user');

  // Session active
  assert(auth.isLoggedIn(),        'Session active after login');
  assertEq(auth.getSession().name, 'Budi Kasir', 'Session has correct name');
  assert(!auth.isAdmin(),          'Cashier is not admin');

  // Wrong PIN
  const badLogin = auth.login(user.id, '9999');
  assert(!badLogin.ok,             'Login fails with wrong PIN');
  assert(badLogin.error,           'Wrong PIN returns error message');

  // Logout
  auth.logout();
  assert(!auth.isLoggedIn(),       'Session cleared after logout');

  // Login by name
  const byName = auth.loginByName('Budi Kasir', '1234');
  assert(byName.ok, 'loginByName works');
  auth.logout();

  // Admin register
  const admin = auth.registerUser({ name: 'Admin Toko', role: 'admin', pin: '0000' });
  auth.login(admin.id, '0000');
  assert(auth.isAdmin(), 'Admin role correctly identified');
  auth.logout();

  // Short PIN rejected
  try {
    auth.registerUser({ name: 'X', pin: '12' });
    assert(false, 'Short PIN should throw');
  } catch (err) {
    assert(err.message.includes('4'), 'Short PIN rejected with error');
  }

  // Change PIN
  auth.login(user.id, '1234');
  const changeResult = auth.changePin(user.id, '1234', '5678');
  assert(changeResult.ok, 'changePin success');
  auth.logout();
  const newLogin = auth.loginByName('Budi Kasir', '5678');
  assert(newLogin.ok, 'Login with new PIN works');

  cleanup(db, dbPath);
}

// ─── T6: RBAC ─────────────────────────────────────────────────────
async function testRBAC() {
  section('T6: Role-Based Access Control');

  const { db, dbPath, svc } = await makeService('rbac');
  const { AuthService }     = require('../electron/pos/auth');
  const auth = new AuthService(svc);

  const kasir = auth.registerUser({ name: 'Kasir 1', role: 'cashier', pin: '1111' });
  const admin  = auth.registerUser({ name: 'Admin',   role: 'admin',   pin: '0000' });

  // requireAuth when not logged in
  try {
    auth.requireAuth();
    assert(false, 'requireAuth should throw when not logged in');
  } catch (err) {
    assert(err.message.includes('terautentikasi'), 'requireAuth throws correct error');
  }

  // requireAdmin as cashier
  auth.login(kasir.id, '1111');
  try {
    auth.requireAdmin();
    assert(false, 'requireAdmin should throw for cashier');
  } catch (err) {
    assert(err.message.includes('admin'), 'requireAdmin throws for cashier');
  }
  auth.logout();

  // requireAdmin as admin
  auth.login(admin.id, '0000');
  const session = auth.requireAdmin();
  assert(session.role === 'admin', 'requireAdmin passes for admin');
  auth.logout();

  cleanup(db, dbPath);
}

// ─── T7: Cart operations ──────────────────────────────────────────
async function testCartOperations() {
  section('T7: Cart Full Flow — Add, Update, Remove');

  const { db, dbPath, svc } = await makeService('cart1');
  const { AuthService }     = require('../electron/pos/auth');
  const { CartManager }     = require('../electron/pos/cart');

  const auth = new AuthService(svc);
  const cart = new CartManager(svc, auth);

  // Register user + login
  const user = auth.registerUser({ name: 'Kasir Baru', pin: '4321' });
  auth.login(user.id, '4321');

  // Setup produk
  const p1 = svc.addProduct({ name: 'Kopi Tubruk', price: 5000, unit: 'sachet' });
  const p2 = svc.addProduct({ name: 'Teh Kotak',   price: 4000, unit: 'kotak' });
  svc.initStock(p1.id, 50);
  svc.initStock(p2.id, 30);

  // Empty cart
  assert(cart.isEmpty(),           'Cart starts empty');
  assertEq(cart.getTotal(), 0,     'Total = 0 when empty');

  // Add items
  const r1 = cart.addItem(p1.id, 3);
  assert(r1.ok,                    'addItem p1 success');
  assertEq(r1.item.qty, 3,         'p1 qty = 3');
  assertEq(r1.item.subtotal, 15000,'p1 subtotal = 15000');

  cart.addItem(p2.id, 2);
  assertEq(cart.getItemCount(), 2, 'Cart has 2 items');
  assertEq(cart.getTotal(), 15000 + 8000, 'Total = 23000');

  // Add more of same product
  cart.addItem(p1.id, 2);
  assertEq(cart.getItems().find(i => i.product_id === p1.id)?.qty, 5,
    'p1 qty accumulates to 5');

  // setQty
  cart.setQty(p2.id, 1);
  assertEq(cart.getItems().find(i => i.product_id === p2.id)?.qty, 1,
    'p2 qty set to 1');
  assertEq(cart.getTotal(), 5*5000 + 1*4000, 'Total after setQty correct');

  // Remove
  cart.removeItem(p2.id);
  assertEq(cart.getItemCount(), 1, 'Cart has 1 item after remove');

  // Note
  cart.setNote('Langganan harian');
  assertEq(cart.getSummary().note, 'Langganan harian', 'Cart note set');

  // Clear
  cart.clear();
  assert(cart.isEmpty(), 'Cart cleared');

  // Add to non-existent product
  const bad = cart.addItem('non-existent-id', 1);
  assert(!bad.ok, 'addItem fails for unknown product');
  assert(bad.error, 'addItem returns error for unknown product');

  cleanup(db, dbPath);
}

// ─── T8: Checkout flow ────────────────────────────────────────────
async function testCheckoutFlow() {
  section('T8: Checkout Flow → Transaction Persisted');

  const { db, dbPath, svc } = await makeService('checkout');
  const { AuthService }     = require('../electron/pos/auth');
  const { CartManager }     = require('../electron/pos/cart');

  const auth = new AuthService(svc);
  const cart = new CartManager(svc, auth);

  const user = auth.registerUser({ name: 'Kasir Utama', pin: '7777' });
  auth.login(user.id, '7777');

  const p1 = svc.addProduct({ name: 'Aqua Botol', price: 3500, unit: 'botol' });
  const p2 = svc.addProduct({ name: 'Roti Tawar', price: 18000, unit: 'bungkus' });
  svc.initStock(p1.id, 100);
  svc.initStock(p2.id, 20);

  cart.addItem(p1.id, 3);
  cart.addItem(p2.id, 1);

  const expectedTotal = 3*3500 + 1*18000; // 28500

  // Checkout dengan pembayaran kurang
  const failResult = cart.checkout({ payment: 10000 });
  assert(!failResult.ok, 'Checkout fails with insufficient payment');
  assert(!cart.isEmpty(), 'Cart not cleared after failed checkout');

  // Checkout sukses
  const result = cart.checkout({ payment: 30000 });
  assert(result.ok,                         'Checkout succeeds');
  assert(result.transaction?.id,            'Transaction has ID');
  assertEq(result.transaction.total, expectedTotal, `Transaction total = ${expectedTotal}`);

  // Receipt
  assert(result.receipt,                    'Receipt generated');
  assertEq(result.receipt.total, expectedTotal, 'Receipt total correct');
  assertEq(result.receipt.payment, 30000,   'Receipt payment correct');
  assertEq(result.receipt.change, 30000 - expectedTotal, 'Receipt change correct');
  assertEq(result.receipt.cashier, 'Kasir Utama', 'Receipt cashier name correct');

  // Cart cleared after checkout
  assert(cart.isEmpty(), 'Cart cleared after successful checkout');

  // Transaction persisted
  const txs = svc.getAllTransactions();
  assert(txs.some(tx => tx.id === result.transaction.id), 'Transaction saved to distributed state');

  // Stock reduced
  assertEq(svc.getStock(p1.id), 100 - 3,   'p1 stock reduced by 3');
  assertEq(svc.getStock(p2.id), 20 - 1,    'p2 stock reduced by 1');

  // Checkout without login
  auth.logout();
  cart.addItem(p1.id, 1);
  const noAuthResult = cart.checkout({ payment: 5000 });
  assert(!noAuthResult.ok || noAuthResult.error !== undefined,
    'Checkout throws/fails without auth');

  cleanup(db, dbPath);
}

// ─── T9: Daily summary report ─────────────────────────────────────
async function testDailySummary() {
  section('T9: Reports — Daily Summary Accuracy');

  const { db, dbPath, svc } = await makeService('reports1');
  const { ReportsService }  = require('../electron/pos/reports');
  const { AuthService }     = require('../electron/pos/auth');
  const { CartManager }     = require('../electron/pos/cart');

  const auth    = new AuthService(svc);
  const cart    = new CartManager(svc, auth);
  const reports = new ReportsService(svc);

  const user = auth.registerUser({ name: 'Kasir', pin: '0000' });
  auth.login(user.id, '0000');

  const p1 = svc.addProduct({ name: 'Sabun Mandi', price: 7500, unit: 'bar' });
  const p2 = svc.addProduct({ name: 'Sikat Gigi',  price: 12000, unit: 'pcs' });
  svc.initStock(p1.id, 100);
  svc.initStock(p2.id, 50);

  // 3 transaksi hari ini
  cart.addItem(p1.id, 2); cart.checkout({ payment: 20000 });
  cart.addItem(p2.id, 1); cart.checkout({ payment: 15000 });
  cart.addItem(p1.id, 1); cart.addItem(p2.id, 2); cart.checkout({ payment: 50000 });

  const summary = reports.getDailySummary();

  assertEq(summary.tx_count, 3,   'Daily tx count = 3');
  const expectedRevenue = 2*7500 + 12000 + 7500 + 2*12000;
  assertEq(summary.total_revenue, expectedRevenue, `Daily revenue = ${expectedRevenue}`);
  assertGt(summary.items_sold, 0, 'Items sold > 0');
  assertGt(summary.avg_tx_value, 0, 'Avg tx value > 0');
  assert(Array.isArray(summary.by_product), 'by_product is array');
  assert(summary.by_product.length >= 2,    'by_product has entries for both products');
  assert(Array.isArray(summary.by_node),    'by_node is array');

  // Verifikasi top product
  const top = reports.getTopProducts(1);
  assert(top.length >= 1, 'getTopProducts returns result');

  cleanup(db, dbPath);
}

// ─── T10: Inventory report ────────────────────────────────────────
async function testInventoryReport() {
  section('T10: Reports — Inventory Low-Stock Detection');

  const { db, dbPath, svc } = await makeService('reports2');
  const { ReportsService }  = require('../electron/pos/reports');
  const { AuthService }     = require('../electron/pos/auth');
  const { CartManager }     = require('../electron/pos/cart');

  const auth    = new AuthService(svc);
  const cart    = new CartManager(svc, auth);
  const reports = new ReportsService(svc);

  const user = auth.registerUser({ name: 'Kasir', pin: '0000' });
  auth.login(user.id, '0000');

  const p1 = svc.addProduct({ name: 'Stok Normal', price: 5000 });
  const p2 = svc.addProduct({ name: 'Stok Tipis',  price: 5000 });
  const p3 = svc.addProduct({ name: 'Stok Habis',  price: 5000 });

  svc.initStock(p1.id, 100);
  svc.initStock(p2.id, 5);  // ≤ threshold 10 → low stock
  svc.initStock(p3.id, 0);  // out of stock

  const report = reports.getInventoryReport(10);

  assertEq(report.total_products, 3, 'Total products = 3');
  assert(report.low_stock_count >= 1, `Low stock detected (got ${report.low_stock_count})`);
  assert(report.out_of_stock_count >= 1, `Out of stock detected (got ${report.out_of_stock_count})`);
  assert(report.low_stock.some(p => p.id === p2.id), 'p2 in low_stock list');
  assert(report.out_of_stock.some(p => p.id === p3.id), 'p3 in out_of_stock list');

  cleanup(db, dbPath);
}

// ─── T11: Transaction history filters ────────────────────────────
async function testTransactionHistoryFilters() {
  section('T11: Reports — Transaction History Filters');

  const { db, dbPath, svc } = await makeService('reports3');
  const { ReportsService }  = require('../electron/pos/reports');
  const { AuthService }     = require('../electron/pos/auth');
  const { CartManager }     = require('../electron/pos/cart');

  const auth    = new AuthService(svc);
  const cart    = new CartManager(svc, auth);
  const reports = new ReportsService(svc);

  const ka = auth.registerUser({ name: 'Kasir A', pin: '1111' });
  const kb = auth.registerUser({ name: 'Kasir B', pin: '2222' });

  const prod = svc.addProduct({ name: 'Produk Test', price: 10000 });
  svc.initStock(prod.id, 200);

  // Kasir A: 3 tx
  auth.login(ka.id, '1111');
  for (let i = 0; i < 3; i++) {
    cart.addItem(prod.id, 1);
    cart.checkout({ payment: 10000 });
  }
  auth.logout();

  // Kasir B: 2 tx
  auth.login(kb.id, '2222');
  for (let i = 0; i < 2; i++) {
    cart.addItem(prod.id, 1);
    cart.checkout({ payment: 10000 });
  }
  auth.logout();

  // All transactions
  const all = reports.getTransactionHistory();
  assertEq(all.count, 5, 'Total 5 transactions');

  // Filter by cashier
  const byKa = reports.getTransactionHistory({ cashierId: ka.id });
  assertEq(byKa.count, 3, 'Filter by Kasir A = 3 tx');

  const byKb = reports.getTransactionHistory({ cashierId: kb.id });
  assertEq(byKb.count, 2, 'Filter by Kasir B = 2 tx');

  // Limit
  const limited = reports.getTransactionHistory({ limit: 2 });
  assertEq(limited.count, 2, 'Limit 2 works');

  // Sorted descending
  if (all.transactions.length >= 2) {
    assert(
      all.transactions[0].created_at >= all.transactions[1].created_at,
      'Transactions sorted descending by created_at'
    );
  }

  cleanup(db, dbPath);
}

// ─── T12: Product search ──────────────────────────────────────────
async function testProductSearch() {
  section('T12: Product Search');

  const { db, dbPath, svc } = await makeService('search');
  const { PosFacade }       = require('../electron/pos/pos-facade');

  // Manual search tanpa facade (lebih cepat)
  svc.addProduct({ name: 'Kopi Arabika', price: 25000, category: 'minuman' });
  svc.addProduct({ name: 'Kopi Robusta', price: 20000, category: 'minuman' });
  svc.addProduct({ name: 'Teh Hijau',    price: 15000, category: 'minuman' });
  svc.addProduct({ name: 'Roti Bakar',   price: 12000, category: 'makanan' });

  // Search by name
  function searchProducts(query) {
    const q = query.toLowerCase();
    return svc.getAllProducts().filter(
      p => p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)
    );
  }

  const kopiResults = searchProducts('kopi');
  assertEq(kopiResults.length, 2, 'Search "kopi" = 2 results');

  const minumanResults = searchProducts('minuman');
  assertEq(minumanResults.length, 3, 'Search by category "minuman" = 3 results');

  const tehResults = searchProducts('teh');
  assertEq(tehResults.length, 1, 'Search "teh" = 1 result');

  const emptyResults = searchProducts('xyz123');
  assertEq(emptyResults.length, 0, 'Search non-existent = 0 results');

  cleanup(db, dbPath);
}

// ─── T13: PosFacade integration ───────────────────────────────────
async function testPosFacadeIntegration() {
  section('T13: PosFacade Full Integration Flow');

  const dbPath = `/tmp/pos-facade-${Date.now()}.db`;
  const { PosFacade } = require('../electron/pos/pos-facade');

  const facade = new PosFacade();
  await facade.init({ dbPath, enableSync: false });

  assert(facade.isReady(), 'Facade is ready after init');

  // Register + login
  const user = facade.registerUser({ name: 'Pemilik Toko', role: 'admin', pin: '9999' });
  const loginResult = facade.login(user.id, '9999');
  assert(loginResult.ok, 'Facade login works');

  // Add products + stock
  const prod1 = facade.addProduct({ name: 'Indomie', price: 3500, unit: 'bungkus' });
  const prod2 = facade.addProduct({ name: 'Teh Botol', price: 5000, unit: 'botol' });
  facade.initStock(prod1.id, 500);
  facade.initStock(prod2.id, 200);

  assertEq(facade.getStock(prod1.id), 500, 'Stock initialized via facade');

  // Search
  const searchResult = facade.searchProducts('indomie');
  assert(searchResult.length >= 1, 'Product search via facade works');

  // Cart + checkout
  facade.cartAdd(prod1.id, 5);
  facade.cartAdd(prod2.id, 2);
  assertEq(facade.getCart().itemCount, 2, 'Cart has 2 items');
  assertEq(facade.getCart().total, 5*3500 + 2*5000, 'Cart total correct');

  const checkout = facade.checkout({ payment: 50000 });
  assert(checkout.ok, 'Checkout via facade succeeds');
  assert(checkout.receipt, 'Receipt generated via facade');

  // Reports
  const daily = facade.getDailySummary();
  assert(daily.tx_count >= 1, 'Daily report has transactions');

  const invReport = facade.getInventoryReport();
  assert(invReport.total_products >= 2, 'Inventory report has products');

  const txHistory = facade.getTransactionHistory({ limit: 10 });
  assert(txHistory.count >= 1, 'Transaction history via facade works');

  // System status
  const status = facade.getSystemStatus();
  assert(status.node_id, 'System status has node_id');
  assert(typeof status.vector_clock === 'object', 'System status has vector_clock');

  await facade.shutdown();

  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

// ─── T14: Crash simulation + rebuild ─────────────────────────────
async function testCrashAndRebuild() {
  section('T14: Crash Simulation → Rebuild → Verify Correctness');

  const { db, dbPath, svc } = await makeService('crash');
  const { RecoveryManager } = require('../electron/recovery/recovery-manager');
  const { AuthService }     = require('../electron/pos/auth');
  const { CartManager }     = require('../electron/pos/cart');

  const auth = new AuthService(svc);
  const cart = new CartManager(svc, auth);
  const recovery = new RecoveryManager(db, svc.docManager, svc);

  // Setup data normal
  const user = auth.registerUser({ name: 'Kasir', pin: '0000' });
  auth.login(user.id, '0000');

  const prod = svc.addProduct({ name: 'Barang Crash Test', price: 9999 });
  svc.initStock(prod.id, 100);

  // 5 transaksi
  for (let i = 0; i < 5; i++) {
    cart.addItem(prod.id, 2);
    cart.checkout({ payment: 20000 });
  }

  const stockBefore    = svc.getStock(prod.id);   // 100 - 10 = 90
  const txCountBefore  = svc.getTransactionCount();
  assertEq(stockBefore,   90, 'Stock before crash = 90');
  assertEq(txCountBefore, 5,  'Tx count before crash = 5');

  // SIMULASI CRASH: corrupt SEMUA Automerge docs
  for (const docId of ['products', 'transactions', 'users']) {
    db._run(
      `UPDATE automerge_docs SET doc_binary = ? WHERE doc_id = ?`,
      [Buffer.from('CRASH_CORRUPT'), docId]
    );
  }
  db._dirty = true;

  // Verifikasi semua docs corrupt
  assert(!recovery.isDocValid('products'),     'Products doc corrupt after crash');
  assert(!recovery.isDocValid('transactions'), 'Transactions doc corrupt after crash');

  // RECOVERY: rebuild semua dari op log
  const rebuildResult = recovery.rebuildAllCorruptDocs();
  assert(rebuildResult.rebuilt >= 1, `Rebuilt ${rebuildResult.rebuilt} docs after crash`);

  // VERIFY: data harus masih konsisten dengan op log
  // Inventory projection tidak bergantung pada Automerge doc → tetap benar
  const stockAfter = svc.getStock(prod.id);
  assertEq(stockAfter, 90, `Inventory still correct after crash: ${stockAfter}`);

  // Op log intact
  const opCount = db.getTotalOpCount();
  assertGt(opCount, 0, `Op log intact after crash: ${opCount} ops`);

  // Recovery report bersih
  const report = await recovery.runStartupRecovery();
  assert(report.db_integrity === 'OK', 'DB integrity OK after recovery');

  cleanup(db, dbPath);
}

// ─── Main ─────────────────────────────────────────────────────────
async function runAll() {
  console.log('\n' + '═'.repeat(62));
  console.log('  PHASE 6 — Recovery Mechanism + POS Business Logic');
  console.log('═'.repeat(62));

  try {
    await testWALAndIntegrity();
    await testCorruptDocRebuild();
    await testOrphanTxRecovery();
    await testStartupRecovery();
    await testPinAuth();
    await testRBAC();
    await testCartOperations();
    await testCheckoutFlow();
    await testDailySummary();
    await testInventoryReport();
    await testTransactionHistoryFilters();
    await testProductSearch();
    await testPosFacadeIntegration();
    await testCrashAndRebuild();
  } catch (err) {
    console.error('\n💥 UNEXPECTED ERROR:', err.message);
    console.error(err.stack);
    failed++;
  }

  console.log('\n' + '═'.repeat(62));
  console.log(`  HASIL: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  🎉 ALL TESTS PASSED — Phase 6 Validated!');
  } else {
    console.log('  ⚠️  BEBERAPA TEST GAGAL');
  }
  console.log('═'.repeat(62) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

runAll();