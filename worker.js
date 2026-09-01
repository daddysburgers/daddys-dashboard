/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'   // Xero token endpoint wants HTTP Basic client auth (client_secret_basic)
    },
    async status(env, h) { return xeroStatus(env, h); },
    async fetchRange(env, h, q) { return xeroFetchRange(env, h, q); },
    async fetchMonthly(env, h, q) { return xeroFetchMonthly(env, h, q); }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: true,
    auth: 'token',
    oauth: {},
    async status(env, h) { return squareStatus(env, h); },
    async fetchRange(env, h, q) { return squareRange(env, h, q); },
    async fetchMonthly(env, h, q) { return squareMonthly(env, h, q); },
    async scheduledPull(env, h) { return squareSync(env, h); }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ============================ Xero (accounting) ============================
   Daddy's P&L via Reports/ProfitAndLoss, all GST-exclusive (Xero P&L convention).
     revenue    = trading Income section total (Other Income excluded)
     cogs       = Cost of Sales section total
     wagesSuper = expense lines matching wage/super keywords (Workcover left in
                  overheads, per the owner's decision)
     overheads  = remaining Operating Expenses, minus non-operating lines
                  (interest, tax, depreciation, currency one-offs) so Profit is
                  the operating result (kpi-spec metric 7)
   Reconciliation to the cent is verified against the owner's own P&L.
=========================================================================== */
const XERO_API = 'https://api.xero.com/api.xro/2.0';
const XERO_CONNECTIONS = 'https://api.xero.com/connections';
const WAGE_RE = /\b(wages?|salar(?:y|ies)|superannuation|super|payroll|annual leave|long service)\b/i;
const NONOP_RE = /(income tax|\binterest\b|depreciat|amortis|amortiz|revaluation|foreign currency|unrealised curren|realised curren)/i;
const XMONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function xeroNum(v) {
  if (v == null) return 0;
  let s = String(v).trim().replace(/,/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^0-9.\-]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
}

/* All leaf data rows (RowType 'Row') anywhere inside a report section. */
function xeroLeafRows(section) {
  const out = [];
  const walk = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r) continue;
      if (r.RowType === 'Row' && Array.isArray(r.Cells)) out.push(r);
      if (Array.isArray(r.Rows)) walk(r.Rows);
    }
  };
  walk(section.Rows);
  return out;
}

/* Number of amount columns (one per period), from the report header row. */
function xeroColumnCount(report) {
  const rows = (report && report.Rows) || [];
  const header = rows.find((r) => r && r.RowType === 'Header');
  if (header && Array.isArray(header.Cells)) return Math.max(1, header.Cells.length - 1);
  for (const s of rows) {
    if (s && s.RowType === 'Section') {
      const leaf = xeroLeafRows(s)[0];
      if (leaf && Array.isArray(leaf.Cells)) return Math.max(1, leaf.Cells.length - 1);
    }
  }
  return 1;
}

/* Parse the report into one {revenue,cogs,wagesSuper,overheads} per column. */
function xeroParseColumns(report) {
  const rows = (report && report.Rows) || [];
  const cols = xeroColumnCount(report);
  const acc = [];
  for (let c = 0; c < cols; c++) acc.push({ revenue: 0, cogs: 0, wagesSuper: 0, overheads: 0 });

  for (const section of rows) {
    if (!section || section.RowType !== 'Section') continue;
    const title = String(section.Title || '');
    let kind;
    if (/other income/i.test(title)) kind = 'skip';
    else if (/cost of (sales|goods)/i.test(title)) kind = 'cogs';
    else if (/expense/i.test(title)) kind = 'expenses';
    else if (/income|revenue|trading/i.test(title)) kind = 'revenue';
    else kind = 'skip';
    if (kind === 'skip') continue;

    for (const row of xeroLeafRows(section)) {
      const label = (row.Cells[0] && row.Cells[0].Value) || '';
      for (let c = 0; c < cols; c++) {
        const cell = row.Cells[c + 1];
        const amt = xeroNum(cell && cell.Value);
        if (!amt) continue;
        if (kind === 'revenue') acc[c].revenue += amt;
        else if (kind === 'cogs') acc[c].cogs += amt;
        else if (kind === 'expenses') {
          if (WAGE_RE.test(label)) acc[c].wagesSuper += amt;
          else if (NONOP_RE.test(label)) { /* non-operating: excluded from overheads and profit */ }
          else acc[c].overheads += amt;
        }
      }
    }
  }
  const cents = (x) => Math.round(x * 100) / 100;
  return acc.map((o) => ({ revenue: cents(o.revenue), cogs: cents(o.cogs), wagesSuper: cents(o.wagesSuper), overheads: cents(o.overheads) }));
}

