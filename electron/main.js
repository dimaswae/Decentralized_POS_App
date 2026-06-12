/**
 * electron/main.js
 * Electron Main Process Entry Point
 */
'use strict';

const path  = require('path');
const fs    = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { PosFacade }        = require('./pos/pos-facade');
const { registerHandlers } = require('./ipc/handlers');

let mainWindow;
let facade;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280, height: 800,
    minWidth: 900, minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    title: 'POS CRDT — Local-First',
  });

  const distIndex = path.join(__dirname, '../dist/index.html');
  const isDev = !app.isPackaged && !fs.existsSync(distIndex);

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();

    // Retry jika Vite dev server belum siap saat window dibuat
    mainWindow.webContents.on('did-fail-load', () => {
      console.log('[Main] Vite dev server not ready, retrying in 1s...');
      setTimeout(() => mainWindow.loadURL('http://localhost:5173'), 1000);
    });
  } else {
    mainWindow.loadFile(distIndex);
  }
}

async function initFacade() {
  const userDataPath = app.getPath('userData');
  const dbPath       = path.join(userDataPath, 'pos-crdt.db');
  const relayUrl     = process.env.RELAY_URL     || 'ws://localhost:9000';
  const listenPort   = parseInt(process.env.LISTEN_PORT || '8080', 10);

  facade = new PosFacade();
  await facade.init({ dbPath, relayUrl, listenPort, enableSync: true });

  // Seed default admin jika belum ada
  const users = facade.getAllUsers();
  if (!users.length) {
    facade.registerUser({ name: 'Admin', role: 'admin',   pin: '0000' });
    facade.registerUser({ name: 'Kasir', role: 'cashier', pin: '1234' });
    console.log('[Main] Default users seeded: Admin/0000, Kasir/1234');
  }
}

app.whenReady().then(async () => {
  await initFacade();
  registerHandlers(ipcMain, facade);
  await createWindow();
});

app.on('window-all-closed', async () => {
  if (facade) await facade.shutdown();
  if (process.platform !== 'darwin') app.quit();
});