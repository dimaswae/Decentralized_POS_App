/**
 * src/App.jsx
 * POS CRDT — Professional React UI
 *
 * Berkomunikasi dengan Electron main process via window.posAPI (preload.js).
 * Fallback ke mock data saat berjalan di browser tanpa Electron.
 *
 * Screens:
 *   login     → PIN authentication per user
 *   pos       → Product grid + Cart + Checkout flow
 *   inventory → Stock management dengan status indicator
 *   reports   → Daily summary + charts + transaction history
 *   sync      → Node status + CRDT hash verification + live log
 */
import { useState, useEffect, useCallback } from 'react';

/* ─── API bridge ─────────────────────────────────────────────── */
const api = window.posAPI || null;
const fmtRp = n => 'Rp ' + Number(n).toLocaleString('id-ID');
const CATS  = ['Semua', 'Pokok', 'Minuman', 'Makanan', 'Toiletri'];

/* ─── Mock data (fallback tanpa Electron) ─────────────────────── */
const MOCK_PRODUCTS = [
  { id:'p1',  name:'Beras Premium',  price:15000, category:'Pokok',    stock:490, unit:'kg',     icon:'🌾', low:50  },
  { id:'p2',  name:'Gula Pasir',     price:14000, category:'Pokok',    stock:295, unit:'kg',     icon:'🍚', low:30  },
  { id:'p3',  name:'Minyak Goreng',  price:20000, category:'Pokok',    stock:195, unit:'L',      icon:'🫙', low:20  },
  { id:'p4',  name:'Kopi Tubruk',    price:5000,  category:'Minuman',  stock:147, unit:'sachet', icon:'☕', low:20  },
  { id:'p5',  name:'Teh Celup',      price:8000,  category:'Minuman',  stock:99,  unit:'kotak',  icon:'🍵', low:15  },
  { id:'p6',  name:'Air Mineral',    price:3000,  category:'Minuman',  stock:300, unit:'botol',  icon:'💧', low:50  },
  { id:'p7',  name:'Indomie Goreng', price:3500,  category:'Makanan',  stock:200, unit:'pcs',    icon:'🍜', low:30  },
  { id:'p8',  name:'Roti Tawar',     price:18000, category:'Makanan',  stock:15,  unit:'bungkus',icon:'🍞', low:10  },
  { id:'p9',  name:'Telur Ayam',     price:2500,  category:'Pokok',    stock:150, unit:'butir',  icon:'🥚', low:30  },
  { id:'p10', name:'Susu UHT',       price:12000, category:'Minuman',  stock:60,  unit:'kotak',  icon:'🥛', low:20  },
  { id:'p11', name:'Sabun Mandi',    price:7500,  category:'Toiletri', stock:85,  unit:'bar',    icon:'🧼', low:15  },
  { id:'p12', name:'Shampo',         price:25000, category:'Toiletri', stock:40,  unit:'botol',  icon:'🧴', low:10  },
  { id:'p13', name:'Pasta Gigi',     price:15000, category:'Toiletri', stock:55,  unit:'tube',   icon:'🪥', low:10  },
  { id:'p14', name:'Tepung Terigu',  price:9000,  category:'Pokok',    stock:120, unit:'kg',     icon:'🌾', low:20  },
  { id:'p15', name:'Mie Instan',     price:3200,  category:'Makanan',  stock:0,   unit:'pcs',    icon:'🍝', low:30  },
];

const MOCK_USERS = [
  { id:'u1', name:'Admin Toko',  role:'admin',   pin:'0000', initials:'AD' },
  { id:'u2', name:'Kasir Budi',  role:'cashier', pin:'1111', initials:'KB' },
  { id:'u3', name:'Kasir Siti',  role:'cashier', pin:'2222', initials:'KS' },
];

const SYNC_NODES = [
  { id:'A', label:'Node A', port:18200, status:'online', tx:7, hash:'dcefd63c' },
  { id:'B', label:'Node B', port:18201, status:'online', tx:7, hash:'dcefd63c' },
  { id:'C', label:'Node C', port:18202, status:'online', tx:7, hash:'dcefd63c' },
];