/* Map each report column to a YYYY-MM using the header date labels. */
function xeroHeaderMonths(report) {
  const rows = (report && report.Rows) || [];
  const header = rows.find((r) => r && r.RowType === 'Header');
  const cells = (header && header.Cells) || [];
  const out = [];
  for (let i = 1; i < cells.length; i++) {
    const label = String((cells[i] && cells[i].Value) || '');
    const m = label.match(/([A-Za-z]{3,})\.?\s*[-\s]?\s*(\d{2,4})/);
    let key = null;
    if (m) {
      const mon = XMONTHS[m[1].slice(0, 3).toLowerCase()];
      let yr = parseInt(m[2], 10);
      if (yr < 100) yr += 2000;
      if (mon) key = yr + '-' + String(mon).padStart(2, '0');
    }
    out.push(key);
  }
  return out;
}

async function xeroTenant(env, h) {
  const t = (await h.getTokens()) || {};
  if (t.tenant_id) return t.tenant_id;
  const conns = await h.fetchJson(XERO_CONNECTIONS, { headers: { Accept: 'application/json' } });
  const list = Array.isArray(conns) ? conns : [];
  const org = list.find((c) => String(c.tenantType || '').toUpperCase() === 'ORGANISATION') || list[0];
  if (!org || !org.tenantId) { const e = new Error('no Xero organisation connected'); e.status = 401; throw e; }
  await h.saveTokens({ ...t, tenant_id: org.tenantId, tenant_name: org.tenantName || null });
  return org.tenantId;
}

async function xeroStatus(env, h) {
  const t = await h.getTokens();
  if (!t || !t.access_token) return { connected: false };
  let name = t.tenant_name || null, id = t.tenant_id || null;
  if (!id) {
    const conns = await h.fetchJson(XERO_CONNECTIONS, { headers: { Accept: 'application/json' } });
    const list = Array.isArray(conns) ? conns : [];
    const org = list.find((c) => String(c.tenantType || '').toUpperCase() === 'ORGANISATION') || list[0];
    if (org) { id = org.tenantId; name = org.tenantName || null; await h.saveTokens({ ...t, tenant_id: id, tenant_name: name }); }
  }
  return { connected: !!id, org: name, sandbox: /demo company/i.test(name || '') };
}

async function xeroReport(env, h, params) {
  const tenant = await xeroTenant(env, h);
  const qs = new URLSearchParams(params).toString();
  const report = await h.fetchJson(XERO_API + '/Reports/ProfitAndLoss?' + qs, {
    headers: { 'Xero-Tenant-Id': tenant, Accept: 'application/json' }
  });
  const r = report && report.Reports && report.Reports[0];
  if (!r) { const e = new Error('empty P&L report'); e.status = 502; throw e; }
  return r;
}

/* Inclusive day count of a from..to range. */
function daySpan(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
}
/* Daddy's pays weekly, one Wednesday after each Tuesday period-end, so a week's
   wages post in the FOLLOWING Mon-Sun week. For WEEK-length views only, pull
   wagesSuper from the next week's window so each pay run lines up with the week
   it was worked (revenue/cogs/overheads stay on the real week). Monthly and
   longer views are unaffected — their wage total already reconciles to Xero. */
const WAGE_WEEK_SHIFT_DAYS = 7;

async function xeroFetchRange(env, h, q) {
  const base = xeroParseColumns(await xeroReport(env, h, { fromDate: q.from, toDate: q.to }))[0]
    || { revenue: 0, cogs: 0, wagesSuper: 0, overheads: 0 };
  const span = daySpan(q.from, q.to);
  if (span >= 1 && span <= 8) { /* a week (or part-week) view */
    try {
      const shifted = xeroParseColumns(await xeroReport(env, h, {
        fromDate: addDaysStr(q.from, WAGE_WEEK_SHIFT_DAYS),
        toDate: addDaysStr(q.to, WAGE_WEEK_SHIFT_DAYS)
      }))[0];
      if (shifted) base.wagesSuper = shifted.wagesSuper;
    } catch (e) { /* keep the unshifted wages if the second pull fails */ }
  }
  return base;
}

