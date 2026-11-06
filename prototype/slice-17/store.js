'use strict';
// انبار دادهٔ نمونه با «نقطهٔ گلوگاه» دسترسی (۱۲ §۱ ردیف ۵ + RLS §۲)
// قاعده: هر پرس‌وجو فقط داخل withTenant اجرا می‌شود؛ tenant از نشست می‌آید نه از ورودی.
// نبودِ context ⇒ صفر ردیف. نوشتن با tenant_id ناهم‌خوان ⇒ رد (معادل WITH CHECK).

const crypto = require('node:crypto');

class Denied extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

class Store {
  constructor() {
    this.tables = new Map(); // name → rows[]
    this.tenants = new Map();
  }

  createTenant({ id, code, name }) {
    this.tenants.set(id, { id, code, name, status: 'live' });
    return this.tenants.get(id);
  }

  insertRow(ctx, table, row) {
    if (!ctx || !ctx.tenant_id) throw new Denied('tenant_required');
    if (!row || row.tenant_id !== ctx.tenant_id) throw new Denied('rls_with_check');
    if (!this.tables.has(table)) this.tables.set(table, []);
    this.tables.get(table).push(row);
    return row;
  }

  // خواندن: فیلتر tenant همیشه اعمال می‌شود، حتی اگر فراخوان آن را نفرستد
  select(ctx, table, predicate = () => true) {
    if (!ctx || !ctx.tenant_id) throw new Denied('tenant_required');
    const rows = this.tables.get(table) || [];
    return rows.filter((r) => r.tenant_id === ctx.tenant_id && predicate(r));
  }

  updateRow(ctx, table, id, patch) {
    if (!ctx || !ctx.tenant_id) throw new Denied('tenant_required');
    const rows = this.tables.get(table) || [];
    const row = rows.find((r) => r.id === id);
    // ردیف مستأجر دیگر «وجود ندارد» (نه خطای افشاگر)
    if (!row || row.tenant_id !== ctx.tenant_id) throw new Denied('not_found');
    if (patch && patch.tenant_id && patch.tenant_id !== ctx.tenant_id) throw new Denied('rls_with_check');
    Object.assign(row, patch);
    return row;
  }

  deleteRow(ctx, table, id) {
    if (!ctx || !ctx.tenant_id) throw new Denied('tenant_required');
    const rows = this.tables.get(table) || [];
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0 || rows[i].tenant_id !== ctx.tenant_id) throw new Denied('not_found');
    return rows.splice(i, 1)[0];
  }
}

// withTenant: دقیقاً همان الگوی ۱۲ §۲ — context اجباری، سپس اجرا، سپس پاک‌سازی
async function withTenant(session, fn) {
  if (!session || !session.tenant_id) throw new Denied('tenant_required');
  if (!/^[0-9a-f-]{36}$/.test(session.tenant_id)) throw new Denied('tenant_required');
  const ctx = { tenant_id: session.tenant_id, user_id: session.user_id, role: session.role };
  try {
    return await fn(ctx);
  } finally {
    ctx.tenant_id = null; // context پس از تراکنش پاک می‌شود
  }
}

const uuid = () => crypto.randomUUID();

module.exports = { Store, Denied, withTenant, uuid };
