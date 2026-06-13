/**
 * electron/ipc/handlers.js
 * IPC Handler Registration — Electron Main Process
 */
'use strict';

function _broadcast(channel, payload) {
  try {
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send(channel, payload); } catch (_) { /* ignore */ }
    }
  } catch (e) {
    console.error(`[IPC] Failed to broadcast ${channel}:`, e.message);
  }
}

function registerHandlers(ipcMain, facade) {
  // Auth
  ipcMain.handle('auth:login',       (_, userId, pin) => facade.login(userId, pin));
  ipcMain.handle('auth:loginByName', (_, name, pin)   => facade.loginByName(name, pin));
  ipcMain.handle('auth:logout',      ()               => facade.logout());
  ipcMain.handle('auth:session',     ()               => facade.getSession());
  ipcMain.handle('auth:register',    (_, data)        => facade.registerUser(data));
  ipcMain.handle('auth:getAllUsers', ()               => facade.getAllUsers());

  // Products
  ipcMain.handle('product:add',      (_, data)        => facade.addProduct(data));
  ipcMain.handle('product:update',   (_, id, upd)     => facade.updateProduct(id, upd));
  ipcMain.handle('product:get',      (_, id)          => facade.getProduct(id));
  ipcMain.handle('product:getAll',   ()               => facade.getAllProducts());
  ipcMain.handle('product:search',   (_, q)           => facade.searchProducts(q));

  // Inventory
  ipcMain.handle('inventory:initStock', (_, pid, qty, note) => facade.initStock(pid, qty, note));
  ipcMain.handle('inventory:addStock',  (_, pid, qty, note) => facade.addStock(pid, qty, note));
  ipcMain.handle('inventory:getStock',  (_, pid)            => facade.getStock(pid));
  ipcMain.handle('inventory:getAll',    ()                  => facade.getAllStocks());
  ipcMain.handle('inventory:history',   (_, pid)            => facade.getStockHistory(pid));

  // Cart
  ipcMain.handle('cart:add',         (_, pid, qty)    => facade.cartAdd(pid, qty));
  ipcMain.handle('cart:setQty',      (_, pid, qty)    => facade.cartSetQty(pid, qty));
  ipcMain.handle('cart:remove',      (_, pid)         => facade.cartRemove(pid));
  ipcMain.handle('cart:clear',       ()               => facade.cartClear());
  ipcMain.handle('cart:get',         ()               => facade.getCart());
  ipcMain.handle('cart:setNote',     (_, note)        => facade.cartSetNote(note));
  ipcMain.handle('cart:checkout', async (_, info) => {
    const res = await facade.checkout(info);
    if (res?.ok) {
      _broadcast('pos:checkout', res);
      _broadcast('pos:products-updated', null);
    }
    return res;
  });

  // Reports
  ipcMain.handle('reports:daily',       (_, ts)  => facade.getDailySummary(ts));
  ipcMain.handle('reports:inventory',   (_, thr) => facade.getInventoryReport(thr));
  ipcMain.handle('reports:history',     (_, f)   => facade.getTransactionHistory(f));
  ipcMain.handle('reports:syncStatus',  ()        => facade.getSyncStatus());
  ipcMain.handle('reports:topProducts', (_, n)   => facade.getTopProducts(n));

  // System
  ipcMain.handle('system:status',   () => facade.getSystemStatus());
  ipcMain.handle('system:syncInfo', () => facade.getSyncInfo());

  console.log('[IPC] All handlers registered');
}

module.exports = { registerHandlers };