function emptyMonthly(months) {
  return { months: months, revenue: months.map(() => null), cogs: months.map(() => null), wagesSuper: months.map(() => null), overheads: months.map(() => null) };
}

async function xeroFetchMonthly(env, h, q) {
  const months = monthList(q.fromMonth, q.toMonth);
  const result = {};
  months.forEach((mo) => { result[mo] = null; });
  /* One single-period P&L per month — the exact call the period cards use, so
     the trend ties to those verified numbers. Limited concurrency keeps us well
     under the Worker subrequest budget and Xero's rate/concurrency limits. */
  try { await xeroTenant(env, h); } catch (e) { return emptyMonthly(months); } /* prewarm tenant once */
  const fetchList = months.slice(-12); /* only the 12 the card shows — keeps the request light and fast */
  const CONC = 4;
  let idx = 0;
  const run = async () => {
    while (idx < fetchList.length) {
      const mo = fetchList[idx++];
      const [y, m] = mo.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      try {
        const cols = xeroParseColumns(await xeroReport(env, h, {
          fromDate: mo + '-01', toDate: mo + '-' + String(lastDay).padStart(2, '0')
        }));
        result[mo] = cols[0] || null;
      } catch (e) { result[mo] = null; /* a single bad month never breaks the trend */ }
    }
  };
  const pool = [];
  for (let i = 0; i < Math.min(CONC, months.length); i++) pool.push(run());
  await Promise.all(pool);
  return {
    months: months,
    revenue: months.map((m) => (result[m] ? result[m].revenue : null)),
    cogs: months.map((m) => (result[m] ? result[m].cogs : null)),
    wagesSuper: months.map((m) => (result[m] ? result[m].wagesSuper : null)),
    overheads: months.map((m) => (result[m] ? result[m].overheads : null))
  };
}

/* ============================ Square (POS) ================================
   Supplies ONE number: the completed-transaction count. Never a dollar figure.
   Live paging over long ranges is too heavy for the free tier on a busy
   two-venue account, so the scheduled job (scheduledPull) tallies COMPLETED
   payments into per-day counts in KV (data:pos:YYYY-MM-DD) and the dashboard
   reads those. It re-tallies whole Sydney days (idempotent) for freshness and
   backfills history in chunks, so counts fill in and stay current on the sync
   cadence. Voided/cancelled excluded; refunds are separate records and never
   reduce the count.
=========================================================================== */
const SQUARE_API = 'https://connect.squareup.com';
function squareToken(env) { return env.POS_API_TOKEN || ''; }
async function squareGet(env, path) {
  const res = await fetch(SQUARE_API + path, {
    headers: { Authorization: 'Bearer ' + squareToken(env), Accept: 'application/json' }
  });
  if (!res.ok) { const e = new Error('square ' + res.status); e.status = res.status; throw e; }
  return res.json();
}
/* Sydney calendar date (DST-aware) for a timestamp -> 'YYYY-MM-DD'. */
function sydDate(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lastNDates(endDateStr, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(addDaysStr(endDateStr, -i));
  return out;
}

async function squareLocations(env) {
  const data = await squareGet(env, '/v2/locations');
  return (data && data.locations) || [];
}
async function squareStatus(env, h) {
  if (!squareToken(env)) return { connected: false };
  const locs = await squareLocations(env);
  const active = locs.filter((l) => (l.status || 'ACTIVE') === 'ACTIVE');
  const pick = active[0] || locs[0] || null;
  const name = pick ? (pick.business_name || pick.name || null) : null;
  const label = active.length > 1 ? (name + ' (' + active.length + ' locations)') : name;
  return { connected: locs.length > 0, org: label, sandbox: false };
}

/* Read per-day pos counts from KV in parallel batches (fast, no sequential
   stalls). Returns a date->count map and how many days had stored data. */
async function posReadDays(env, dates) {
  const map = {};
  let days = 0;
  const CH = 50;
  for (let i = 0; i < dates.length; i += CH) {
    const batch = dates.slice(i, i + CH);
    const vals = await Promise.all(batch.map((d) => env.TOKENS.get('data:pos:' + d)));
    for (let j = 0; j < batch.length; j++) {
      if (vals[j] != null) {
        days++;
        try { map[batch[j]] = (JSON.parse(vals[j]).count) || 0; } catch (e) { map[batch[j]] = 0; }
      }
    }
  }
  return { map, days };
}
function datesBetween(from, to) {
  const out = [];
  let d = from;
  while (d <= to && out.length < 800) { out.push(d); d = addDaysStr(d, 1); }
  return out;
}

async function squareRange(env, h, q) {
  const { map, days } = await posReadDays(env, datesBetween(q.from, q.to));
  if (!days) return { count: null }; /* not synced yet -> honest gap, not a false 0 */
  return { count: Object.values(map).reduce((a, b) => a + b, 0) };
}

async function squareMonthly(env, h, q) {
  const months = monthList(q.fromMonth, q.toMonth);
  const allDates = [];
  const monthOf = {};
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let dd = 1; dd <= last; dd++) { const ds = mo + '-' + String(dd).padStart(2, '0'); allDates.push(ds); monthOf[ds] = mo; }
  }
  const { map } = await posReadDays(env, allDates);
  const sums = {}, has = {};
  for (const ds of Object.keys(map)) { const mo = monthOf[ds]; sums[mo] = (sums[mo] || 0) + map[ds]; has[mo] = true; }
  return { months: months, count: months.map((mo) => (has[mo] ? sums[mo] : null)) };
}

