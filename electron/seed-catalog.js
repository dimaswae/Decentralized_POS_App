/**
 * electron/seed-catalog.js
 * Default product catalog for first-run / empty database.
 */
'use strict';

const CATALOG = [
  { name: 'Beras Premium',  price: 15000, unit: 'kg',     category: 'pokok',    icon: '🌾', low: 20, stock: 500 },
  { name: 'Gula Pasir',     price: 14000, unit: 'kg',     category: 'pokok',    icon: '🧂', low: 15, stock: 300 },
  { name: 'Minyak Goreng',  price: 20000, unit: 'liter',  category: 'pokok',    icon: '🫗', low: 10, stock: 200 },
  { name: 'Kopi Tubruk',    price: 5000,  unit: 'sachet', category: 'minuman',  icon: '☕', low: 30, stock: 150 },
  { name: 'Teh Celup',      price: 8000,  unit: 'kotak',  category: 'minuman',  icon: '🍵', low: 20, stock: 100 },
  { name: 'Indomie Goreng', price: 3500,  unit: 'bungkus',category: 'makanan',  icon: '🍜', low: 50, stock: 400 },
  { name: 'Sabun Mandi',    price: 7500,  unit: 'batang', category: 'toiletri', icon: '🧼', low: 15, stock: 80 },
  { name: 'Pasta Gigi',     price: 12000, unit: 'tube',   category: 'toiletri', icon: '🪥', low: 10, stock: 60 },
];

function seedCatalog(facade) {
  const existing = facade.getAllProducts();
  if (existing.length > 0) return { seeded: 0 };

  let count = 0;
  for (const item of CATALOG) {
    const { stock, ...productData } = item;
    const product = facade.addProduct(productData);
    facade.initStock(product.id, stock, 'Stok awal');
    count++;
  }
  console.log(`[Seed] Catalog seeded: ${count} products`);
  return { seeded: count };
}

module.exports = { seedCatalog, CATALOG };
