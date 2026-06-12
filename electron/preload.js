/**
 * electron/preload.js
 * Preload Script — Expose ipcRenderer ke renderer process secara aman
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posAPI', {
  // Auth
  login:       (userId, pin) => ipcRenderer.invoke('auth:login', userId, pin),
  loginByName: (name, pin)   => ipcRenderer.invoke('auth:loginByName', name, pin),
  logout:      ()            => ipcRenderer.invoke('auth:logout'),
  getSession:  ()            => ipcRenderer.invoke('auth:session'),
  register:    (data)        => ipcRenderer.invoke('auth:register', data),
  getAllUsers: ()             => ipcRenderer.invoke('auth:getAllUsers'),

  // Products
  addProduct:    (data)     => ipcRenderer.invoke('product:add', data),
  updateProduct: (id, upd)  => ipcRenderer.invoke('product:update', id, upd),
  getProduct:    (id)       => ipcRenderer.invoke('product:get', id),
  getAllProducts: ()         => ipcRenderer.invoke('product:getAll'),
  searchProducts:(q)        => ipcRenderer.invoke('product:search', q),

  // Inventory
  initStock:    (pid, qty, note) => ipcRenderer.invoke('inventory:initStock', pid, qty, note),
  addStock:     (pid, qty, note) => ipcRenderer.invoke('inventory:addStock', pid, qty, note),
  getStock:     (pid)            => ipcRenderer.invoke('inventory:getStock', pid),
  getAllStocks:  ()               => ipcRenderer.invoke('inventory:getAll'),

  // Cart
  cartAdd:      (pid, qty)  => ipcRenderer.invoke('cart:add', pid, qty),
  cartSetQty:   (pid, qty)  => ipcRenderer.invoke('cart:setQty', pid, qty),
  cartRemove:   (pid)       => ipcRenderer.invoke('cart:remove', pid),
  cartClear:    ()          => ipcRenderer.invoke('cart:clear'),
  cartGet:      ()          => ipcRenderer.invoke('cart:get'),
  cartSetNote:  (note)      => ipcRenderer.invoke('cart:setNote', note),
  checkout:     (info)      => ipcRenderer.invoke('cart:checkout', info),

  // Reports
  getDailySummary:       (ts)  => ipcRenderer.invoke('reports:daily', ts),
  getInventoryReport:    (thr) => ipcRenderer.invoke('reports:inventory', thr),
  getTransactionHistory: (f)   => ipcRenderer.invoke('reports:history', f),
  getSyncStatus:         ()    => ipcRenderer.invoke('reports:syncStatus'),
  getTopProducts:        (n)   => ipcRenderer.invoke('reports:topProducts', n),

  // System
  getSystemStatus: () => ipcRenderer.invoke('system:status'),
  getSyncInfo:     () => ipcRenderer.invoke('system:syncInfo'),
});