/* Count COMPLETED payments for a set of whole Sydney days and store per-day.
   Over-covers the UTC window by a day each side (DST-safe) and buckets each
   payment by its true Sydney date, writing only the requested days. */
async function squareTallyDates(env, h, dates, pageCap) {
  if (!dates.length) return;
  const want = new Set(dates);
  const sorted = dates.slice().sort();
  const beginUtc = addDaysStr(sorted[0], -1) + 'T00:00:00Z';
  const endUtc = addDaysStr(sorted[sorted.length - 1], 2) + 'T00:00:00Z';
  const counts = {};
  for (const d of dates) counts[d] = 0;
  /* Count every active location (Windsor + Richmond) — ListPayments without a
     location_id only returns the main location, which was undercounting. */
  const active = (await squareLocations(env)).filter((l) => (l.status || 'ACTIVE') === 'ACTIVE');
  const locIds = active.map((l) => l.id).filter(Boolean);
  const targets = locIds.length ? locIds : [null];
  for (const locId of targets) {
    let cursor = null, pages = 0;
    do {
      let path = '/v2/payments?sort_order=ASC&limit=100&begin_time=' + encodeURIComponent(beginUtc) + '&end_time=' + encodeURIComponent(endUtc);
      if (locId) path += '&location_id=' + encodeURIComponent(locId);
      if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
      const data = await squareGet(env, path);
      for (const p of (data.payments || [])) {
        if ((p.status || '') !== 'COMPLETED') continue;
        const d = sydDate(p.created_at);
        if (want.has(d)) counts[d]++;
      }
      cursor = data.cursor || null;
      pages++;
    } while (cursor && pages < (pageCap || 40));
  }
  await h.saveIngestedRows(dates.map((d) => ({ date: d, count: counts[d] || 0 })));
}

/* Scheduled tally: keep the last few days fresh, then backfill history in
   20-day chunks moving backward until ~25 months are covered. */
const POS_SYNC_VER = 'loc2'; /* bump to force a full history re-walk after a counting change */

async function squareSync(env, h) {
  if (!squareToken(env)) return;
  const today = sydDate(new Date().toISOString());
  /* If the counting logic changed (e.g. now counting all locations), reset the
     backfill so previously-stored days get re-tallied and corrected. */
  if ((await env.TOKENS.get('pos:sync_ver')) !== POS_SYNC_VER) {
    await env.TOKENS.put('pos:backfill_cursor', addDaysStr(today, 1));
    await env.TOKENS.put('pos:sync_ver', POS_SYNC_VER);
  }
  await squareTallyDates(env, h, lastNDates(today, 3), 40); /* recent days stay fresh */
  const floor = addDaysStr(today, -760);
  const anchor = (await env.TOKENS.get('pos:backfill_cursor')) || addDaysStr(today, 1);
  if (anchor > floor) {
    const chunk = [];
    let d = addDaysStr(anchor, -1);
    for (let i = 0; i < 20 && d >= floor; i++) { chunk.push(d); d = addDaysStr(d, -1); }
    if (chunk.length) {
      await squareTallyDates(env, h, chunk, 40);
      await env.TOKENS.put('pos:backfill_cursor', chunk[chunk.length - 1]);
    }
  }
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: data.periods,
    trend: data.trend
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
