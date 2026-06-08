/**
 * electron/pos/auth.js
 * PIN-based Authentication
 *
 * Simple PIN auth untuk kasir. PIN di-hash dengan SHA-256.
 * Session disimpan di memory (local device state — tidak disync).
 *
 * Prinsip:
 *  - User data (id, name, role, pin_hash) disync via CRDT
 *  - Session state (siapa yang login sekarang) LOCAL ONLY
 *  - PIN tidak pernah disimpan plaintext
 */
'use strict';

const crypto = require('crypto');

class AuthService {
  constructor(posService) {
    this.posService = posService;
    this._session   = null; // { userId, name, role, loginAt }
  }

  hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
  }

  /**
   * Daftarkan user baru.
   * @param {{ name, role, pin }} data
   * @returns {object} user
   */
  registerUser({ name, role = 'cashier', pin }) {
    if (!pin || String(pin).length < 4) throw new Error('PIN minimal 4 digit');
    const user = this.posService.addUser({
      name,
      role,
      pin_hash: this.hashPin(pin),
    });
    console.log(`[Auth] User registered: ${user.name} (${user.role})`);
    return user;
  }

  /**
   * Login dengan user ID + PIN.
   * @param {string} userId
   * @param {string|number} pin
   * @returns {{ ok: boolean, user?, error? }}
   */
  login(userId, pin) {
    const user = this.posService.getUser(userId);
    if (!user) return { ok: false, error: 'User tidak ditemukan' };

    const pinHash = this.hashPin(pin);
    if (user.pin_hash !== pinHash) return { ok: false, error: 'PIN salah' };

    this._session = {
      userId:  user.id,
      name:    user.name,
      role:    user.role,
      loginAt: Date.now(),
    };

    console.log(`[Auth] Login: ${user.name} (${user.role})`);
    return { ok: true, user: { id: user.id, name: user.name, role: user.role } };
  }

  /**
   * Login by name (untuk testing atau first-run).
   */
  loginByName(name, pin) {
    const users = this.posService.getAllUsers();
    const user  = users.find(u => u.name === name);
    if (!user) return { ok: false, error: `User '${name}' tidak ditemukan` };
    return this.login(user.id, pin);
  }

  logout() {
    const name = this._session?.name;
    this._session = null;
    console.log(`[Auth] Logout: ${name}`);
    return { ok: true };
  }

  getSession()    { return this._session; }
  isLoggedIn()    { return this._session !== null; }
  isAdmin()       { return this._session?.role === 'admin'; }
  getCurrentUser(){ return this._session ? { ...this._session } : null; }

  requireAuth() {
    if (!this.isLoggedIn()) throw new Error('Tidak terautentikasi. Silakan login.');
    return this._session;
  }

  requireAdmin() {
    this.requireAuth();
    if (!this.isAdmin()) throw new Error('Akses ditolak. Role admin diperlukan.');
    return this._session;
  }

  /**
   * Ganti PIN.
   */
  changePin(userId, oldPin, newPin) {
    const user = this.posService.getUser(userId);
    if (!user) return { ok: false, error: 'User tidak ditemukan' };
    if (user.pin_hash !== this.hashPin(oldPin)) return { ok: false, error: 'PIN lama salah' };
    if (String(newPin).length < 4) return { ok: false, error: 'PIN baru minimal 4 digit' };

    this.posService.docManager.upsertUser({ ...user, pin_hash: this.hashPin(newPin) });
    return { ok: true };
  }
}

module.exports = { AuthService };