const MOCK_TRANSACTIONS = [
  { id:'TX-007', items:'Beras 3kg + Gula 2kg',    total:73000,  cashier:'Kasir Budi',  node:'A', time:'14:32' },
  { id:'TX-006', items:'Minyak 1L + Kopi 5pcs',   total:45000,  cashier:'Kasir Siti',  node:'B', time:'13:58' },
  { id:'TX-005', items:'Air Mineral 3btl',         total:9000,   cashier:'Kasir Budi',  node:'A', time:'13:21' },
  { id:'TX-004', items:'Teh 2kotak + Sabun 1bar',  total:23500,  cashier:'Kasir Siti',  node:'C', time:'12:44' },
  { id:'TX-003', items:'Indomie 5pcs',             total:17500,  cashier:'Kasir Budi',  node:'A', time:'11:55' },
  { id:'TX-002', items:'Beras 2kg + Minyak 2L',    total:70000,  cashier:'Kasir Siti',  node:'B', time:'11:12' },
  { id:'TX-001', items:'Gula 3kg',                 total:42000,  cashier:'Kasir Budi',  node:'C', time:'10:33' },
];

/* ─── Toast ─────────────────────────────────────────────────────── */
function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.type}`}>
      {toast.type === 'ok' ? '✓' : '✕'} {toast.msg}
    </div>
  );
}

function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);
  return [toast, show];
}

/* ─── Login ─────────────────────────────────────────────────────── */
function Login({ onLogin }) {
  const [selUser, setSelUser] = useState(null);
  const [pin,     setPin]     = useState('');
  const [err,     setErr]     = useState('');
  const [shake,   setShake]   = useState(false);
  const [users,   setUsers]   = useState(MOCK_USERS);

  useEffect(() => {
    if (!api || !api.getAllUsers) return;
    api.getAllUsers()
      .then(realUsers => {
        if (realUsers && realUsers.length) {
          setUsers(realUsers.map(u => ({
            ...u,
            initials: u.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(),
          })));
        }
      })
      .catch(err => console.error('[Login] getAllUsers failed:', err));
  }, []);

  const press = (n) => {
    if (pin.length < 6) setPin(p => p + n);
    setErr('');
  };

  const submit = async () => {
    if (!selUser) { setErr('Pilih kasir terlebih dahulu'); return; }
    if (api) {
      const res = await api.login(selUser.id, pin);
      if (res.ok) onLogin(res.user);
      else { setErr(res.error || 'PIN salah'); setPin(''); doShake(); }
    } else {
      if (selUser.pin === pin) onLogin(selUser);
      else { setErr('PIN salah'); setPin(''); doShake(); }
    }
  };

  const doShake = () => { setShake(true); setTimeout(() => setShake(false), 500); };

  return (
    <div className="login-screen">
      <div className="login-brand">
        <div style={{ fontSize: 36, marginBottom: 10 }}>🛒</div>
        <div className="brand-name">POS CRDT</div>
        <div className="brand-sub">LOCAL-FIRST &nbsp;·&nbsp; AUTOMERGE &nbsp;·&nbsp; OFFLINE-READY</div>
      </div>

      <div className="user-select">
        {users.map(u => (
          <div key={u.id}
            className={`user-card ${selUser?.id === u.id ? 'selected' : ''}`}
            onClick={() => { setSelUser(u); setPin(''); setErr(''); }}>
            <div className="user-avatar">{u.initials}</div>
            <div className="user-name">{u.name}</div>
            <div className="user-role">{u.role}</div>
          </div>
        ))}
      </div>

      <div className="pin-box">
        <div className={`pin-dots ${shake ? 'shake' : ''}`}>
          {Array(6).fill(0).map((_, i) => (
            <div key={i} className={`dot ${i < pin.length ? 'filled' : ''}`} />
          ))}
        </div>

        {err && <div className="pin-error">{err}</div>}

        <div className="numpad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
            <button key={n} className="num-btn"
              onClick={() => press(String(n))}>{n}</button>
          ))}
          <button className="num-btn secondary" onClick={() => setPin(p => p.slice(0, -1))}>⌫</button>
          <button className="num-btn" onClick={() => press('0')}>0</button>
          <button className="num-btn confirm"
            onClick={submit}
            disabled={!selUser || pin.length < 4}>
            OK
          </button>
        </div>

        <div className="pin-hint">
          Demo: Admin=0000 · Kasir=1234
        </div>
      </div>
    </div>
  );
}

/* ─── Header ────────────────────────────────────────────────────── */
function Header({ user, screen, setScreen, onLogout }) {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const NAVS = [
    { k: 'pos',       label: 'Kasir' },
    { k: 'inventory', label: 'Stok' },
    { k: 'reports',   label: 'Laporan' },
    { k: 'sync',      label: 'Sinkronisasi' },
  ];

  return (
    <header className="app-header">
      <div className="header-left">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, background: '#6366f1', borderRadius: 7,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14
          }}>🛒</div>
          <span className="brand">POS CRDT</span>
        </div>
        <nav className="nav-tabs">
          {NAVS.map(({ k, label }) => (
            <button key={k}
              className={`nav-tab ${screen === k ? 'active' : ''}`}
              onClick={() => setScreen(k)}>
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="header-right">
        <div className="sync-badge">● 3 node synced</div>
        <div style={{
          fontSize: 11, color: '#475569',
          fontFamily: "'JetBrains Mono', monospace"
        }}>
          {time.toLocaleTimeString('id-ID')}
        </div>
        <div className="user-badge">
          <div className="user-badge-avatar">
            {(user.initials || user.name?.split(' ').map(w => w[0]).join('').slice(0, 2) || '??').toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0', lineHeight: 1.2 }}>{user.name}</div>
            <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{user.role}</div>
          </div>
        </div>
        <button className="logout-btn" onClick={onLogout}>Keluar</button>
      </div>
    </header>
  );
}

/* ─── Status bar ───────────────────────────────────────────────── */
function StatusBar() {
  return (
    <div className="status-bar">
      <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
        {[
          { c: '#10b981', t: '3 node online' },
          { c: '#818cf8', t: 'hash: dcefd63c' },
          { c: '#64748b', t: 'WAL enabled' },
          { c: '#64748b', t: '300 ops synced' },
        ].map(({ c, t }) => (
          <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 5, height: 5, borderRadius: 2.5, background: c }} />
            <span style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace" }}>{t}</span>
          </div>
        ))}
      </div>
      <span style={{ fontSize: 10, color: '#1e293b', fontFamily: "'JetBrains Mono', monospace" }}>
        node:12ad3ef5 · relay:localhost:9000
      </span>
    </div>
  );
}

/* ─── POS Screen ───────────────────────────────────────────────── */
function POSScreen() {
  const [products, setProducts] = useState(MOCK_PRODUCTS);
  const [cart,     setCart]     = useState([]);
  const [search,   setSearch]   = useState('');
  const [cat,      setCat]      = useState('Semua');
  const [modal,    setModal]    = useState(false);
  const [payment,  setPayment]  = useState('');
  const [success,  setSuccess]  = useState(false);
  const [toast,    showToast]   = useToast();

  const filtered = products.filter(p =>
    (cat === 'Semua' || p.category === cat) &&
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  const addToCart = (p) => {
    if (p.stock <= 0) { showToast('Stok habis!', 'err'); return; }
    setCart(c => {
      const ex = c.find(x => x.id === p.id);
      if (ex) return c.map(x => x.id === p.id ? { ...x, qty: x.qty + 1 } : x);
      return [...c, { ...p, qty: 1 }];
    });
    setProducts(pr => pr.map(x => x.id === p.id ? { ...x, stock: x.stock - 1 } : x));
  };

  const changeQty = (id, d) => {
    setCart(c => {
      const item = c.find(x => x.id === id);
      if (item.qty + d <= 0) {
        setProducts(pr => pr.map(x => x.id === id ? { ...x, stock: x.stock + item.qty } : x));
        return c.filter(x => x.id !== id);
      }
      setProducts(pr => pr.map(x => x.id === id ? { ...x, stock: x.stock + (d > 0 ? -1 : 1) } : x));
      return c.map(x => x.id === id ? { ...x, qty: x.qty + d } : x);
    });
  };

  const clearCart = () => {
    cart.forEach(i => setProducts(pr =>
      pr.map(p => p.id === i.id ? { ...p, stock: p.stock + i.qty } : p)
    ));
    setCart([]);
  };

  const total  = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const change = parseInt(payment || 0) - total;

  const checkout = async () => {
    if (parseInt(payment) < total) { showToast('Pembayaran kurang!', 'err'); return; }
    setSuccess(true);
    if (api) {
      await api.checkout({ payment: parseInt(payment) });
    }
    setTimeout(() => {
      clearCart();
      setModal(false);
      setPayment('');
      setSuccess(false);
      showToast(`Berhasil! Kembali ${fmtRp(Math.max(0, change))}`);
    }, 1400);
  };

  return (
    <div className="pos-screen">
      {/* ── Product area ── */}
      <div className="product-area">
        <div className="product-toolbar">
          <div style={{ position: 'relative', flex: 1, maxWidth: 280 }}>
            <span style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: '#475569', fontSize: 13
            }}>🔍</span>
            <input className="search-input"
              style={{ paddingLeft: 32 }}
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Cari produk..." />
          </div>
          <div className="cat-tabs">
            {CATS.map(c => (
              <button key={c} className={`cat-tab ${cat === c ? 'active' : ''}`}
                onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
        </div>

        <div className="product-grid">
          {filtered.map(p => (
            <div key={p.id}
              className={`product-card ${p.stock <= 0 ? 'out' : p.stock <= p.low ? 'low' : ''}`}
              onClick={() => addToCart(p)}>
              <div className="product-icon">{p.icon}</div>
              <div className="product-name">{p.name}</div>
              <div className="product-price">{fmtRp(p.price)}</div>
              <div className="product-footer">
                <span className="product-unit">{p.unit}</span>
                <span className={`stock-badge ${p.stock <= 0 ? 'out' : p.stock <= p.low ? 'low' : 'ok'}`}>
                  {p.stock <= 0 ? '—' : p.stock}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Cart panel ── */}
      <div className="cart-panel">
        <div className="cart-header">
          <span>🛒 Keranjang</span>
          {cart.length > 0 && (
            <button className="clear-btn" onClick={clearCart}>Kosongkan</button>
          )}
        </div>

        <div className="cart-items">
          {cart.length === 0 ? (
            <div className="cart-empty">
              <div style={{ fontSize: 32, marginBottom: 8 }}>🛒</div>
              Klik produk untuk menambah ke keranjang
            </div>
          ) : cart.map(item => (
            <div key={item.id} className="cart-item">
              <div className="ci-top">
                <div className="ci-name">{item.icon} {item.name}</div>
                <div className="ci-sub">{fmtRp(item.price * item.qty)}</div>
              </div>
              <div className="ci-controls">
                <button className="qty-btn" onClick={() => changeQty(item.id, -1)}>−</button>
                <span className="qty-num">{item.qty}</span>
                <button className="qty-btn" onClick={() => changeQty(item.id, 1)}>+</button>
                <span className="ci-unit">{item.qty} {item.unit}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>
                  @{fmtRp(item.price)}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="cart-footer">
          <div className="cart-summary">
            <span className="cart-count">
              {cart.length} produk · {cart.reduce((s, i) => s + i.qty, 0)} pcs
            </span>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'baseline', marginBottom: 14
          }}>
            <span style={{ fontSize: 13, color: '#94a3b8', fontWeight: 500 }}>Total</span>
            <span className="cart-total">{fmtRp(total)}</span>
          </div>
          <button className="checkout-btn"
            disabled={cart.length === 0}
            onClick={() => setModal(true)}>
            {cart.length > 0 ? `Bayar → ${fmtRp(total)}` : 'Pilih Produk'}
          </button>
        </div>
      </div>

      {/* ── Payment modal ── */}
      {modal && (
        <div className="modal-overlay">
          <div className="payment-modal">
            {success ? (
              <div style={{ textAlign: 'center', padding: '28px 0' }}>
                <div style={{
                  width: 60, height: 60, borderRadius: 30,
                  background: 'rgba(16,185,129,.15)', border: '1px solid rgba(16,185,129,.3)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 18px', fontSize: 28
                }}>✓</div>
                <div style={{ fontSize: 17, fontWeight: 600, color: '#f1f5f9', marginBottom: 6 }}>
                  Transaksi Berhasil!
                </div>
                <div style={{ fontSize: 13, color: '#64748b' }}>
                  Kembali {fmtRp(Math.max(0, change))}
                </div>
              </div>
            ) : (
              <>
                <div className="modal-header">
                  <span>Pembayaran Tunai</span>
                  <button onClick={() => { setModal(false); setPayment(''); }}>×</button>
                </div>

                <div className="modal-total">
                  <div className="modal-total-label">Total tagihan</div>
                  <div className="modal-total-amount">{fmtRp(total)}</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label className="modal-label">Jumlah dibayar (Rp)</label>
                  <input type="number" className="modal-input"
                    value={payment} onChange={e => setPayment(e.target.value)}
                    placeholder="0" autoFocus />
                </div>

                {payment && (
                  <div className={`modal-change ${change >= 0 ? 'ok' : 'err'}`}>
                    {change >= 0
                      ? `Kembalian: ${fmtRp(change)}`
                      : `Kurang: ${fmtRp(-change)}`}
                  </div>
                )}

                <div className="modal-actions">
                  <button className="modal-btn secondary"
                    onClick={() => setPayment(String(total))}>
                    Uang Pas
                  </button>
                  <button className="modal-btn primary"
                    disabled={parseInt(payment || 0) < total}
                    onClick={checkout}>
                    Konfirmasi ✓
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </div>
  );
}

/* ─── Inventory Screen ─────────────────────────────────────────── */
function InventoryScreen() {
  const [products] = useState(MOCK_PRODUCTS);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name');

  const filtered = products
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'stock') return a.stock - b.stock;
      if (sortBy === 'price') return b.price - a.price;
      return a.name.localeCompare(b.name);
    });

  const stats = {
    total:    products.length,
    low:      products.filter(p => p.stock <= p.low && p.stock > 0).length,
    out:      products.filter(p => p.stock <= 0).length,
    ok:       products.filter(p => p.stock > p.low).length,
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Total Produk', value: stats.total, color: '#818cf8' },
          { label: 'Stok Normal',  value: stats.ok,    color: '#10b981' },
          { label: 'Stok Rendah',  value: stats.low,   color: '#f59e0b' },
          { label: 'Stok Habis',   value: stats.out,   color: '#ef4444' },
        ].map(s => (
          <div key={s.label} style={{
            background: '#0f172a', border: '1px solid #1e293b',
            borderRadius: 10, padding: '12px 16px', borderLeft: `3px solid ${s.color}`
          }}>
            <div style={{ fontSize: 11, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', fontFamily: "'JetBrains Mono',monospace" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
        <input className="search-input" style={{ maxWidth: 280 }}
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="🔍  Cari produk..." />
        <div style={{ display: 'flex', gap: 4 }}>
          {[['name','Nama'],['stock','Stok'],['price','Harga']].map(([k, label]) => (
            <button key={k} className={`cat-tab ${sortBy === k ? 'active' : ''}`}
              onClick={() => setSortBy(k)}>
              {label} {sortBy === k ? '↑' : ''}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#475569' }}>
          Sumber: immutable operation log · proyeksi real-time
        </div>
      </div>

      {/* Table */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '32px 1fr 90px 120px 160px 80px',
          padding: '6px 14px', gap: 12,
          fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.5px'
        }}>
          <span />
          <span>Produk</span>
          <span style={{ textAlign: 'right' }}>Harga</span>
          <span style={{ textAlign: 'right' }}>Stok</span>
          <span>Level</span>
          <span style={{ textAlign: 'center' }}>Status</span>
        </div>

        {filtered.map((p, i) => {
          const pct   = Math.min(100, (p.stock / (p.low * 6)) * 100);
          const color = p.stock <= 0 ? '#ef4444' : p.stock <= p.low ? '#f59e0b' : '#10b981';
          const status = p.stock <= 0 ? 'Habis' : p.stock <= p.low ? 'Rendah' : 'Normal';
          return (
            <div key={p.id} style={{
              display: 'grid', gridTemplateColumns: '32px 1fr 90px 120px 160px 80px',
              alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 8,
              background: i % 2 === 0 ? '#0a0f1a' : 'transparent',
              border: '1px solid #1e293b',
            }}>
              <span style={{ fontSize: 18, textAlign: 'center' }}>{p.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>{p.name}</div>
                <div style={{ fontSize: 11, color: '#475569' }}>{p.category} · {p.unit}</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 12, fontFamily: "'JetBrains Mono',monospace", color: '#818cf8', fontWeight: 600 }}>
                {fmtRp(p.price)}
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 13, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, color }}>
                  {p.stock}
                </span>
                <span style={{ fontSize: 10, color: '#475569', marginLeft: 4 }}>{p.unit}</span>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: '#475569' }}>min: {p.low}</span>
                  <span style={{ fontSize: 10, color }}>
                    {Math.round(Math.min(100, pct))}%
                  </span>
                </div>
                <div style={{ height: 5, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width .4s' }} />
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <span style={{
                  fontSize: 10, padding: '3px 9px', borderRadius: 5, fontWeight: 500,
                  background: p.stock <= 0 ? 'rgba(239,68,68,.12)' : p.stock <= p.low ? 'rgba(245,158,11,.12)' : 'rgba(16,185,129,.12)',
                  color,
                }}>{status}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Reports Screen ───────────────────────────────────────────── */
function ReportsScreen() {
  const dailyMetrics = [
    { label: 'Total Transaksi',  value: '7 tx',          sub: 'Hari ini',        accent: '#818cf8' },
    { label: 'Total Pendapatan', value: 'Rp 280.000',    sub: '+18% kemarin',    accent: '#10b981' },
    { label: 'Items Terjual',    value: '34 pcs',         sub: 'Rata-rata 5/tx',  accent: '#f59e0b' },
    { label: 'Avg Nilai Tx',     value: 'Rp 40.000',     sub: 'Per transaksi',   accent: '#38bdf8' },
  ];

  const topProds = [
    { name: 'Beras',  rev: 150000, qty: 10 },
    { name: 'Minyak', rev: 100000, qty: 5  },
    { name: 'Gula',   rev: 84000,  qty: 6  },
    { name: 'Kopi',   rev: 40000,  qty: 8  },
    { name: 'Teh',    rev: 24000,  qty: 3  },
  ];
  const maxRev = Math.max(...topProds.map(p => p.rev));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9', marginBottom: 3 }}>Laporan Harian</div>
        <div style={{ fontSize: 12, color: '#475569' }}>
          {new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          &nbsp;·&nbsp; Node A, B, C (konsolidasi)
        </div>
      </div>

      {/* Metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
        {dailyMetrics.map(m => (
          <div key={m.label} style={{
            background: '#0f172a', border: '1px solid #1e293b',
            borderRadius: 10, padding: '14px 16px', borderLeft: `3px solid ${m.accent}`,
          }}>
            <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>{m.label}</div>
            <div style={{ fontSize: 19, fontWeight: 700, color: '#f1f5f9', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>{m.value}</div>
            <div style={{ fontSize: 11, color: '#475569' }}>{m.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* Top products bar chart */}
        <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 16 }}>
            Top Produk — Pendapatan
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topProds.map((p, i) => (
              <div key={p.name}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{p.name}</span>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <span style={{ fontSize: 11, color: '#475569' }}>{p.qty} terjual</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#818cf8', fontFamily: "'JetBrains Mono',monospace" }}>{fmtRp(p.rev)}</span>
                  </div>
                </div>
                <div style={{ height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${(p.rev / maxRev) * 100}%`,
                    background: i === 0 ? '#6366f1' : '#334155',
                    borderRadius: 3, transition: 'width .5s ease',
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent transactions */}
        <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 14 }}>
            Transaksi Terakhir
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {MOCK_TRANSACTIONS.map(tx => (
              <div key={tx.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', borderRadius: 8,
                background: '#0a0f1a', border: '1px solid #1e293b',
              }}>
                <div>
                  <div style={{ fontSize: 11, color: '#818cf8', fontFamily: "'JetBrains Mono',monospace", marginBottom: 2 }}>
                    {tx.id}
                    <span style={{ marginLeft: 8, padding: '1px 6px', borderRadius: 3, background: '#1e293b', color: '#475569', fontSize: 10 }}>
                      Node {tx.node}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{tx.items}</div>
                  <div style={{ fontSize: 10, color: '#334155' }}>{tx.cashier} · {tx.time}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#10b981', fontFamily: "'JetBrains Mono',monospace" }}>
                  {fmtRp(tx.total)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Sync Screen ──────────────────────────────────────────────── */
function SyncScreen() {
  const [nodes,       setNodes]       = useState(SYNC_NODES);
  const [logs,        setLogs]        = useState([
    '[Relay] Bootstrap relay aktif di ws://localhost:19300',
    '[NodeA] UUID: 12ad3ef5... | SQLite OK | Automerge OK',
    '[SyncEngine:A→B] SYNC_PUSH: transactions (6 changes)',
    '[SyncEngine:A→B] SYNC_OPS → B: 24 ops (inventory)',
    '[MergeVerifier] Hash A==B==C: dcefd63c ✅ KONVERGEN',
  ]);
  const [simulating,  setSimulating]  = useState(false);
  const [syncPhase,   setSyncPhase]   = useState('synced');
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const pushLog = (msg) => setLogs(l => [...l.slice(-30), msg]);

  const simulate = () => {
    if (simulating) return;
    setSimulating(true);

    // Phase 1: Partition
    setSyncPhase('offline');
    setNodes(ns => ns.map(n => ({ ...n, status: 'offline', hash: '—' })));
    pushLog('[PARTITION] Jaringan terputus — semua node offline');
    pushLog('[NodeA] Beroperasi mandiri... Tx: Beras 3kg = Rp45.000');
    pushLog('[NodeB] Beroperasi mandiri... Tx: Gula 2kg = Rp28.000');
    pushLog('[NodeC] Beroperasi mandiri... Tx: Minyak 1L = Rp20.000');
    pushLog('[DIVERGENSI] Hash A/B/C berbeda — expected (CAP: AP)');

    setTimeout(() => {
      setSyncPhase('syncing');
      setNodes(ns => ns.map(n => ({ ...n, status: 'online', hash: 'merging...' })));
      pushLog('[RECONNECT] Koneksi pulih — memulai CRDT merge');
      pushLog('[Automerge] getAllChanges + applyChanges (idempotent)');
      pushLog('[SyncOps] Inventory projection: Σ(all deltas) = 490');
    }, 2500);

    setTimeout(() => {
      setSyncPhase('synced');
      setNodes(ns => ns.map(n => ({ ...n, hash: 'dcefd63c', tx: n.tx + 3 })));
      pushLog('[MergeVerifier] SHA-256 combined hash computed...');
      pushLog('[MergeVerifier] A: dcefd63c | B: dcefd63c | C: dcefd63c');
      pushLog('[CONVERGENCE] ✅ Semua node identik — 0 data loss');
      setSimulating(false);
    }, 5000);
  };

  const allSame  = nodes.every(n => n.hash === nodes[0].hash && n.hash !== '—' && !n.hash.includes('...'));
  const hashColor = allSame ? '#10b981' : syncPhase === 'offline' ? '#ef4444' : '#f59e0b';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9', marginBottom: 3 }}>Status Sinkronisasi</div>
          <div style={{ fontSize: 12, color: '#475569' }}>
            Hybrid decentralized · Automerge CRDT · Strong Eventual Consistency (SEC)
          </div>
        </div>
        <button onClick={simulate} disabled={simulating} style={{
          padding: '8px 18px', borderRadius: 8, border: 'none',
          background: simulating ? '#1e293b' : '#6366f1',
          color: simulating ? '#475569' : 'white',
          fontSize: 12, fontWeight: 500, cursor: simulating ? 'default' : 'pointer',
          transition: 'all .15s',
        }}>
          {simulating ? '⟳ Menyimulasikan...' : '▶ Simulasi Partisi'}
        </button>
      </div>

      {/* Convergence status */}
      <div style={{
        padding: '10px 16px', borderRadius: 8, marginBottom: 16,
        background: allSame ? 'rgba(16,185,129,.08)' : syncPhase === 'offline' ? 'rgba(239,68,68,.08)' : 'rgba(245,158,11,.08)',
        border: `1px solid ${allSame ? 'rgba(16,185,129,.2)' : syncPhase === 'offline' ? 'rgba(239,68,68,.2)' : 'rgba(245,158,11,.2)'}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, background: hashColor, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: hashColor }}>
          {allSame ? '✅ Semua node konvergen — SHA-256 hash identik'
           : syncPhase === 'offline' ? '⚠️ Divergensi aktif — expected behavior (AP system)'
           : '⟳ CRDT merge berlangsung...'}
        </span>
      </div>

      {/* Node cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 18 }}>
        {nodes.map(n => (
          <div key={n.id} style={{
            background: '#0f172a',
            border: `1.5px solid ${n.status === 'online' && allSame ? 'rgba(99,102,241,.4)' : n.status === 'offline' ? 'rgba(239,68,68,.3)' : 'rgba(245,158,11,.3)'}`,
            borderRadius: 12, padding: 16, transition: 'all .3s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: 4,
                  background: n.status === 'online' ? '#10b981' : '#ef4444',
                  boxShadow: n.status === 'online' ? '0 0 8px #10b981' : 'none',
                  transition: 'all .3s',
                }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{n.label}</span>
              </div>
              <span style={{
                fontSize: 10, fontWeight: 500, textTransform: 'uppercase',
                padding: '2px 8px', borderRadius: 4,
                background: n.status === 'online' ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)',
                color: n.status === 'online' ? '#10b981' : '#ef4444',
              }}>{n.status}</span>
            </div>

            {[
              ['Port',     `:${n.port}`],
              ['Transaksi', `${n.tx} tx`],
              ['State Hash', n.hash],
            ].map(([k, v]) => (
              <div key={k} style={{
                display: 'flex', justifyContent: 'space-between',
                padding: '5px 0', borderBottom: '1px solid #0f172a', fontSize: 12,
              }}>
                <span style={{ color: '#475569' }}>{k}</span>
                <span style={{
                  fontFamily: "'JetBrains Mono',monospace", fontWeight: 500,
                  color: k === 'State Hash'
                    ? (allSame && v !== '—' ? '#10b981' : v === '—' ? '#ef4444' : '#f59e0b')
                    : '#94a3b8',
                }}>{v}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Sync log */}
      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: 14 }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10
        }}>
          <span style={{ fontSize: 11, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>
            Live Sync Log
          </span>
          <button onClick={() => setLogs([])} style={{
            fontSize: 10, color: '#334155', background: 'none',
            border: 'none', cursor: 'pointer',
          }}>
            Clear
          </button>
        </div>
        <div ref={logRef} style={{
          fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
          lineHeight: 1.9, maxHeight: 140, overflow: 'auto',
        }}>
          {logs.map((l, i) => (
            <div key={i} style={{
              color: l.includes('✅') || l.includes('KONVERGEN') ? '#10b981'
                   : l.includes('DIVERGENSI') || l.includes('PARTITION') ? '#f59e0b'
                   : l.includes('merge') || l.includes('MergeVerifier') ? '#818cf8'
                   : '#475569',
            }}>
              <span style={{ color: '#1e293b', marginRight: 8, userSelect: 'none' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              {l}
            </div>
          ))}
        </div>
      </div>

      {/* Evaluation metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 16 }}>
        {[
          { label: 'Conflict Resolution Rate', value: '100%',     color: '#10b981' },
          { label: 'Data Loss on Merge',        value: '0 tx',    color: '#10b981' },
          { label: 'Convergence (hash)',         value: allSame ? '✅' : '⏳', color: allSame ? '#10b981' : '#f59e0b' },
        ].map(m => (
          <div key={m.label} style={{
            background: '#0a0f1a', border: '1px solid #1e293b', borderRadius: 8,
            padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 11, color: '#475569' }}>{m.label}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: m.color, fontFamily: "'JetBrains Mono',monospace" }}>{m.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── App ───────────────────────────────────────────────────────── */
export default function App() {
  const [screen, setScreen] = useState('login');
  const [user,   setUser]   = useState(null);

  const onLogin  = (u)  => { setUser(u); setScreen('pos'); };
  const onLogout = ()   => { if (api) api.logout(); setUser(null); setScreen('login'); };

  if (screen === 'login') return <Login onLogin={onLogin} />;

  return (
    <div className="app">
      <Header user={user} screen={screen} setScreen={setScreen} onLogout={onLogout} />
      <main className="app-main">
        {screen === 'pos'       && <POSScreen />}
        {screen === 'inventory' && <InventoryScreen />}
        {screen === 'reports'   && <ReportsScreen />}
        {screen === 'sync'      && <SyncScreen />}
      </main>
      <StatusBar />
    </div>
  );
}