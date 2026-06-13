/**
 * electron/pos/pos-facade.js
 * POS Facade — Single entry point untuk seluruh fitur POS
 *
 * Mengintegrasikan:
 *  - PosService      (CRDT + distributed state)
 *  - AuthService     (PIN auth, session)
 *  - CartManager     (ephemeral cart)
 *  - ReportsService  (projections + analytics)
 *  - RecoveryManager (crash recovery + WAL)
 *
 * IPC handlers di Electron main process akan memanggil facade ini.
 */
'use strict';

const { PosService }      = require('../pos-service');
const { AuthService }     = require('./auth');
const { CartManager }     = require('./cart');
const { ReportsService }  = require('./reports');
const { RecoveryManager } = require('../recovery/recovery-manager');
const { SyncEngine }      = require('../sync/sync-engine');
const { Database }        = require('../db/index');
const { initNodeIdentity } = require('../identity');
const { MergeVerifier }    = require('../crdt/merge-verifier');

class PosFacade {
  constructor() {
    this.db         = null;
    this.posService = null;
    this.auth       = null;
    this.cart       = null;
    this.reports    = null;
    this.recovery   = null;
    this.syncEngine = null;
    this._ready     = false;
  }

  /**
   * Inisialisasi seluruh sistem POS.
   * @param {object} opts
   * @param {string} opts.dbPath
   * @param {string} opts.relayUrl
   * @param {number} opts.listenPort
   * @param {boolean} opts.enableSync
   */
  async init({ dbPath, relayUrl = 'ws://localhost:9000', listenPort = 8080, enableSync = true }) {
    console.log('[PosFacade] Initializing...');

    // 1. Database
    this.db = new Database();
    await this.db.init(dbPath);

    // 2. Node identity
    const nodeId = initNodeIdentity(this.db);

    // 3. POS service (CRDT core)
    this.posService = new PosService(this.db, nodeId);
    this.posService.init();

    // 4. Recovery (WAL + health check)
    this.recovery = new RecoveryManager(
      this.db,
      this.posService.docManager,
      this.posService
    );
    await this.recovery.runStartupRecovery();

    // 5. Auth + Cart + Reports
    this.auth    = new AuthService(this.posService);
    this.cart    = new CartManager(this.posService, this.auth);
    this.reports = new ReportsService(this.posService);

    // 6. Sync engine (opsional)
    if (enableSync) {
      this.syncEngine = new SyncEngine(this.posService, nodeId, {
        listenPort,
        relayUrl,
        syncInterval: 30000,
      });
      await this.syncEngine.start();
    }

    this._ready = true;
    console.log(`[PosFacade] Ready. Node: ${nodeId}`);
    return this;
  }

  // ─── Auth ──────────────────────────────────────────────────────────
  registerUser(data)                     { return this.auth.registerUser(data); }
  login(userId, pin)                     { return this.auth.login(userId, pin); }
  loginByName(name, pin)                 { return this.auth.loginByName(name, pin); }
  logout()                               { return this.auth.logout(); }
  getSession()                           { return this.auth.getSession(); }
  getUser(id)                            { return this.posService.getUser(id); }
  getAllUsers()                          { return this.auth.getPublicUsers(); }

  // ─── Products ─────────────────────────────────────────────────────
  addProduct(data)                       { return this.posService.addProduct(data); }
  updateProduct(id, updates)             { return this.posService.updateProduct(id, updates); }
  getProduct(id)                         { return this.posService.getProduct(id); }
  getAllProducts()                        { return this.posService.getAllProducts(); }

  searchProducts(query) {
    const q = query.toLowerCase();
    return this.posService.getAllProducts()
      .filter(p => p.name.toLowerCase().includes(q) ||
                   (p.category || '').toLowerCase().includes(q));
  }

  // ─── Inventory ────────────────────────────────────────────────────
  initStock(productId, qty, note)        { return this.posService.initStock(productId, qty, note); }
  addStock(productId, qty, note)         { return this.posService.addStock(productId, qty, note); }
  getStock(productId)                    { return this.posService.getStock(productId); }
  getAllStocks()                          { return this.posService.getAllStocks(); }
  getStockHistory(productId)             { return this.posService.getStockHistory(productId); }

  // ─── Cart ─────────────────────────────────────────────────────────
  cartAdd(productId, qty)                { return this.cart.addItem(productId, qty); }
  cartSetQty(productId, qty)             { return this.cart.setQty(productId, qty); }
  cartRemove(productId)                  { return this.cart.removeItem(productId); }
  cartClear()                            { return this.cart.clear(); }
  cartSetNote(note)                      { return this.cart.setNote(note); }
  getCart()                              { return this.cart.getSummary(); }
  checkout(paymentInfo)                  { return this.cart.checkout(paymentInfo); }

  // ─── Reports ──────────────────────────────────────────────────────
  getDailySummary(dateTs)                { return this.reports.getDailySummary(dateTs); }
  getInventoryReport(threshold)          { return this.reports.getInventoryReport(threshold); }
  getTransactionHistory(filters)         { return this.reports.getTransactionHistory(filters); }
  getSyncStatus()                        { return this.reports.getSyncStatus(); }
  getTopProducts(limit)                  { return this.reports.getTopProducts(limit); }

  // ─── System ───────────────────────────────────────────────────────
  getSystemStatus()                      { return this.posService.getSystemStatus(); }
  getSyncEngineStatus()                  { return this.syncEngine?.getStatus() || null; }

  /** UI-friendly sync + convergence snapshot. */
  getSyncInfo() {
    const status  = this.getSystemStatus();
    const engine  = this.syncEngine?.getStatus();
    const hash    = MergeVerifier.computeStateHash(this.posService);
    const listenPort = this.syncEngine?.listenPort || 0;

    const nodes = [{
      id:     status.node_id,
      label:  'Node Lokal',
      port:   listenPort,
      status: engine?.relay_ready ? 'online' : 'offline',
      tx:     status.docs?.transactions ?? 0,
      hash:   hash.combinedHash,
    }];

    if (engine?.connections) {
      for (const [peerId, conn] of Object.entries(engine.connections)) {
        const port = conn.ws_url
          ? parseInt(String(conn.ws_url).split(':').pop(), 10) || 0
          : 0;
        const online = conn.state === 'SYNCED' || conn.state === 'IDLE' ||
                       conn.state === 'SYNCING' || conn.state === 'HANDSHAKING';
        nodes.push({
          id:     peerId,
          label:  `Peer ${peerId.slice(0, 8)}`,
          port,
          status: online ? 'online' : 'offline',
          tx:     '—',
          hash:   '—',
        });
      }
    }

    const allOnline = nodes.every(n => n.status === 'online');
    const allSame   = nodes.length > 0 &&
      nodes.every(n => n.hash === hash.combinedHash && n.hash !== '—');

    return {
      phase:        engine?.relay_ready ? (allSame ? 'synced' : 'syncing') : 'offline',
      nodes,
      logs:         [],
      localHash:    hash.combinedHash,
      relayReady:   engine?.relay_ready ?? false,
      knownPeers:   engine?.known_peers ?? 0,
      pendingOps:   this.db.getPendingOps().length,
      totalOps:     this.db.getTotalOpCount(),
      nodeId:       status.node_id,
      allConverged: allSame && allOnline,
    };
  }

  isReady()                              { return this._ready; }

  async shutdown() {
    console.log('[PosFacade] Shutting down...');
    if (this.syncEngine) this.syncEngine.stop();
    if (this.db)         this.db.close();
    this._ready = false;
    console.log('[PosFacade] Shutdown complete.');
  }
}

module.exports = { PosFacade };