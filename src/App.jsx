import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Treemap } from "recharts";
import { createClient } from '@supabase/supabase-js';

const API_BASE = "https://whale-backend-n3i3.onrender.com/api";

// ═══════════════════════════════════════════════════════════════
//  SUPABASE CLIENT
// ═══════════════════════════════════════════════════════════════
const SUPABASE_URL = "https://yhcbxgdnodhcpnzihgqe.supabase.co";
const SUPABASE_KEY = "sb_publishable_JrND9fv_dQvz1bqDTcDCSQ_PTIG2eL1";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ═══════════════════════════════════════════════════════════════
//  STORAGE LAYER — Supabase-backed
// ═══════════════════════════════════════════════════════════════
const DB = {
  _cloudStatus: "disconnected",
  _listeners: new Set(),

  onStatusChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  _setStatus(s) { this._cloudStatus = s; this._listeners.forEach(fn => fn(s)); },

  async get(table) {
    try {
      this._setStatus("syncing");
      if (table === "settings") {
        const { data, error } = await supabase.from("settings").select("*").eq("id", 1).single();
        this._setStatus("connected");
        if (error || !data) return null;
        return data;
      }
      const { data, error } = await supabase.from(table).select("*");
      this._setStatus("connected");
      if (error) { console.warn(`[DB.get] ${table}:`, error.message); return null; }
      return data || [];
    } catch (err) {
      console.warn(`[DB.get] ${table} failed:`, err);
      this._setStatus("disconnected");
      return null;
    }
  },

  async set(table, payload) {
    try {
      this._setStatus("syncing");
      if (table === "settings") {
        const row = { id: 1, ...payload };
        const { error } = await supabase.from("settings").upsert(row, { onConflict: "id" });
        this._setStatus(error ? "disconnected" : "connected");
        return !error;
      }

      if (Array.isArray(payload)) {
        const { error: delErr } = await supabase.from(table).delete().neq("id", -999);
        if (delErr) console.warn(`[DB.set] Delete warning:`, delErr.message);

        if (payload.length > 0) {
          const rows = payload.map((row, idx) => {
            const { id, ...data } = row;
            return { ...data, id: idx + 1 };
          });
          const { error: insErr } = await supabase.from(table).insert(rows);
          if (insErr) {
            console.error(`[DB.set] Insert error:`, insErr.message);
            this._setStatus("disconnected");
            return false;
          }
        }
        this._setStatus("connected");
        return true;
      }
      return true;
    } catch (err) {
      console.error(`[DB.set] System failure:`, err);
      this._setStatus("disconnected");
      return false;
    }
  },

  async getPrices() {
    try {
      const { data } = await supabase.from("settings").select("prices_json").eq("id", 1).single();
      return data?.prices_json ? (typeof data.prices_json === "string" ? JSON.parse(data.prices_json) : data.prices_json) : {};
    } catch { return {}; }
  },
  async setPrices(prices) {
    try {
      await supabase.from("settings").update({ prices_json: prices }).eq("id", 1);
      return true;
    } catch { return false; }
  },
  async getCache(key) {
    try {
      const { data } = await supabase.from("settings").select("cache_json").eq("id", 1).single();
      const cache = data?.cache_json ? (typeof data.cache_json === "string" ? JSON.parse(data.cache_json) : data.cache_json) : {};
      return cache[key] || null;
    } catch { return null; }
  },
  async setCache(key, value) {
    try {
      const { data } = await supabase.from("settings").select("cache_json").eq("id", 1).single();
      const cache = data?.cache_json ? (typeof data.cache_json === "string" ? JSON.parse(data.cache_json) : data.cache_json) : {};
      cache[key] = value;
      await supabase.from("settings").update({ cache_json: cache }).eq("id", 1);
      return true;
    } catch { return false; }
  },

  async init() {
    try {
      this._setStatus("syncing");
      const { data: settingsRow } = await supabase.from("settings").select("id").eq("id", 1).single();
      if (!settingsRow) {
        await supabase.from("settings").insert({
          id: 1,
          target_nav: 200000,
          monthly_expenses: 1500,
          expected_annual_return: 0.10,
          fed_next_meeting: "2026-06-18",
          fed_prob_hold: 62,
          fed_prob_cut: 33,
          fed_prob_hike: 5,
          prices_json: {},
          cache_json: {},
        });
      }
      const { data: existingAssets } = await supabase.from("assets").select("id").limit(1);
      if (!existingAssets || existingAssets.length === 0) {
        await supabase.from("assets").insert([
          { id: 1, ticker: "SPYI", account_type: "Taxable", target_weight: 40 },
          { id: 2, ticker: "QQQI", account_type: "Taxable", target_weight: 30 },
          { id: 3, ticker: "SCHG", account_type: "Taxable", target_weight: 30 },
          { id: 4, ticker: "JEPQ", account_type: "Roth", target_weight: 40 },
          { id: 5, ticker: "JEPI", account_type: "Roth", target_weight: 30 },
        ]);
      }
      this._setStatus("connected");
      console.log("[DB] Supabase initialized successfully");
    } catch (err) {
      console.warn("[DB] init failed:", err);
      this._setStatus("disconnected");
    }
  },

  async migrateFromLocalStorage() {
    try {
      const migrated = await this.getCache("__migrated_from_localstorage");
      if (migrated) return;
      console.log("[DB] Checking for old window.storage data to migrate...");
      let oldSettings, oldIncome, oldAssets, oldTransactions, oldSbloc, oldDividends, oldActions, oldPrices;
      try {
        const _get = async (k) => {
          try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; }
          catch { return null; }
        };
        oldSettings = await _get("whale:settings");
        oldIncome = await _get("whale:income");
        oldAssets = await _get("whale:assets");
        oldTransactions = await _get("whale:transactions");
        oldSbloc = await _get("whale:sbloc");
        oldDividends = await _get("whale:dividends");
        oldActions = await _get("whale:actions");
        oldPrices = await _get("whale:prices");
      } catch {
        console.log("[DB] No old window.storage found, skipping migration.");
        await this.setCache("__migrated_from_localstorage", true);
        return;
      }
      const hasOldData = oldSettings || (oldIncome && oldIncome.length) || (oldAssets && oldAssets.length) ||
        (oldTransactions && oldTransactions.length) || (oldSbloc && oldSbloc.length) ||
        (oldDividends && oldDividends.length) || (oldActions && oldActions.length);
      if (!hasOldData) {
        console.log("[DB] No old data found to migrate.");
        await this.setCache("__migrated_from_localstorage", true);
        return;
      }
      console.log("[DB] Migrating old data to Supabase...");
      if (oldSettings) {
        const merged = {
          id: 1, target_nav: oldSettings.target_nav ?? 200000, monthly_expenses: oldSettings.monthly_expenses ?? 1500,
          expected_annual_return: oldSettings.expected_annual_return ?? 0.10, fed_next_meeting: oldSettings.fed_next_meeting ?? "2026-06-18",
          fed_prob_hold: oldSettings.fed_prob_hold ?? 62, fed_prob_cut: oldSettings.fed_prob_cut ?? 33, fed_prob_hike: oldSettings.fed_prob_hike ?? 5,
          prices_json: oldPrices || {}, cache_json: {},
        };
        await supabase.from("settings").upsert(merged, { onConflict: "id" });
      }
      if (oldIncome && oldIncome.length > 0) {
        const { data: existing } = await supabase.from("incomes").select("id").limit(1);
        if (!existing || existing.length === 0) {
          const rows = oldIncome.map((r, i) => ({
            id: i + 1, month_year: r.month_year, va: parseFloat(r.va) || 0, w2_gross: parseFloat(r.w2_gross) || 0,
            w2_net: parseFloat(r.w2_net) || 0, mha: parseFloat(r.mha) || 0, pell: parseFloat(r.pell) || 0,
            income_1099: parseFloat(r.income_1099) || 0, other_income: parseFloat(r.other_income) || 0,
          }));
          await supabase.from("incomes").insert(rows);
        }
      }
      if (oldAssets && oldAssets.length > 0) {
        const { data: existing } = await supabase.from("assets").select("id").limit(1);
        if (!existing || existing.length === 0) {
          const rows = oldAssets.map((r, i) => ({ id: i + 1, ticker: r.ticker, account_type: r.account_type, target_weight: r.target_weight }));
          await supabase.from("assets").insert(rows);
        }
      }
      if (oldTransactions && oldTransactions.length > 0) {
        const { data: existing } = await supabase.from("transactions").select("id").limit(1);
        if (!existing || existing.length === 0) {
          const rows = oldTransactions.map((r, i) => ({
            id: r.id || Date.now() + i, date: r.date, ticker: r.ticker, type: r.type,
            shares: parseFloat(r.shares) || 0, price: parseFloat(r.price) || 0, total_amount: parseFloat(r.total_amount) || 0,
          }));
          await supabase.from("transactions").insert(rows);
        }
      }
      if (oldSbloc && oldSbloc.length > 0) {
        const { data: existing } = await supabase.from("sbloc").select("id").limit(1);
        if (!existing || existing.length === 0) {
          const rows = oldSbloc.map((r, i) => ({ id: r.id || i + 1, date: r.date, amount: parseFloat(r.amount) || 0 }));
          await supabase.from("sbloc").insert(rows);
        }
      }
      if (oldDividends && oldDividends.length > 0) {
        const { data: existing } = await supabase.from("dividends").select("id").limit(1);
        if (!existing || existing.length === 0) {
          const rows = oldDividends.map((r, i) => ({
            id: r.id || Date.now() + i, date: r.date, ticker: r.ticker, amount: parseFloat(r.amount) || 0,
          }));
          await supabase.from("dividends").insert(rows);
        }
      }
      if (oldActions && oldActions.length > 0) {
        const { data: existing } = await supabase.from("actions").select("id").limit(1);
        if (!existing || existing.length === 0) {
          const rows = oldActions.map((r, i) => ({
            id: r.id || Date.now() + i, month_year: r.month_year, description: r.description, completed: r.completed || false,
          }));
          await supabase.from("actions").insert(rows);
        }
      }
      await this.setCache("__migrated_from_localstorage", true);
      console.log("[DB] Migration complete!");
    } catch (err) {
      console.warn("[DB] Migration error:", err);
    }
  }
};

// ═══════════════════════════════════════════════════════════════
//  QUANT ENGINE
// ═══════════════════════════════════════════════════════════════
const Quant = {
  netSurplus(row, expenses) {
    const va = parseFloat(row.va) || 0;
    const w2n = parseFloat(row.w2_net) || 0;
    const w2g = parseFloat(row.w2_gross) || 0;
    const w2 = w2n > 0 ? w2n : w2g;
    const mha = parseFloat(row.mha) || 0;
    const pell = parseFloat(row.pell) || 0;
    const i1099 = parseFloat(row.income_1099) || 0;
    const other = parseFloat(row.other_income) || 0;
    const exp = parseFloat(expenses) || 0;
    return (va + w2 + mha + pell + i1099 + other) - exp;
  },
  ltv(debt, nav) {
    if (nav <= 0) return debt > 0 ? 100 : 0;
    return (debt / nav) * 100;
  },
  projectFV(pv, monthlyRate, months, pmt) {
    const vals = [];
    for (let n = 0; n <= months; n++) {
      const fv = monthlyRate > 0
        ? pv * Math.pow(1 + monthlyRate, n) + pmt * ((Math.pow(1 + monthlyRate, n) - 1) / monthlyRate)
        : pv + pmt * n;
      vals.push({ month: n, nav: Math.round(fv) });
    }
    return vals;
  },
  computePortfolio(assets, transactions, prices, accountType) {
    const filtered = assets.filter(a => a.account_type === accountType);
    let rows = [];
    for (const a of filtered) {
      const t = a.ticker;
      const txns = transactions.filter(tx => tx.ticker === t);
      const netShares = txns.reduce((s, tx) => s + (tx.type === "Sell" ? -parseFloat(tx.shares || 0) : parseFloat(tx.shares || 0)), 0);
      const costBasis = txns.reduce((s, tx) => s + (tx.type === "Sell" ? -parseFloat(tx.total_amount || 0) : parseFloat(tx.total_amount || 0)), 0);
      
      // Xử lý đọc giá từ object mới
      const priceData = prices[t];
      const price = typeof priceData === "object" ? (priceData.price || 0) : (parseFloat(priceData) || 0);
      
      const value = netShares * price;
      const pl = value - costBasis;
      const plPct = costBasis > 0 ? (pl / costBasis) * 100 : 0;
      rows.push({ ticker: t, shares: netShares, price, value, cost: costBasis, pl, plPct, weight: 0, targetWeight: a.target_weight });
    }
    const total = rows.reduce((s, r) => s + r.value, 0);
    rows = rows.map(r => ({ ...r, weight: total > 0 ? (r.value / total) * 100 : 0 }));
    return { rows, total };
  },
  ytdW2Gross(incomes, year) {
    return incomes.filter(i => i.month_year.startsWith(year)).reduce((s, i) => s + (i.w2_gross || 0), 0);
  },
  ytdRothContributions(transactions, assets, year) {
    const rothTickers = new Set(assets.filter(a => a.account_type === "Roth").map(a => a.ticker));
    return transactions
      .filter(t => t.date.startsWith(year) && rothTickers.has(t.ticker))
      .reduce((s, t) => s + (t.type === "Sell" ? -t.total_amount : t.total_amount), 0);
  },
  totalInvested(transactions, assets, accountType) {
    if (!accountType) return transactions.reduce((s, t) => s + (t.type === "Sell" ? -t.total_amount : t.total_amount), 0);
    const tickers = new Set(assets.filter(a => a.account_type === accountType).map(a => a.ticker));
    return transactions.filter(t => tickers.has(t.ticker)).reduce((s, t) => s + (t.type === "Sell" ? -t.total_amount : t.total_amount), 0);
  },

  // ═══════════════════════════════════════════════════════════
  //  YIELD-ON-COST ENGINE
  // ═══════════════════════════════════════════════════════════
yieldOnCost(transactions, dividends, assets, prices) {
    const costInfo = {};
    const sortedTxns = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
    
    sortedTxns.forEach(tx => {
      const t = tx.ticker;
      const amt = parseFloat(tx.total_amount) || 0;
      const sh = parseFloat(tx.shares) || 0;
      if (!costInfo[t]) costInfo[t] = { shares: 0, totalCost: 0 };

      if (tx.type === "Sell") {
        const avgCostPerShare = costInfo[t].shares > 0 ? costInfo[t].totalCost / costInfo[t].shares : 0;
        costInfo[t].totalCost -= (sh * avgCostPerShare);
        costInfo[t].shares -= sh;
      } else {
        costInfo[t].totalCost += amt;
        costInfo[t].shares += sh;
      }
    });

    const assetMap = {};
    assets.forEach(a => { assetMap[a.ticker] = a; });

    const rows = [];
    let totalCost = 0;
    let totalForwardAnnualDivs = 0;
    let totalCurrentValue = 0;

    Object.keys(costInfo).forEach(ticker => {
      const cost = Math.max(0, costInfo[ticker].totalCost);
      const shares = costInfo[ticker].shares;
      if (cost <= 0 || shares <= 0.001) return;

      // Lấy Forward Dividend Rate từ Backend
      const priceData = prices[ticker];
      const currentPrice = typeof priceData === "object" ? (priceData.price || 0) : (parseFloat(priceData) || 0);
      const forwardDivRate = typeof priceData === "object" ? (priceData.divRate || 0) : 0;

      const currentValue = shares * currentPrice;
      const tickerDivs = (dividends || []).filter(d => d.ticker === ticker);
      const totalReceived = tickerDivs.reduce((s, d) => s + parseFloat(d.amount || 0), 0);

      // --- LOGIC CHUẨN XÁC VỚI FORWARD DATA ---
      const forwardAnnualIncome = shares * forwardDivRate; // Thu nhập 1 năm tới
      const yoc = cost > 0 ? (forwardAnnualIncome / cost) * 100 : 0; // YoC dựa trên giá vốn
      const currentYield = currentPrice > 0 ? (forwardDivRate / currentPrice) * 100 : 0;
      const avgCostPerShare = shares > 0 ? cost / shares : 0;

      rows.push({
        ticker, accountType: assetMap[ticker]?.account_type || "—", shares,
        avgCost: avgCostPerShare, currentPrice, costBasis: cost, currentValue, 
        forwardDivRate, forwardAnnualIncome, totalReceived, yoc, currentYield
      });

      totalCost += cost;
      totalForwardAnnualDivs += forwardAnnualIncome;
      totalCurrentValue += currentValue;
    });

    rows.sort((a, b) => b.yoc - a.yoc);
    const portfolioYoC = totalCost > 0 ? (totalForwardAnnualDivs / totalCost) * 100 : 0;
    const portfolioCurrentYield = totalCurrentValue > 0 ? (totalForwardAnnualDivs / totalCurrentValue) * 100 : 0;
    
    return { rows, totalCost, totalForwardAnnualDivs, totalCurrentValue, portfolioYoC, portfolioCurrentYield };
  }
};

// ═══════════════════════════════════════════════════════════════
//  THEME & CONSTANTS — TRUE BLACK OLED
// ═══════════════════════════════════════════════════════════════
const C = {
  bg: "#000000", card: "#080E1A", cardAlt: "#0D1525", border: "#141E30",
  borderLight: "#1C2B42", cyan: "#00D4FF", cyanDim: "#0891b2",
  purple: "#8B5CF6", purpleDim: "#6D28D9", amber: "#F59E0B",
  red: "#EF4444", green: "#22C55E", greenDim: "#16A34A",
  text: "#E2E8F0", textDim: "#64748B", textMid: "#94A3B8",
};
const DONUT_COLORS = ["#00D4FF", "#8B5CF6", "#F59E0B", "#22C55E", "#EC4899", "#F97316", "#06B6D4", "#A78BFA"];
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtK = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
const nowYM = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const nowDate = () => new Date().toISOString().split("T")[0];
const currentYear = () => String(new Date().getFullYear());

// ═══════════════════════════════════════════════════════════════
//  REUSABLE UI COMPONENTS
// ═══════════════════════════════════════════════════════════════

function MetricCard({ label, value, sub, color = C.cyan, large }) {
  // Cảm biến màn hình Mobile để tự động thu nhỏ font chữ và padding
  const isMobile = window.innerWidth < 500;
  const valFontSize = large ? (isMobile ? 20 : 26) : (isMobile ? 18 : 22);
  const cardPadding = large ? (isMobile ? "12px 14px" : "20px 24px") : "12px 14px";

  return (
    <div style={{ background: `linear-gradient(135deg, ${C.card}, ${C.cardAlt})`, border: `1px solid ${C.border}`, borderRadius: 14, padding: cardPadding, flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{label}</div>
      <div style={{ 
        fontSize: valFontSize, 
        fontWeight: 700, 
        color, 
        fontFamily: "'IBM Plex Mono', monospace", 
        marginTop: 4, 
        whiteSpace: "nowrap",       // Cấm rớt dòng đối với các con số
        letterSpacing: "-0.04em",   // Ép các chữ số lại gần nhau 1 xíu để tiết kiệm diện tích
        overflow: "hidden",
        textOverflow: "ellipsis"
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: C.textDim, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>}
    </div>
  );
}

function AlertBanner({ type, children }) {
  const styles = {
    red: { bg: "linear-gradient(135deg, #450A0A, #7F1D1D)", border: "#F87171", color: "#FECACA" },
    amber: { bg: "linear-gradient(135deg, #451A03, #78350F)", border: "#FBBF24", color: "#FEF3C7" },
    green: { bg: "linear-gradient(135deg, #052E16, #166534)", border: "#4ADE80", color: "#BBF7D0" },
  }[type] || {};
  return (
    <div style={{ background: styles.bg, border: `1px solid ${styles.border}`, borderRadius: 12, padding: "14px 20px", color: styles.color, fontSize: 13, fontWeight: 600, marginBottom: 12, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function ProgressBar({ pct, color = C.cyan, height = 10 }) {
  return (
    <div style={{ background: C.cardAlt, borderRadius: height, height, overflow: "hidden", width: "100%" }}>
      <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: `linear-gradient(90deg, ${color}88, ${color})`, borderRadius: height, transition: "width 0.8s ease" }} />
    </div>
  );
}

function SvgGauge({ value, max = 50, label, subLabel, thresholds }) {
  const safeVal = Math.max(0, Math.min(parseFloat(value) || 0, max));
  const pct = safeVal / max;
  const startAngle = 135;
  const totalSweep = 270;
  const cx = 100, cy = 100, r = 72;
  const zones = thresholds || [
    { from: 0, to: 0.3, color: C.green }, { from: 0.3, to: 0.5, color: "#84CC16" },
    { from: 0.5, to: 0.7, color: C.amber }, { from: 0.7, to: 1.0, color: C.red },
  ];
  const toRad = (deg) => deg * Math.PI / 180;
  const arcPoint = (angleDeg) => ({
    x: cx + r * Math.cos(toRad(angleDeg)),
    y: cy + r * Math.sin(toRad(angleDeg)),
  });
  const makeArc = (fromPct, toPct) => {
    const a1 = startAngle + fromPct * totalSweep;
    const a2 = startAngle + toPct * totalSweep;
    const p1 = arcPoint(a1);
    const p2 = arcPoint(a2);
    const sweep = a2 - a1;
    const largeArc = sweep > 180 ? 1 : 0;
    return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  };
  const needleAngle = startAngle + pct * totalSweep;
  const needleLen = r - 18;
  const np = { x: cx + needleLen * Math.cos(toRad(needleAngle)), y: cy + needleLen * Math.sin(toRad(needleAngle)) };
  const activeColor = zones.slice().reverse().find(z => pct >= z.from)?.color || C.textDim;
  return (
    <div style={{ textAlign: "center" }}>
      <svg viewBox="0 0 200 150" style={{ width: "100%", maxWidth: 220 }}>
        {zones.map((z, i) => (
          <path key={i} d={makeArc(z.from, Math.min(z.to, 1))} fill="none" stroke={z.color + "30"} strokeWidth="14" strokeLinecap="butt" />
        ))}
        {pct > 0.005 && (
          <path d={makeArc(0, pct)} fill="none" stroke={activeColor} strokeWidth="7" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 5px ${activeColor}80)` }} />
        )}
        <line x1={cx} y1={cy} x2={np.x.toFixed(2)} y2={np.y.toFixed(2)} stroke={activeColor} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="4.5" fill={activeColor} />
        <circle cx={cx} cy={cy} r="2" fill={C.bg} />
        <text x={cx} y={cy + 28} textAnchor="middle" fill={C.text} fontSize="22" fontWeight="700" fontFamily="'IBM Plex Mono', monospace">{safeVal.toFixed(1)}</text>
        <text x={cx} y={cy + 42} textAnchor="middle" fill={C.textDim} fontSize="9" fontFamily="'IBM Plex Mono', monospace">/ {max}</text>
      </svg>
      <div style={{ fontSize: 13, fontWeight: 700, color: activeColor, marginTop: -8 }}>{label}</div>
      {subLabel && <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{subLabel}</div>}
    </div>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 2, background: C.card, borderRadius: 10, padding: 3, marginBottom: 16, overflow: "auto", flexShrink: 0 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          flex: 1, padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600,
          fontFamily: "'DM Sans', sans-serif", whiteSpace: "nowrap", minWidth: 0,
          background: active === t.id ? C.cyan + "18" : "transparent", color: active === t.id ? C.cyan : C.textDim,
          borderBottom: active === t.id ? `2px solid ${C.cyan}` : "2px solid transparent",
          transition: "all 0.2s",
        }}>{t.icon} {t.label}</button>
      ))}
    </div>
  );
}

function InputField({ label, value, onChange, type = "text", placeholder, step, min, disabled }) {
  return (
    <div style={{ marginBottom: 12 }}>
      {label && <label style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, display: "block", marginBottom: 4 }}>{label}</label>}
      <input type={type} value={value} onChange={e => onChange(type === "number" ? parseFloat(e.target.value) || 0 : e.target.value)}
        placeholder={placeholder} step={step} min={min} disabled={disabled}
        style={{ width: "100%", padding: "10px 14px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, fontFamily: "'IBM Plex Mono', monospace", outline: "none", boxSizing: "border-box" }}
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 12 }}>
      {label && <label style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, display: "block", marginBottom: 4 }}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ width: "100%", padding: "10px 14px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box" }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function Btn({ children, onClick, variant = "primary", disabled, full }) {
  const s = variant === "primary"
    ? { background: `linear-gradient(135deg, ${C.cyanDim}, ${C.cyan})`, color: C.bg }
    : variant === "danger"
    ? { background: `linear-gradient(135deg, #991B1B, ${C.red})`, color: "#fff" }
    : { background: C.cardAlt, color: C.textMid, border: `1px solid ${C.border}` };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...s, padding: "10px 20px", borderRadius: 10, border: "none", fontWeight: 700, fontSize: 13, cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1, width: full ? "100%" : "auto", fontFamily: "'DM Sans', sans-serif", transition: "all 0.2s",
    }}>{children}</button>
  );
}

function Section({ title, children, noPad }) {
  return (
    <div style={{ marginBottom: 24 }}>
      {title && <h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 12, fontFamily: "'DM Sans', sans-serif" }}>{title}</h3>}
      {children}
    </div>
  );
}

function ViewToggle({ value, onChange, coreLabel = "🎯 Core ETFs", globalLabel = "🌐 Global (All)" }) {
  const base = { padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", transition: "all 0.2s" };
  return (
    <div style={{ display: "inline-flex", gap: 2, background: C.card, borderRadius: 10, padding: 3, marginBottom: 14 }}>
      <button onClick={() => onChange("core")} style={{ ...base, background: value === "core" ? `${C.cyan}18` : "transparent", color: value === "core" ? C.cyan : C.textDim, border: value === "core" ? `1px solid ${C.cyan}40` : "1px solid transparent" }}>{coreLabel}</button>
      <button onClick={() => onChange("global")} style={{ ...base, background: value === "global" ? `${C.purple}18` : "transparent", color: value === "global" ? C.purple : C.textDim, border: value === "global" ? `1px solid ${C.purple}40` : "1px solid transparent" }}>{globalLabel}</button>
    </div>
  );
}

function PortfolioDonut({ data, totalValue, accentColor = C.cyan, colorOffset = 0 }) {
  const hasData = data.length > 0 && totalValue > 0;
  
  const renderLabels = (props) => {
    const { cx, cy, midAngle, innerRadius, outerRadius, percent, index, payload } = props;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const ix = cx + radius * Math.cos(-midAngle * Math.PI / 180);
    const iy = cy + radius * Math.sin(-midAngle * Math.PI / 180);
    const isMobile = window.innerWidth < 500;

    if (percent < 0.02) return (
       <text x={ix} y={iy} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={isMobile ? 8 : 10} fontWeight="bold">
        {`${(percent * 100).toFixed(0)}%`}
      </text>
    );

    const RADIAN = Math.PI / 180;
    const sin = Math.sin(-RADIAN * midAngle);
    const cos = Math.cos(-RADIAN * midAngle);
    const lineLen = isMobile ? 6 : 12;
    const horizLen = isMobile ? 8 : 15;

    const sx = cx + (outerRadius + 2) * cos;
    const sy = cy + (outerRadius + 2) * sin;
    const mx = cx + (outerRadius + lineLen) * cos;
    const my = cy + (outerRadius + lineLen) * sin;
    const ex = mx + (cos >= 0 ? 1 : -1) * horizLen;
    const ey = my;
    const color = DONUT_COLORS[(index + colorOffset) % DONUT_COLORS.length];

    return (
      <g>
        <text x={ix} y={iy} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={isMobile ? 9 : 11} fontWeight="bold">
          {`${(percent * 100).toFixed(0)}%`}
        </text>
        <path d={`M${sx},${sy}L${mx},${my}L${ex},${ey}`} stroke={color} fill="none" strokeWidth={1.5} />
        <circle cx={ex} cy={ey} r={isMobile ? 1.5 : 2.5} fill={color} />
        <text x={ex + (cos >= 0 ? 1 : -1) * (isMobile ? 4 : 8)} y={ey} dy={3} textAnchor={cos >= 0 ? 'start' : 'end'} fill={C.text} fontSize={isMobile ? 9 : 11} fontWeight="700" fontFamily="'IBM Plex Mono', monospace">
          {payload.ticker}
        </text>
      </g>
    );
  };

  return (
    <div style={{ position: "relative", width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <ResponsiveContainer width="100%" height={320}>
        <PieChart>
          {hasData ? (
            <Pie data={data} dataKey="value" nameKey="ticker" cx="50%" cy="50%" innerRadius="55%" outerRadius="80%" paddingAngle={3} strokeWidth={0} label={renderLabels} labelLine={false}>
              {data.map((_, i) => <Cell key={i} fill={DONUT_COLORS[(i + colorOffset) % DONUT_COLORS.length]} />)}
            </Pie>
          ) : (
            <Pie data={[{ value: 1 }]} cx="50%" cy="50%" innerRadius="55%" outerRadius="80%" strokeWidth={0}><Cell fill={C.border} /></Pie>
          )}
          <Tooltip formatter={(val, name, props) => [`$${fmt(val, 0)} (${props.payload.weight.toFixed(1)}%)`, name]} contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.text }} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ position: "absolute", textAlign: "center", pointerEvents: "none", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>TOTAL NAV</div>
        <div style={{ fontSize: window.innerWidth < 500 ? 18 : 22, fontWeight: 700, color: accentColor, fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.2 }}>
          {hasData ? `$${fmt(totalValue, 0)}` : "$0"}
        </div>
      </div>
    </div>
  );
}

function PortfolioTable({ rows, accentColor = C.cyan, showTarget = false }) {
  const headers = showTarget
    ? ["Ticker", "Shares", "Price", "Value", "P/L", "Wt%", "Tgt%", "Action"]
    : ["Ticker", "Shares", "Price", "Value", "P/L", "Wt%"];
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }}>
        <thead>
          <tr>{headers.map(h => (
            <th key={h} style={{ textAlign: h === "Ticker" ? "left" : "right", padding: "6px 4px", color: C.textDim, borderBottom: `1px solid ${C.border}`, fontSize: 9, textTransform: "uppercase" }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} style={{ padding: 20, textAlign: "center", color: C.textDim }}>No positions.</td></tr>
          ) : rows.map(r => (
            <tr key={r.ticker} style={{ borderBottom: `1px solid ${C.border}10` }}>
              <td style={{ padding: "8px 4px", fontWeight: 700, color: accentColor }}>{r.ticker}</td>
              <td style={{ textAlign: "right", padding: "8px 4px", color: C.text }}>{r.shares.toFixed(3)}</td>
              <td style={{ textAlign: "right", padding: "8px 4px", color: C.textMid }}>${fmt(r.price)}</td>
              <td style={{ textAlign: "right", padding: "8px 4px", color: C.text }}>${fmt(r.value)}</td>
              <td style={{ textAlign: "right", padding: "8px 4px", color: r.pl >= 0 ? C.green : C.red }}>{r.pl >= 0 ? "+" : ""}${fmt(r.pl, 0)}</td>
              <td style={{ textAlign: "right", padding: "8px 4px", color: C.textMid }}>{r.weight.toFixed(1)}%</td>
              {showTarget && <td style={{ textAlign: "right", padding: "8px 4px", color: C.amber }}>{r.targetWeight}%</td>}
              {showTarget && (
                <td style={{ textAlign: "right", padding: "8px 4px", fontWeight: 700, color: (r.rebalance || 0) >= 0 ? C.green : C.red }}>
                  {(r.rebalance || 0) >= 0 ? `+${fmt(r.rebalance, 0)}` : `${fmt(r.rebalance, 0)}`}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Grid({ children, cols = 3, gap = 12 }) {
  // Mobile thông minh: Tự động chia lại thành các cột rộng tối thiểu 140px. 
  // Trên iPhone, nó sẽ rớt xuống thành 2 cột rất rộng rãi và đẹp mắt.
  const minW = cols >= 4 ? "140px" : "150px";
  return <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minW}), 1fr))`, gap }}>{children}</div>;
}

// ═══════════════════════════════════════════════════════════════
//  YIELD-ON-COST TABLE COMPONENT
// ═══════════════════════════════════════════════════════════════
function YoCTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: C.textDim, fontSize: 12, textAlign: "center", padding: 24 }}>Calculating Forward Yield... Add assets to see data.</div>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }}>
        <thead>
          <tr>
            {["Ticker", "Acct", "Avg Cost", "Price", "Cost Basis", "Fwd Income", "Fwd Yield", "YoC %"].map(h => (
              <th key={h} style={{ textAlign: h === "Ticker" || h === "Acct" ? "left" : "right", padding: "8px 6px", color: C.textDim, borderBottom: `1px solid ${C.border}`, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const yocColor = r.yoc >= 8 ? "#00FF88" : r.yoc >= 5 ? C.green : r.yoc >= 3 ? C.cyan : r.yoc >= 1 ? C.amber : C.textMid;
            const yocLift = r.yoc - r.currentYield;
            return (
              <tr key={r.ticker} style={{ borderBottom: `1px solid ${C.border}15` }}>
                <td style={{ padding: "8px 6px", fontWeight: 700, color: r.accountType === "Roth" ? C.cyan : C.purple }}>{r.ticker}</td>
                <td style={{ padding: "8px 6px", fontSize: 9, color: C.textDim }}>{r.accountType}</td>
                <td style={{ textAlign: "right", padding: "8px 6px", color: C.textMid }}>${fmt(r.avgCost)}</td>
                <td style={{ textAlign: "right", padding: "8px 6px", color: C.text }}>${fmt(r.currentPrice)}</td>
                <td style={{ textAlign: "right", padding: "8px 6px", color: C.text }}>${fmt(r.costBasis, 0)}</td>
                <td style={{ textAlign: "right", padding: "8px 6px", color: C.green, fontWeight: 600 }}>${fmt(r.forwardAnnualIncome, 0)}</td>
                <td style={{ textAlign: "right", padding: "8px 6px", color: C.textMid }}>{r.currentYield.toFixed(2)}%</td>
                <td style={{ textAlign: "right", padding: "8px 6px", fontWeight: 800, color: yocColor }}>
                  {r.yoc.toFixed(2)}%
                  {yocLift > 0.1 && <span style={{ fontSize: 8, color: C.green, marginLeft: 4 }}>↑{yocLift.toFixed(1)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label, prefix = "$" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.card + "F0", border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 12, backdropFilter: "blur(8px)" }}>
      <div style={{ color: C.textDim, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600 }}>
          {p.name}: {prefix}{fmt(p.value, 0)}
        </div>
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
//  COLLAPSIBLE MONTH GROUP COMPONENT
// ═══════════════════════════════════════════════════════════════
function CollapsibleMonthGroup({ monthYear, txns, accentColor, isExpanded, onToggle, onDelete }) {
  // Monthly metrics: net total and ticker breakdown
  const { netTotal, tickerBreakdown, buyTotal, sellTotal } = useMemo(() => {
    let buy = 0, sell = 0;
    const byTicker = {};
    txns.forEach(t => {
      const amt = parseFloat(t.total_amount) || 0;
      if (t.type === "Sell") {
        sell += amt;
      } else {
        buy += amt;
      }
      if (!byTicker[t.ticker]) byTicker[t.ticker] = 0;
      byTicker[t.ticker] += (t.type === "Sell" ? -amt : amt);
    });
    return { netTotal: buy - sell, tickerBreakdown: byTicker, buyTotal: buy, sellTotal: sell };
  }, [txns]);

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Header — clickable to expand/collapse */}
      <div
        onClick={onToggle}
        style={{
          background: `${accentColor}10`, padding: "8px 12px", borderRadius: isExpanded ? "8px 8px 0 0" : 8,
          fontSize: 11, fontWeight: 800, color: accentColor, borderLeft: `3px solid ${accentColor}`,
          display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer",
          transition: "all 0.2s", userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, transition: "transform 0.2s", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}>▶</span>
          <span>📅 {monthYear}</span>
          <span style={{ fontSize: 9, color: C.textDim, fontWeight: 600 }}>{txns.length} TXN{txns.length !== 1 ? "S" : ""}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 10, color: C.green, fontFamily: "'IBM Plex Mono', monospace" }}>+${fmt(buyTotal, 0)}</span>
          {sellTotal > 0 && <span style={{ fontSize: 10, color: C.red, fontFamily: "'IBM Plex Mono', monospace" }}>-${fmt(sellTotal, 0)}</span>}
          <span style={{
            fontSize: 11, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace",
            color: netTotal >= 0 ? C.green : C.red,
            background: netTotal >= 0 ? `${C.green}15` : `${C.red}15`,
            padding: "2px 8px", borderRadius: 6,
          }}>
            NET {netTotal >= 0 ? "+" : ""}${fmt(netTotal, 0)}
          </span>
        </div>
      </div>

      {/* Expandable body */}
      {isExpanded && (
        <div style={{ border: `1px solid ${C.border}`, borderTop: "none", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
          {/* Ticker breakdown sub-summary */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "6px 10px", background: `${C.cardAlt}`, borderBottom: `1px solid ${C.border}40` }}>
            {Object.entries(tickerBreakdown).map(([ticker, amt]) => (
              <span key={ticker} style={{
                fontSize: 9, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace",
                padding: "2px 8px", borderRadius: 4,
                background: amt >= 0 ? `${C.green}10` : `${C.red}10`,
                color: amt >= 0 ? C.green : C.red,
                border: `1px solid ${amt >= 0 ? C.green : C.red}20`,
              }}>
                {ticker}: {amt >= 0 ? "+" : ""}${fmt(amt, 0)}
              </span>
            ))}
          </div>

          {/* Transaction rows */}
          <div style={{ padding: 4 }}>
            {[...txns].sort((a, b) => b.date.localeCompare(a.date)).map(t => (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", fontSize: 11, borderBottom: `1px solid ${C.border}40` }}>
                <span style={{ color: C.textDim, minWidth: 20 }}>{t.date.split('-')[2]}</span>
                <span style={{ fontWeight: 700, color: t.type === "Sell" ? C.red : C.green, minWidth: 28 }}>{t.type}</span>
                <span style={{ fontWeight: 700, color: accentColor, minWidth: 36 }}>{t.ticker}</span>
                <span style={{ color: C.textMid, fontFamily: "'IBM Plex Mono', monospace", flex: 1, textAlign: "right" }}>{parseFloat(t.shares).toFixed(2)} @ ${fmt(t.price)}</span>
                <span style={{ fontWeight: 700, color: C.text, fontFamily: "'IBM Plex Mono', monospace", minWidth: 65, textAlign: "right" }}>${fmt(t.total_amount)}</span>
                <button onClick={(e) => { e.stopPropagation(); onDelete(t.id); }} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", opacity: 0.6, fontSize: 14 }}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  SCROLLABLE HISTORY SECTION
// ═══════════════════════════════════════════════════════════════
function ScrollableHistory({ children, maxHeight = 520 }) {
  return (
    <div style={{
      maxHeight, overflowY: "auto", overflowX: "hidden",
      paddingRight: 4,
      scrollbarWidth: "thin",
      scrollbarColor: `${C.border} transparent`,
    }}>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  MARKET HEATMAP DATA (static demonstration)
// ═══════════════════════════════════════════════════════════════
const HEATMAP_DATA = {
  mag7: [
    { name: "AAPL", size: 3400, change: 2.1 }, { name: "MSFT", size: 3100, change: -0.8 },
    { name: "NVDA", size: 2900, change: 4.5 }, { name: "AMZN", size: 2100, change: 1.2 },
    { name: "GOOG", size: 2000, change: -1.5 }, { name: "META", size: 1600, change: 3.2 },
    { name: "TSLA", size: 900, change: -2.8 },
  ],
  sectors: [
    { name: "Tech", size: 4200, change: 1.8 }, { name: "Health", size: 1800, change: -0.5 },
    { name: "Finance", size: 1600, change: 0.9 }, { name: "Energy", size: 1200, change: -1.2 },
    { name: "Consumer", size: 1100, change: 2.1 }, { name: "Industrial", size: 900, change: 0.3 },
    { name: "Utilities", size: 600, change: -0.7 }, { name: "Real Estate", size: 500, change: -1.8 },
  ],
};
const getHeatColor = (change) => {
  if (change > 3) return "#16A34A";
  if (change > 1) return "#22C55E";
  if (change > 0) return "#4ADE80";
  if (change > -1) return "#FCA5A5";
  if (change > -3) return "#EF4444";
  return "#DC2626";
};

const TreemapContent = ({ x, y, width, height, name, change, price }) => {
  if (width < 40 || height < 30) return null;
  const hasPrice = price && price > 0;
  const showPrice = hasPrice && width > 55 && height > 45;
  const fs1 = Math.min(width / 5, 14);
  const fs2 = Math.min(width / 6, 11);
  const fs3 = Math.min(width / 7, 9);
  const yCenter = showPrice ? y + height / 2 - 10 : y + height / 2 - 6;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={getHeatColor(change)} stroke={C.bg} strokeWidth={2} rx={4} />
      <text x={x + width / 2} y={yCenter} textAnchor="middle" fill="#fff" fontSize={fs1} fontWeight="700" fontFamily="'IBM Plex Mono', monospace">{name}</text>
      <text x={x + width / 2} y={yCenter + fs1 + 2} textAnchor="middle" fill="#ffffffCC" fontSize={fs2} fontFamily="'IBM Plex Mono', monospace">{change > 0 ? "+" : ""}{change}%</text>
      {showPrice && <text x={x + width / 2} y={yCenter + fs1 + fs2 + 4} textAnchor="middle" fill="#ffffff90" fontSize={fs3} fontFamily="'IBM Plex Mono', monospace">${price.toFixed(0)}</text>}
    </g>
  );
};

// ═══════════════════════════════════════════════════════════════
//  VIX LABEL HELPER
// ═══════════════════════════════════════════════════════════════
function vixLabel(v) {
  if (v > 30) return ["Extreme Fear", C.red];
  if (v > 25) return ["Fear", "#FB923C"];
  if (v > 20) return ["Bearish", C.amber];
  if (v > 15) return ["Neutral", C.textMid];
  return ["Optimistic", C.green];
}

// ═══════════════════════════════════════════════════════════════
//  CLOUD STATUS BADGE COMPONENT
// ═══════════════════════════════════════════════════════════════
function CloudBadge({ status }) {
  const colorMap = { connected: "#3B82F6", syncing: C.amber, disconnected: C.red };
  const labelMap = { connected: "CLOUD", syncing: "SYNC", disconnected: "OFFLINE" };
  const clr = colorMap[status] || C.textDim;
  const lbl = labelMap[status] || "—";
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 20,
      background: `${clr}15`, border: `1px solid ${clr}30`,
    }}>
      <span style={{ fontSize: 11 }}>☁️</span>
      <span style={{ fontSize: 9, fontWeight: 700, color: clr, letterSpacing: "0.05em" }}>{lbl}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  MAIN APP COMPONENT
// ═══════════════════════════════════════════════════════════════
export default function WhaleOS() {
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState("dashboard");
  const [settings, setSettings] = useState({ target_nav: 200000, monthly_expenses: 1500, expected_annual_return: 0.10, fed_next_meeting: "2026-06-18", fed_prob_hold: 62, fed_prob_cut: 33, fed_prob_hike: 5 });
  const [incomes, setIncomes] = useState([]);
  const [assets, setAssets] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [sbloc, setSbloc] = useState([]);
  const [dividends, setDividends] = useState([]);
  const [actions, setActions] = useState([]);
  const [prices, setPrices] = useState({});
  const [showSettings, setShowSettings] = useState(false);
  const [showTickers, setShowTickers] = useState(false);
  const [msg, setMsg] = useState(null);
  const [vixData, setVixData] = useState({ current: 0, day: 0, week: 0, month: 0, midTerm: 0 });
  const [fedRate, setFedRate] = useState({ current: 0, prev: 0, nextMeeting: "—", probHold: 0, probCut: 0, probHike: 0 });
  const [apiOnline, setApiOnline] = useState(false);
  const [lastFetch, setLastFetch] = useState(null);
  const [heatmapData, setHeatmapData] = useState(HEATMAP_DATA);
  const [cloudStatus, setCloudStatus] = useState("disconnected");
  const fetchIntervalRef = useRef(null);

  // ── Subscribe to cloud status changes ──────────────────────
  useEffect(() => {
    const unsub = DB.onStatusChange(setCloudStatus);
    return unsub;
  }, []);

  // ── Fetch live market data from backend ────────────────────
  const fetchMarketData = useCallback(async (tickerList) => {
    const uniqueTickers = [...new Set((tickerList || []).map(t => t.trim().toUpperCase()).filter(Boolean))];
    console.log("[WhaleOS] fetchMarketData called with tickers:", uniqueTickers);

    let online = false;
    try {
      const h = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(4000) });
      if (h.ok) online = true;
    } catch { /* offline */ }
    setApiOnline(online);
    console.log("[WhaleOS] Backend status:", online ? "ONLINE" : "OFFLINE");

    if (!online) {
      const cv = await DB.getCache("vix");
      const cf = await DB.getCache("fed");
      const ch = await DB.getCache("heatmap");
      if (cv) setVixData(cv);
      if (cf) setFedRate(prev => ({ ...prev, ...cf }));
      if (ch) setHeatmapData(ch);
      console.log("[WhaleOS] Loaded from cache (offline mode)");
      return;
    }
    setLastFetch(new Date().toLocaleTimeString());

    try {
      const r = await fetch(`${API_BASE}/vix`);
      const d = await r.json();
      if (d && !d.error && d.current) {
        const vd = { current: d.current, day: d.day ?? d.current, week: d.week ?? d.last_week ?? d.current, month: d.month ?? d.current, midTerm: d.midTerm ?? d.mid_term ?? d.current };
        setVixData(vd);
        await DB.setCache("vix", vd);
      }
    } catch (err) { console.warn("[WhaleOS] VIX fetch failed:", err); }

    try {
      const r = await fetch(`${API_BASE}/fed-rate`);
      const d = await r.json();
      if (d && d.current !== undefined) {
        const fd = { current: d.current, prev: d.prev ?? d.current, nextMeeting: d.nextMeeting ?? "—", probHold: d.probHold ?? 0, probCut: d.probCut ?? 0, probHike: d.probHike ?? 0, source: d.source ?? "API" };
        setFedRate(fd);
        await DB.setCache("fed", fd);
      }
    } catch (err) { console.warn("[WhaleOS] Fed rate fetch failed:", err); }

    if (uniqueTickers.length > 0) {
      const url = `${API_BASE}/prices?tickers=${uniqueTickers.join(",")}`;
      try {
        const r = await fetch(url);
        const d = await r.json();
        const validPrices = {};
        if (d && typeof d === "object") {
          for (const [ticker, priceData] of Object.entries(d)) {
            // Nhận diện cấu trúc Object mới từ Backend
            if (typeof priceData === "object" && priceData !== null) {
              if (priceData.price > 0) validPrices[ticker] = priceData;
            } else {
              // Fallback an toàn nếu giá trị vẫn là số cũ
              const p = parseFloat(priceData);
              if (p > 0) validPrices[ticker] = { price: p, divRate: 0 };
          }
        }
      }
        if (Object.keys(validPrices).length > 0) {
          setPrices(prev => {
            const merged = { ...prev, ...validPrices };
            DB.setPrices(merged);
            return merged;
          });
        }
      } catch (err) { console.warn("[WhaleOS] Price fetch failed:", err); }
    }

    try {
      const [mag7Res, sectorsRes] = await Promise.all([
        fetch(`${API_BASE}/heatmap/mag7`).then(r => r.json()).catch(() => null),
        fetch(`${API_BASE}/heatmap/sectors`).then(r => r.json()).catch(() => null),
      ]);
      const hd = { ...HEATMAP_DATA };
      if (mag7Res && Array.isArray(mag7Res) && mag7Res.length > 0) hd.mag7 = mag7Res;
      if (sectorsRes && Array.isArray(sectorsRes) && sectorsRes.length > 0) hd.sectors = sectorsRes;
      setHeatmapData(hd);
      await DB.setCache("heatmap", hd);
    } catch { /* keep static */ }
  }, []);

  // ── Load all data from Supabase ────────────────────────────
  const loadAll = useCallback(async () => {
    await DB.init();
    await DB.migrateFromLocalStorage();
    const [s, i, a, t, sb, d, ac] = await Promise.all([
      DB.get("settings"), DB.get("incomes"), DB.get("assets"),
      DB.get("transactions"), DB.get("sbloc"), DB.get("dividends"), DB.get("actions"),
    ]);
    const p = await DB.getPrices();
    if (s) {
      setSettings({
        target_nav: s.target_nav ?? 200000, monthly_expenses: s.monthly_expenses ?? 1500,
        expected_annual_return: s.expected_annual_return ?? 0.10, fed_next_meeting: s.fed_next_meeting ?? "2026-06-18",
        fed_prob_hold: s.fed_prob_hold ?? 62, fed_prob_cut: s.fed_prob_cut ?? 33, fed_prob_hike: s.fed_prob_hike ?? 5,
      });
    }
    if (i) setIncomes(i);
    if (a) setAssets(a);
    if (t) setTransactions(t);
    if (sb) setSbloc(sb);
    if (d) setDividends(d);
    if (ac) setActions(ac);
    if (p) setPrices(p);
    setReady(true);
    const allTickers = (a || []).map(x => x.ticker);
    await fetchMarketData(allTickers);
  }, [fetchMarketData]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    const allTickers = assets.map(a => a.ticker);
    fetchIntervalRef.current = setInterval(() => { fetchMarketData(allTickers); }, 15 * 60 * 1000);
    return () => clearInterval(fetchIntervalRef.current);
  }, [assets, fetchMarketData]);

  const prevAssetsRef = useRef(null);
  useEffect(() => {
    if (!ready) return;
    const currentKey = [...assets].map(a => a.ticker).sort().join(",");
    if (prevAssetsRef.current !== null && prevAssetsRef.current !== currentKey) {
      fetchMarketData(assets.map(a => a.ticker));
    }
    prevAssetsRef.current = currentKey;
  }, [assets, ready, fetchMarketData]);

  // ── Save helpers — now write to Supabase ───────────────────
  const save = useCallback(async (key, data) => {
    const tableMap = {
      settings: "settings", income: "incomes", assets: "assets", transactions: "transactions",
      sbloc: "sbloc", dividends: "dividends", actions: "actions", prices: "__prices__",
    };
    const table = tableMap[key];
    if (table === "__prices__") {
      await DB.setPrices(data);
    } else if (table) {
      await DB.set(table, data);
    }
  }, []);

  const flash = (text, type = "green") => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 3000);
  };

  const deleteTransaction = async (txnId) => {
    const updated = transactions.filter(t => t.id !== txnId);
    setTransactions(updated);
    await save("transactions", updated);
    flash("Transaction deleted", "amber");
  };

  // ── [UPGRADE 3] Delete Dividend ────────────────────────────
  const deleteDividend = async (divId) => {
    const updated = dividends.filter(d => d.id !== divId);
    setDividends(updated);
    await save("dividends", updated);
    flash("Dividend deleted", "amber");
  };

  // ── Derived calculations ───────────────────────────────────
  const year = currentYear();
  const roth = useMemo(() => Quant.computePortfolio(assets, transactions, prices, "Roth"), [assets, transactions, prices]);
  const taxable = useMemo(() => Quant.computePortfolio(assets, transactions, prices, "Taxable"), [assets, transactions, prices]);
  const totalNAV = roth.total + taxable.total;
  const totalInvested = useMemo(() => Quant.totalInvested(transactions, assets), [transactions, assets]);
  const totalPL = totalNAV - totalInvested;
  const totalPLPct = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;
  const pctToTarget = settings.target_nav > 0 ? Math.min((totalNAV / settings.target_nav) * 100, 100) : 0;
  const latestDebt = sbloc.length > 0 ? sbloc[sbloc.length - 1].amount : 0;
  const ltv = Quant.ltv(latestDebt, taxable.total);
  const ytdW2 = useMemo(() => Quant.ytdW2Gross(incomes, year), [incomes, year]);
  const ytdRoth = useMemo(() => Quant.ytdRothContributions(transactions, assets, year), [transactions, assets, year]);
  const rothSpace = Math.max(ytdW2 - ytdRoth, 0);
  const rothBreached = ytdRoth > ytdW2 && ytdW2 > 0;
  const rothPct = ytdW2 > 0 ? (ytdRoth / ytdW2) * 100 : (ytdRoth > 0 ? 100 : 0);
  const avgSurplus = useMemo(() => {
    if (!incomes.length) return 0;
    const surps = incomes.map(i => Quant.netSurplus(i, settings.monthly_expenses));
    return surps.reduce((a, b) => a + b, 0) / surps.length;
  }, [incomes, settings.monthly_expenses]);
  const monthlyRate = settings.expected_annual_return / 12;
  const projectionData = useMemo(() => Quant.projectFV(totalNAV, monthlyRate, 60, Math.max(avgSurplus, 0)), [totalNAV, monthlyRate, avgSurplus]);
  const allHoldings = useMemo(() => {
    const combined = [...roth.rows, ...taxable.rows];
    const map = {};
    combined.forEach(r => { if (!map[r.ticker]) map[r.ticker] = { ...r }; else { map[r.ticker].value += r.value; map[r.ticker].cost += r.cost; map[r.ticker].shares += r.shares; } });
    const arr = Object.values(map).filter(r => r.value > 0);
    const tot = arr.reduce((s, r) => s + r.value, 0);
    return arr.map(r => ({ ...r, weight: tot > 0 ? (r.value / tot) * 100 : 0, pl: r.value - r.cost }));
  }, [roth.rows, taxable.rows]);

  // ── [UPGRADE 4] Net Equity ─────────────────────────────────
  const netEquity = totalNAV - latestDebt;

  // ── [YIELD-ON-COST] Compute YoC across all dividend-paying holdings ──
  const yocData = useMemo(
    () => Quant.yieldOnCost(transactions, dividends, assets, prices),
    [transactions, dividends, assets, prices]
  );

  // ── VIX market summary ─────────────────────────────────────
  const [vlbl, vclr] = vixLabel(vixData.current);
  const marketSummary = useMemo(() => {
    const v = vixData.current;
    if (v > 30) return "Thị trường đang trong trạng thái SỢ HÃI CỰC ĐỘ. Tạm dừng mọi khoản vay SBLOC. Cân nhắc mua DCA nếu có surplus.";
    if (v > 25) return "Thị trường biến động cao. Cẩn trọng với đòn bẩy. Đây có thể là cơ hội mua nếu thesis dài hạn không thay đổi.";
    if (v > 20) return "Tâm lý thị trường hơi bi quan. Vẫn an toàn để DCA đều đặn. Theo dõi SBLOC LTV.";
    if (v > 15) return "Thị trường trung tính. Tiếp tục DCA theo kế hoạch. Điều kiện tốt để tăng vị thế.";
    return "Thị trường lạc quan. Tiếp tục DCA. Cẩn trọng không FOMO — gắn chặt kế hoạch.";
  }, [vixData.current]);

  // ── [UPGRADE 5] Sync Rebalance to Actions helper ──────────
  const syncRebalanceToActions = useCallback(async (displayRows, accountLabel) => {
    const currentMonth = nowYM();
    const newItems = displayRows
      .filter(r => r.rebalance && Math.abs(r.rebalance) >= 1)
      .map(r => ({
        id: Date.now() + Math.random() * 10000,
        month_year: currentMonth,
        description: r.rebalance >= 0
          ? `Buy $${Math.round(Math.abs(r.rebalance))} ${r.ticker} (${accountLabel})`
          : `Sell $${Math.round(Math.abs(r.rebalance))} ${r.ticker} (${accountLabel})`,
        completed: false,
      }));
    if (newItems.length === 0) {
      flash("No rebalance actions needed — portfolio is balanced!", "green");
      return;
    }
    const updated = [...actions, ...newItems];
    setActions(updated);
    await save("actions", updated);
    flash(`✅ ${newItems.length} rebalance actions synced to ${currentMonth}`, "green");
  }, [actions, save]);

  if (!ready) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: C.bg, color: C.cyan, fontFamily: "'DM Sans', sans-serif", fontSize: 18 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🐋</div>
        <div>Loading Whale OS...</div>
        <div style={{ fontSize: 12, color: C.textDim, marginTop: 8 }}>Connecting to Supabase...</div>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════
  //  PAGE: DASHBOARD
  // ═══════════════════════════════════════════════════════════
  const DashboardPage = () => (
    <>
      {/* VIX Section */}
      <Section title="🎭 Market Sentiment">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ flex: "1 1 180px", minWidth: 160 }}>
            <SvgGauge value={vixData.current} max={50} label={vlbl} subLabel="VIX Short-term" thresholds={[
              { from: 0, to: 0.3, color: C.green }, { from: 0.3, to: 0.4, color: "#84CC16" },
              { from: 0.4, to: 0.5, color: C.amber }, { from: 0.5, to: 1, color: C.red },
            ]} />
          </div>
          <div style={{ flex: "1 1 180px", minWidth: 160 }}>
            <SvgGauge value={vixData.midTerm} max={50} label={vixLabel(vixData.midTerm)[0]} subLabel="VIX Mid-term" thresholds={[
              { from: 0, to: 0.3, color: C.green }, { from: 0.3, to: 0.4, color: "#84CC16" },
              { from: 0.4, to: 0.5, color: C.amber }, { from: 0.5, to: 1, color: C.red },
            ]} />
          </div>
          <div style={{ flex: "1 1 200px", minWidth: 180, display: "flex", flexDirection: "column", gap: 6 }}>
            {[["Hiện tại", vixData.current], ["Hôm qua", vixData.day], ["Tuần trước", vixData.week], ["Tháng trước", vixData.month]].map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px" }}>
                <span style={{ fontSize: 11, color: C.textDim }}>{l}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: vixLabel(v)[1], fontFamily: "'IBM Plex Mono', monospace" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
        {vixData.current > 30 && <AlertBanner type="red">🚨 VIX @ {vixData.current} — EXTREME FEAR. PAUSE ALL SBLOC.</AlertBanner>}
        {vixData.current > 22 && vixData.current <= 30 && <AlertBanner type="amber">⚠️ VIX @ {vixData.current} — Elevated volatility. Review SBLOC.</AlertBanner>}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>
          <strong style={{ color: C.cyan }}>📊 Bull/Bear Summary:</strong> {marketSummary}
        </div>
      </Section>

      {/* NAV Metrics — [UPGRADE 4] Net Equity added */}
      <Section title="📈 Portfolio Overview">
        <Grid cols={4} gap={10}>
          <MetricCard label="Net Equity" value={`$${fmt(netEquity)}`} sub={`NAV − Debt`} color={netEquity >= 0 ? "#00FF88" : C.red} large />
          <MetricCard label="Total NAV" value={`$${fmt(totalNAV)}`} color={C.cyan} />
          <MetricCard label="Total Invested" value={`$${fmt(totalInvested)}`} color={C.textMid} />
          <MetricCard label="Total P/L" value={`$${fmt(totalPL)}`} sub={`${totalPL >= 0 ? "+" : ""}${totalPLPct.toFixed(1)}%`} color={totalPL >= 0 ? C.green : C.red} />
        </Grid>
        <div style={{ height: 8 }} />
        <Grid cols={3} gap={10}>
          <MetricCard label="Roth NAV" value={`$${fmt(roth.total)}`} color={C.cyan} />
          <MetricCard label="Taxable NAV" value={`$${fmt(taxable.total)}`} color={C.purple} />
          <MetricCard label="SBLOC LTV" value={`${ltv.toFixed(1)}%`} sub={`Debt: $${fmt(latestDebt)}`} color={ltv > 25 ? C.red : ltv > 20 ? C.amber : C.green} />
        </Grid>
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.textDim, marginBottom: 4 }}>
            <span>Progress to ${settings.target_nav.toLocaleString()}</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: C.cyan }}>{pctToTarget.toFixed(1)}%</span>
          </div>
          <ProgressBar pct={pctToTarget} />
        </div>
      </Section>

      {/* NAV Projection Chart */}
      <Section title="📉 NAV Growth Projection (5yr)">
        <div style={{ background: C.card, borderRadius: 12, padding: "12px 8px", border: `1px solid ${C.border}` }}>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={projectionData}>
              <defs>
                <linearGradient id="navGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.purple} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={C.purple} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="month" tick={{ fill: C.textDim, fontSize: 10 }} tickFormatter={v => v % 12 === 0 ? `Y${v / 12}` : ""} />
              <YAxis tick={{ fill: C.textDim, fontSize: 10 }} tickFormatter={fmtK} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="nav" stroke={C.purple} fill="url(#navGrad)" strokeWidth={2} name="Projected NAV" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* Global Allocation */}
      <Section title="🌐 Global Asset Allocation">
        {allHoldings.length > 0 ? (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {/* ĐÃ THAY BẰNG COMPONENT CHUẨN */}
            <div style={{ flex: "1 1 240px", minWidth: 200 }}>
              <PortfolioDonut data={allHoldings} totalValue={totalNAV} accentColor={C.cyan} />
            </div>
            <div style={{ flex: "2 1 300px", minWidth: 260, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}>
                <thead>
                  <tr>{["Ticker", "Value", "Cost", "P/L", "Weight"].map(h => (
                    <th key={h} style={{ textAlign: "right", padding: "6px 8px", color: C.textDim, borderBottom: `1px solid ${C.border}`, fontSize: 10, textTransform: "uppercase" }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {[...allHoldings].sort((a, b) => b.value - a.value).map((r, i) => (
                    <tr key={r.ticker} style={{ borderBottom: `1px solid ${C.border}15` }}>
                      <td style={{ padding: "6px 8px", fontWeight: 700, color: DONUT_COLORS[i % DONUT_COLORS.length] }}>{r.ticker}</td>
                      <td style={{ textAlign: "right", padding: "6px 8px", color: C.text }}>${fmt(r.value)}</td>
                      <td style={{ textAlign: "right", padding: "6px 8px", color: C.textDim }}>${fmt(r.cost)}</td>
                      <td style={{ textAlign: "right", padding: "6px 8px", color: r.pl >= 0 ? C.green : C.red }}>{r.pl >= 0 ? "+" : ""}${fmt(r.pl)}</td>
                      <td style={{ textAlign: "right", padding: "6px 8px", color: C.textMid }}>{r.weight.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : <div style={{ color: C.textDim, textAlign: "center", padding: 40 }}>No positions yet. Add transactions to see allocation.</div>}
      </Section>

      {/* ═══════════════════════════════════════════════════════ */}
      {/*  YIELD-ON-COST TRACKER                                  */}
      {/* ═══════════════════════════════════════════════════════ */}
      <Section title="🔜 Yield-on-Cost Tracker">
        {yocData.rows.length > 0 ? (
          <>
            <Grid cols={4} gap={10}>
              <MetricCard
                label="Forward YoC"
                value={`${yocData.portfolioYoC.toFixed(2)}%`}
                sub={`Annual: $${fmt(yocData.totalForwardAnnualDivs, 0)}`}
                color="#00FF88"
                large
              />
              <MetricCard
                label="Forward Yield"
                value={`${yocData.portfolioCurrentYield.toFixed(2)}%`}
                sub="On market value"
                color={C.cyan}
              />
              <MetricCard
                label="Expected Income"
                value={`$${fmt(yocData.totalForwardAnnualDivs, 0)}`}
                sub={`~$${fmt(yocData.totalForwardAnnualDivs / 12, 1)}/mo`}
                color={C.green}
              />
              <MetricCard
                label="Cost Basis"
                value={`$${fmt(yocData.totalCost, 0)}`}
                sub={`${yocData.rows.length} payer${yocData.rows.length !== 1 ? "s" : ""}`}
                color={C.textMid}
              />
            </Grid>

            <div style={{
              marginTop: 12, marginBottom: 12,
              background: `linear-gradient(135deg, ${C.card}, #0C2816)`,
              border: `1px solid ${C.green}30`, borderLeft: `3px solid ${C.green}`,
              borderRadius: 10, padding: "10px 14px", fontSize: 12, color: C.textMid, lineHeight: 1.6,
            }}>
              <strong style={{ color: C.green }}>📈 YoC Insight:</strong>{" "}
              Using real-time Forward Dividend Rates from Yahoo Finance. 
              YoC of <strong style={{ color: "#00FF88" }}>{yocData.portfolioYoC.toFixed(2)}%</strong> means every $1 you originally invested is projected to return ${(yocData.portfolioYoC / 100).toFixed(3)}/year.
              {yocData.portfolioYoC > yocData.portfolioCurrentYield + 0.5 && (
                <> Your YoC is <strong style={{ color: C.green }}>{(yocData.portfolioYoC - yocData.portfolioCurrentYield).toFixed(2)}%</strong> above current market yield — your early purchases are paying off.</>
              )}
            </div>

            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12 }}>
              <YoCTable rows={yocData.rows} />
            </div>

            {/* YoC bar chart visualization */}
            <div style={{ background: C.card, borderRadius: 12, padding: "12px 8px", border: `1px solid ${C.border}`, marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, padding: "0 8px 8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>YoC vs Current Yield by Ticker</div>
              <ResponsiveContainer width="100%" height={Math.max(220, yocData.rows.length * 40)}>
                <BarChart data={yocData.rows} layout="vertical" margin={{ left: 10, right: 30, top: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                  <XAxis type="number" tick={{ fill: C.textDim, fontSize: 10 }} tickFormatter={v => `${v}%`} />
                  <YAxis type="category" dataKey="ticker" tick={{ fill: C.text, fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }} width={55} />
                  <Tooltip
                    formatter={(v) => `${Number(v).toFixed(2)}%`}
                    contentStyle={{ background: C.card + "F0", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="currentYield" name="Current Yield" fill={C.cyan} radius={[0, 4, 4, 0]} />
                  <Bar dataKey="yoc" name="Yield on Cost" fill="#00FF88" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        ) : (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textDim, fontSize: 13 }}>
            No dividend history yet. Log dividends in <strong style={{ color: C.purple }}>Taxable → Dividends</strong> to activate Yield-on-Cost tracking.
          </div>
        )}
      </Section>
    </>
  );

  // ═══════════════════════════════════════════════════════════
  //  PAGE: CASHFLOW PLANNER
  // ═══════════════════════════════════════════════════════════
  const CashflowPage = () => {
    const [tab, setTab] = useState("log");
    const [form, setForm] = useState({ month_year: nowYM(), va: 0, w2_gross: 0, w2_net: 0, mha: 0, pell: 0, income_1099: 0, other_income: 0 });

    useEffect(() => {
      const existing = incomes.find(i => i.month_year === form.month_year);
      if (existing) {
        setForm({
          month_year: existing.month_year, va: parseFloat(existing.va) || 0, w2_gross: parseFloat(existing.w2_gross) || 0,
          w2_net: parseFloat(existing.w2_net) || 0, mha: parseFloat(existing.mha) || 0, pell: parseFloat(existing.pell) || 0,
          income_1099: parseFloat(existing.income_1099) || 0, other_income: parseFloat(existing.other_income) || 0,
        });
      } else {
        setForm(f => f.month_year === form.month_year ? { month_year: form.month_year, va: 0, w2_gross: 0, w2_net: 0, mha: 0, pell: 0, income_1099: 0, other_income: 0 } : f);
      }
    }, [form.month_year, incomes]);

    const previewSurplus = useMemo(() => {
      const va = parseFloat(form.va) || 0;
      const w2n = parseFloat(form.w2_net) || 0;
      const w2g = parseFloat(form.w2_gross) || 0;
      const w2 = w2n > 0 ? w2n : w2g;
      const mha = parseFloat(form.mha) || 0;
      const pell = parseFloat(form.pell) || 0;
      const i1099 = parseFloat(form.income_1099) || 0;
      const other = parseFloat(form.other_income) || 0;
      const exp = parseFloat(settings.monthly_expenses) || 0;
      return (va + w2 + mha + pell + i1099 + other) - exp;
    }, [form, settings.monthly_expenses]);

    const surplusData = useMemo(() => incomes.map(i => ({
      month: i.month_year, surplus: Quant.netSurplus(i, settings.monthly_expenses),
      total: (parseFloat(i.va)||0) + (parseFloat(i.w2_net)||0 || parseFloat(i.w2_gross)||0) + (parseFloat(i.mha)||0) + (parseFloat(i.pell)||0) + (parseFloat(i.income_1099)||0) + (parseFloat(i.other_income)||0),
    })), [incomes, settings.monthly_expenses]);
    const avgS = surplusData.length > 0 ? surplusData.reduce((a, b) => a + b.surplus, 0) / surplusData.length : 0;
    const totalIn = surplusData.reduce((a, b) => a + b.total, 0);

    const handleSave = async () => {
      const clean = {
        month_year: form.month_year, va: parseFloat(form.va) || 0, w2_gross: parseFloat(form.w2_gross) || 0,
        w2_net: parseFloat(form.w2_net) || 0, mha: parseFloat(form.mha) || 0, pell: parseFloat(form.pell) || 0,
        income_1099: parseFloat(form.income_1099) || 0, other_income: parseFloat(form.other_income) || 0,
      };
      const updated = [...incomes.filter(i => i.month_year !== clean.month_year), clean].sort((a, b) => a.month_year.localeCompare(b.month_year));
      setIncomes(updated);
      await save("income", updated);
      const surplus = Quant.netSurplus(clean, settings.monthly_expenses);
      flash(`${clean.month_year}: Net ${surplus >= 0 ? "Surplus" : "Deficit"} = $${fmt(surplus)}`, surplus >= 0 ? "green" : "red");
    };

    const handleDelete = async (my) => {
      const updated = incomes.filter(i => i.month_year !== my);
      setIncomes(updated);
      await save("income", updated);
      flash(`Deleted ${my}`, "amber");
    };

    return (
      <>
        <TabBar tabs={[{ id: "log", icon: "📝", label: "Log Income" }, { id: "history", icon: "📊", label: "History" }]} active={tab} onChange={setTab} />

        {tab === "log" && (
          <Section title="Enter Monthly Income">
            <InputField label="Month (YYYY-MM)" value={form.month_year} onChange={v => setForm({ ...form, month_year: v })} />
            <Grid cols={3} gap={8}>
              <InputField label="VA Disability" type="number" value={form.va} onChange={v => setForm({ ...form, va: v })} step="100" min="0" />
              <InputField label="W-2 Gross" type="number" value={form.w2_gross} onChange={v => setForm({ ...form, w2_gross: v })} step="100" min="0" />
              <InputField label="W-2 Net" type="number" value={form.w2_net} onChange={v => setForm({ ...form, w2_net: v })} step="100" min="0" />
            </Grid>
            <Grid cols={3} gap={8}>
              <InputField label="GI Bill MHA" type="number" value={form.mha} onChange={v => setForm({ ...form, mha: v })} step="100" min="0" />
              <InputField label="Pell / Grants" type="number" value={form.pell} onChange={v => setForm({ ...form, pell: v })} step="100" min="0" />
              <InputField label="1099 Income" type="number" value={form.income_1099} onChange={v => setForm({ ...form, income_1099: v })} step="100" min="0" />
            </Grid>
            <InputField label="Other Income" type="number" value={form.other_income} onChange={v => setForm({ ...form, other_income: v })} step="100" min="0" />
            <div style={{ marginTop: 8 }}>
              <Btn onClick={handleSave} full>Save & Calculate</Btn>
            </div>
            <div style={{ marginTop: 12, background: C.card, borderRadius: 10, padding: 14, border: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase" }}>Preview Net Surplus</div>
                {incomes.find(i => i.month_year === form.month_year) && (
                  <span style={{ fontSize: 9, background: `${C.cyan}18`, color: C.cyan, padding: "2px 8px", borderRadius: 10, fontWeight: 700 }}>EDITING EXISTING</span>
                )}
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: previewSurplus >= 0 ? C.green : C.red, marginTop: 4 }}>
                ${fmt(previewSurplus)}
              </div>
              <div style={{ fontSize: 11, color: C.textDim }}>Formula: (VA + W2 + MHA + Pell + 1099 + Other) - ${fmt(settings.monthly_expenses, 0)} expenses</div>
            </div>
          </Section>
        )}

        {tab === "history" && (
          <>
            <Grid cols={3} gap={10}>
              <MetricCard label="Avg Monthly Surplus" value={`$${fmt(avgS, 0)}`} color={avgS >= 0 ? C.green : C.red} />
              <MetricCard label="Total Income (All)" value={`$${fmt(totalIn, 0)}`} color={C.cyan} />
              <MetricCard label="Months Logged" value={String(incomes.length)} color={C.purple} />
            </Grid>
            {surplusData.length > 0 && (
              <div style={{ background: C.card, borderRadius: 12, padding: "12px 8px", border: `1px solid ${C.border}`, marginTop: 16 }}>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={surplusData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="month" tick={{ fill: C.textDim, fontSize: 10 }} />
                    <YAxis tick={{ fill: C.textDim, fontSize: 10 }} tickFormatter={v => `$${v >= 0 ? "" : ""}${(v / 1000).toFixed(0)}k`} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="surplus" name="Net Surplus" radius={[4, 4, 0, 0]}>
                      {surplusData.map((d, i) => <Cell key={i} fill={d.surplus >= 0 ? C.green : C.red} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              {incomes.slice().reverse().map(row => {
                const s = Quant.netSurplus(row, settings.monthly_expenses);
                return (
                  <div key={row.month_year} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 14px", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
                    <span style={{ fontWeight: 700, color: C.text, fontSize: 13, minWidth: 70 }}>{row.month_year}</span>
                    <span style={{ fontSize: 11, color: C.textDim }}>VA ${fmt(row.va, 0)} | W2 ${fmt(row.w2_net, 0)} | MHA ${fmt(row.mha, 0)}</span>
                    <span style={{ fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: s >= 0 ? C.green : C.red, fontSize: 14 }}>{s >= 0 ? "+" : ""}${fmt(s, 0)}</span>
                    <button onClick={() => handleDelete(row.month_year)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 16 }}>🗑</button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </>
    );
  };

  // ═══════════════════════════════════════════════════════════
  //  PAGE: ROTH SHIELD
  // ═══════════════════════════════════════════════════════════
  const RothShieldPage = () => {
    const [form, setForm] = useState({ date: nowDate(), ticker: "", type: "Buy", shares: 0, price: 0 });
    const [rothSearch, setRothSearch] = useState("");
    const [rothView, setRothView] = useState("core");
    const [expandedMonths, setExpandedMonths] = useState(() => new Set([nowYM()]));
    const rothTickers = assets.filter(a => a.account_type === "Roth").map(a => a.ticker);
    const autoTotal = form.shares * form.price;
    const rothInvested = useMemo(() => Quant.totalInvested(transactions, assets, "Roth"), [transactions, assets]);
    const rothPL = roth.total - rothInvested;

    const { displayRows, displayTotal } = useMemo(() => {
      const filtered = rothView === "core" ? roth.rows.filter(r => r.targetWeight > 0) : roth.rows;
      const total = filtered.reduce((s, r) => s + r.value, 0);
      const withRebalance = total > 0
        ? filtered.map(r => {
            const currentWeight = (r.value / total) * 100;
            const targetVal = (r.targetWeight / 100) * total;
            const rebalance = targetVal - r.value;
            return { ...r, weight: currentWeight, rebalance };
          })
        : filtered;
      return { displayRows: withRebalance, displayTotal: total };
    }, [roth.rows, rothView]);

    const donutData = useMemo(() => displayRows.filter(r => r.value > 0), [displayRows]);

    useEffect(() => { if (rothTickers.length && !form.ticker) setForm(f => ({ ...f, ticker: rothTickers[0] })); }, [rothTickers]);

    const handleSubmit = async () => {
      if (form.shares <= 0 || form.price <= 0) { flash("Shares and Price must be > 0", "amber"); return; }
      if (rothBreached && form.type !== "Sell") { flash("Roth buys blocked — staircase breach!", "red"); return; }
      const txn = { ...form, total_amount: Math.round(autoTotal * 100) / 100, id: Date.now() };
      const updated = [...transactions, txn];
      setTransactions(updated);
      await save("transactions", updated);
      flash(`✅ ${form.type} ${form.shares} ${form.ticker} @ $${form.price}`);
      setForm({ ...form, shares: 0, price: 0 });
    };

    // ── [UPGRADE 1] Enhanced grouped Roth transactions ──────
    const groupedRothTxns = useMemo(() => {
      const groups = {};
      const tickers = new Set(rothTickers);
      const filtered = transactions.filter(t =>
        tickers.has(t.ticker) &&
        (t.ticker.toLowerCase().includes(rothSearch.toLowerCase()) ||
          t.type.toLowerCase().includes(rothSearch.toLowerCase()))
      );
      filtered.forEach(t => {
        const monthYear = t.date.substring(0, 7);
        if (!groups[monthYear]) groups[monthYear] = [];
        groups[monthYear].push(t);
      });
      return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
    }, [transactions, rothTickers, rothSearch]);

    const toggleMonth = (my) => {
      setExpandedMonths(prev => {
        const next = new Set(prev);
        if (next.has(my)) next.delete(my); else next.add(my);
        return next;
      });
    };

    const toggleAll = () => {
      const allMonths = groupedRothTxns.map(([my]) => my);
      const allExpanded = allMonths.every(my => expandedMonths.has(my));
      setExpandedMonths(allExpanded ? new Set() : new Set(allMonths));
    };

    return (
      <>
        <Section title={`${year} Roth Staircase Constraint`}>
          <Grid cols={3} gap={10}>
            <MetricCard label="YTD W-2 Gross" value={`$${fmt(ytdW2)}`} color={C.cyan} />
            <MetricCard label="YTD Roth Contributions" value={`$${fmt(ytdRoth)}`} color={C.purple} />
            <MetricCard label="Remaining Space" value={`$${fmt(rothSpace)}`} color={rothBreached ? C.red : C.green} />
          </Grid>
          <div style={{ marginTop: 12 }}>
            {rothBreached ? <AlertBanner type="red">🚫 STAIRCASE BREACH: Roth contributions exceed W-2 gross. DO NOT contribute more.</AlertBanner>
              : rothPct > 80 ? <AlertBanner type="amber">⚠️ Roth space at {rothPct.toFixed(0)}% capacity. Only ${fmt(rothSpace)} remaining.</AlertBanner>
              : <AlertBanner type="green">✅ Roth staircase healthy. {rothPct.toFixed(0)}% used — ${fmt(rothSpace)} available.</AlertBanner>}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <ProgressBar pct={rothPct} color={rothBreached ? C.red : rothPct > 80 ? C.amber : C.green} />
              <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", color: C.textMid, minWidth: 40 }}>{Math.min(rothPct, 100).toFixed(0)}%</span>
            </div>
          </div>
        </Section>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: "2 1 300px", minWidth: 260 }}>
            <Section title="Roth Portfolio">
              <Grid cols={3} gap={10}>
                <MetricCard label="Roth NAV (All)" value={`$${fmt(roth.total)}`} color={C.cyan} />
                <MetricCard label="Invested" value={`$${fmt(rothInvested)}`} color={C.textMid} />
                <MetricCard label="P/L" value={`$${fmt(rothPL)}`} sub={`${rothPL >= 0 ? "+" : ""}${rothInvested > 0 ? ((rothPL / rothInvested) * 100).toFixed(1) : "0.0"}%`} color={rothPL >= 0 ? C.green : C.red} />
              </Grid>

              <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <ViewToggle value={rothView} onChange={setRothView} coreLabel="🎯 Core ETFs" globalLabel="🌐 Global Roth" />
                <span style={{ fontSize: 11, color: C.textDim }}>
                  Showing {displayRows.length} of {roth.rows.length} ticker{roth.rows.length !== 1 ? "s" : ""} • <span style={{ color: C.cyan, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>${fmt(displayTotal, 0)}</span>
                </span>
              </div>

              <PortfolioDonut data={donutData} totalValue={displayTotal} accentColor={C.cyan} colorOffset={0} />
              <PortfolioTable rows={displayRows} accentColor={C.cyan} showTarget={true} />

              {/* [UPGRADE 5] Sync Rebalance to Actions */}
              {displayRows.some(r => r.rebalance && Math.abs(r.rebalance) >= 1) && (
                <div style={{ marginTop: 12 }}>
                  <Btn onClick={() => syncRebalanceToActions(displayRows, "Roth")} variant="ghost" full>
                    ⚡ Sync Rebalance to Actions
                  </Btn>
                </div>
              )}
            </Section>
          </div>

          <div style={{ flex: "1 1 260px", minWidth: 240 }}>
            <Section title="Log Roth Transaction">
              <InputField label="Date" type="date" value={form.date} onChange={v => setForm({ ...form, date: v })} />
              {rothTickers.length > 0 ? (
                <>
                  <SelectField label="Ticker" value={form.ticker} onChange={v => setForm({ ...form, ticker: v })} options={rothTickers} />
                  <SelectField label="Type" value={form.type} onChange={v => setForm({ ...form, type: v })} options={["Buy", "Sell", "DRIP"]} />
                  <Grid cols={2} gap={8}>
                    <InputField label="Shares" type="number" value={form.shares} onChange={v => setForm({ ...form, shares: v })} step="0.01" min="0" />
                    <InputField label="Price ($)" type="number" value={form.price} onChange={v => setForm({ ...form, price: v })} step="0.01" min="0" />
                  </Grid>
                  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase" }}>Total — auto</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: C.cyan, fontFamily: "'IBM Plex Mono', monospace" }}>${fmt(autoTotal)}</div>
                  </div>
                  {rothBreached && form.type !== "Sell" && <AlertBanner type="red">🚫 Roth buys blocked — staircase breach.</AlertBanner>}
                  <Btn onClick={handleSubmit} full disabled={rothBreached && form.type !== "Sell"}>Record Roth Transaction</Btn>
                </>
              ) : <div style={{ color: C.textDim, fontSize: 13 }}>Add Roth tickers in Settings first.</div>}
            </Section>

            {/* [UPGRADE 1 & 2] Enhanced Collapsible Roth History */}
            <Section title="Roth Investment History">
              <div style={{ marginBottom: 12 }}>
                <input
                  value={rothSearch} onChange={e => setRothSearch(e.target.value)}
                  placeholder="🔍 Search Roth ticker or type..."
                  style={{ width: "100%", padding: "8px 12px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12, outline: "none", fontFamily: "'IBM Plex Mono', monospace" }}
                />
              </div>

              {groupedRothTxns.length > 0 && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                  <button onClick={toggleAll} style={{
                    background: C.cardAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 12px",
                    color: C.textMid, cursor: "pointer", fontSize: 10, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace",
                  }}>
                    {groupedRothTxns.every(([my]) => expandedMonths.has(my)) ? "▼ Collapse All" : "▶ Expand All"}
                  </button>
                </div>
              )}

              <ScrollableHistory maxHeight={480}>
                {groupedRothTxns.length > 0 ? (
                  groupedRothTxns.map(([monthYear, txns]) => (
                    <CollapsibleMonthGroup
                      key={monthYear}
                      monthYear={monthYear}
                      txns={txns}
                      accentColor={C.cyan}
                      isExpanded={expandedMonths.has(monthYear)}
                      onToggle={() => toggleMonth(monthYear)}
                      onDelete={deleteTransaction}
                    />
                  ))
                ) : (
                  <div style={{ color: C.textDim, fontSize: 12, textAlign: "center", padding: 20 }}>No Roth transactions found.</div>
                )}
              </ScrollableHistory>
            </Section>
          </div>
        </div>
      </>
    );
  };

  // ═══════════════════════════════════════════════════════════
  //  PAGE: TAXABLE ENGINE
  // ═══════════════════════════════════════════════════════════
  const TaxableEnginePage = () => {
    const [tab, setTab] = useState("portfolio");
    const [taxView, setTaxView] = useState("core");
    const [txnForm, setTxnForm] = useState({ date: nowDate(), ticker: "", type: "Buy", shares: 0, price: 0 });
    const [debtForm, setDebtForm] = useState({ date: nowDate(), amount: 0 });
    const [divForm, setDivForm] = useState({ date: nowDate(), ticker: "", amount: 0 });
    const [actionMonth, setActionMonth] = useState(nowYM());
    const [newAction, setNewAction] = useState("");
    const [taxSearch, setTaxSearch] = useState("");
    const [expandedMonths, setExpandedMonths] = useState(() => new Set([nowYM()]));
    const taxTickers = assets.filter(a => a.account_type === "Taxable").map(a => a.ticker);
    const taxInvested = useMemo(() => Quant.totalInvested(transactions, assets, "Taxable"), [transactions, assets]);
    const taxPL = taxable.total - taxInvested;

    const { displayRows, displayTotal } = useMemo(() => {
      const filtered = taxView === "core" ? taxable.rows.filter(r => r.targetWeight > 0) : taxable.rows;
      const total = filtered.reduce((s, r) => s + r.value, 0);
      const withRebalance = total > 0
        ? filtered.map(r => {
            const currentWeight = (r.value / total) * 100;
            const targetVal = (r.targetWeight / 100) * total;
            const rebalance = targetVal - r.value;
            return { ...r, weight: currentWeight, rebalance };
          })
        : filtered;
      return { displayRows: withRebalance, displayTotal: total };
    }, [taxable.rows, taxView]);

    const donutData = useMemo(() => displayRows.filter(r => r.value > 0), [displayRows]);

    // ── [UPGRADE 1] Enhanced grouped taxable transactions ───
    const groupedTaxTxns = useMemo(() => {
      const groups = {};
      const tickers = new Set(taxTickers);
      const filtered = transactions.filter(t =>
        tickers.has(t.ticker) &&
        (t.ticker.toLowerCase().includes(taxSearch.toLowerCase()) ||
          t.type.toLowerCase().includes(taxSearch.toLowerCase()))
      );
      filtered.forEach(t => {
        const monthYear = t.date.substring(0, 7);
        if (!groups[monthYear]) groups[monthYear] = [];
        groups[monthYear].push(t);
      });
      return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
    }, [transactions, taxTickers, taxSearch]);

    const toggleMonth = (my) => {
      setExpandedMonths(prev => {
        const next = new Set(prev);
        if (next.has(my)) next.delete(my); else next.add(my);
        return next;
      });
    };

    const toggleAll = () => {
      const allMonths = groupedTaxTxns.map(([my]) => my);
      const allExpanded = allMonths.every(my => expandedMonths.has(my));
      setExpandedMonths(allExpanded ? new Set() : new Set(allMonths));
    };

    // ── [UPGRADE 3] Grouped dividends ────────────────────────
    const groupedDividends = useMemo(() => {
      const groups = {};
      dividends.forEach(d => {
        const monthYear = d.date.substring(0, 7);
        if (!groups[monthYear]) groups[monthYear] = [];
        groups[monthYear].push(d);
      });
      return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
    }, [dividends]);

    useEffect(() => { if (taxTickers.length && !txnForm.ticker) setTxnForm(f => ({ ...f, ticker: taxTickers[0] })); }, [taxTickers]);
    useEffect(() => { if (taxTickers.length && !divForm.ticker) setDivForm(f => ({ ...f, ticker: taxTickers[0] })); }, [taxTickers]);

    const handleTxn = async () => {
      if (txnForm.shares <= 0 || txnForm.price <= 0) { flash("Shares and Price must be > 0", "amber"); return; }
      const txn = { ...txnForm, total_amount: Math.round(txnForm.shares * txnForm.price * 100) / 100, id: Date.now() };
      const updated = [...transactions, txn];
      setTransactions(updated);
      await save("transactions", updated);
      flash(`✅ ${txnForm.type} ${txnForm.shares} ${txnForm.ticker} @ $${txnForm.price}`);
      setTxnForm({ ...txnForm, shares: 0, price: 0 });
    };

    const handleDebt = async () => {
      const updated = [...sbloc, { date: debtForm.date, amount: debtForm.amount }];
      setSbloc(updated);
      await save("sbloc", updated);
      flash(`SBLOC debt updated: $${fmt(debtForm.amount)}`);
    };

    const handleDiv = async () => {
      const updated = [...dividends, { date: divForm.date, ticker: divForm.ticker, amount: divForm.amount, id: Date.now() }];
      setDividends(updated);
      await save("dividends", updated);
      flash(`Dividend: $${fmt(divForm.amount)} from ${divForm.ticker}`);
    };

    const handleAddAction = async () => {
      if (!newAction.trim()) return;
      const item = { id: Date.now(), month_year: actionMonth, description: newAction, completed: false };
      const updated = [...actions, item];
      setActions(updated);
      await save("actions", updated);
      setNewAction("");
    };

    const toggleAction = async (id) => {
      const updated = actions.map(a => a.id === id ? { ...a, completed: !a.completed } : a);
      setActions(updated);
      await save("actions", updated);
    };

    const deleteAction = async (id) => {
      const updated = actions.filter(a => a.id !== id);
      setActions(updated);
      await save("actions", updated);
    };

    const totalDivs = dividends.reduce((s, d) => s + d.amount, 0);
    const monthActions = actions.filter(a => a.month_year === actionMonth);

    const safeLtvLimit = 0.25;
    const maxSafeLoan = taxable.total * safeLtvLimit;
    const remainingSafeCapacity = Math.max(0, maxSafeLoan - latestDebt);

    return (
      <>
        <TabBar tabs={[
          { id: "portfolio", icon: "📈", label: "Portfolio" }, { id: "sbloc", icon: "🏦", label: "SBLOC" },
          { id: "dividends", icon: "💸", label: "Dividends" }, { id: "actions", icon: "📋", label: "Actions" },
        ]} active={tab} onChange={setTab} />

        {tab === "portfolio" && (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ flex: "2 1 300px", minWidth: 260 }}>
              <Grid cols={3} gap={10}>
                <MetricCard label="Taxable NAV (All)" value={`$${fmt(taxable.total)}`} color={C.purple} />
                <MetricCard label="Invested" value={`$${fmt(taxInvested)}`} color={C.textMid} />
                <MetricCard label="P/L" value={`$${fmt(taxPL)}`} sub={`${taxPL >= 0 ? "+" : ""}${taxInvested > 0 ? ((taxPL / taxInvested) * 100).toFixed(1) : "0.0"}%`} color={taxPL >= 0 ? C.green : C.red} />
              </Grid>

              <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <ViewToggle value={taxView} onChange={setTaxView} coreLabel="🎯 Core ETFs" globalLabel="🌐 Global Taxable" />
                <span style={{ fontSize: 11, color: C.textDim }}>
                  Showing {displayRows.length} of {taxable.rows.length} ticker{taxable.rows.length !== 1 ? "s" : ""} • <span style={{ color: C.purple, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>${fmt(displayTotal, 0)}</span>
                </span>
              </div>

              <PortfolioDonut data={donutData} totalValue={displayTotal} accentColor={C.purple} colorOffset={3} />
              <PortfolioTable rows={displayRows} accentColor={C.purple} showTarget={true} />

              {/* [UPGRADE 5] Sync Rebalance to Actions */}
              {displayRows.some(r => r.rebalance && Math.abs(r.rebalance) >= 1) && (
                <div style={{ marginTop: 12 }}>
                  <Btn onClick={() => syncRebalanceToActions(displayRows, "Taxable")} variant="ghost" full>
                    ⚡ Sync Rebalance to Actions
                  </Btn>
                </div>
              )}

              {/* [UPGRADE 1 & 2] Enhanced Collapsible Taxable History */}
              {groupedTaxTxns.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>History by Month</div>
                    <button onClick={toggleAll} style={{
                      background: C.cardAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 12px",
                      color: C.textMid, cursor: "pointer", fontSize: 10, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace",
                    }}>
                      {groupedTaxTxns.every(([my]) => expandedMonths.has(my)) ? "▼ Collapse All" : "▶ Expand All"}
                    </button>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <input
                      value={taxSearch} onChange={e => setTaxSearch(e.target.value)}
                      placeholder="🔍 Search ticker or type (Buy/Sell/DRIP)..."
                      style={{ width: "100%", padding: "8px 12px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12, outline: "none", fontFamily: "'IBM Plex Mono', monospace" }}
                    />
                  </div>
                  <ScrollableHistory maxHeight={520}>
                    {groupedTaxTxns.map(([monthYear, txns]) => (
                      <CollapsibleMonthGroup
                        key={monthYear}
                        monthYear={monthYear}
                        txns={txns}
                        accentColor={C.purple}
                        isExpanded={expandedMonths.has(monthYear)}
                        onToggle={() => toggleMonth(monthYear)}
                        onDelete={deleteTransaction}
                      />
                    ))}
                  </ScrollableHistory>
                </div>
              )}
            </div>

            <div style={{ flex: "1 1 240px", minWidth: 220 }}>
              <Section title="Log Taxable Transaction">
                <InputField label="Date" type="date" value={txnForm.date} onChange={v => setTxnForm({ ...txnForm, date: v })} />
                {taxTickers.length > 0 ? (
                  <>
                    <SelectField label="Ticker" value={txnForm.ticker} onChange={v => setTxnForm({ ...txnForm, ticker: v })} options={taxTickers} />
                    <SelectField label="Type" value={txnForm.type} onChange={v => setTxnForm({ ...txnForm, type: v })} options={["Buy", "Sell", "DRIP"]} />
                    <Grid cols={2} gap={8}>
                      <InputField label="Shares" type="number" value={txnForm.shares} onChange={v => setTxnForm({ ...txnForm, shares: v })} step="0.01" />
                      <InputField label="Price ($)" type="number" value={txnForm.price} onChange={v => setTxnForm({ ...txnForm, price: v })} step="0.01" />
                    </Grid>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                      <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase" }}>Total — auto</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: C.purple, fontFamily: "'IBM Plex Mono', monospace" }}>${fmt(txnForm.shares * txnForm.price)}</div>
                    </div>
                    <Btn onClick={handleTxn} full>Record Taxable Transaction</Btn>
                  </>
                ) : <div style={{ color: C.textDim }}>Add Taxable tickers in Settings.</div>}
              </Section>
            </div>
          </div>
        )}

        {tab === "sbloc" && (
          <Section title="SBLOC Health Monitor">
            <Grid cols={3} gap={10}>
              <MetricCard label="Taxable NAV (Collateral)" value={`$${fmt(taxable.total)}`} color={C.purple} />
              <MetricCard label="SBLOC Debt" value={`$${fmt(latestDebt)}`} color={C.red} />
              <MetricCard label="LTV Ratio" value={`${ltv.toFixed(1)}%`} color={ltv > 25 ? C.red : ltv > 20 ? C.amber : C.green} />
            </Grid>
            <div style={{ marginTop: 12 }}>
              {ltv > 25 ? <AlertBanner type="red">🚨 LTV @ {ltv.toFixed(1)}% — DANGER ZONE. Reduce debt immediately.</AlertBanner>
                : ltv > 20 ? <AlertBanner type="amber">⚠️ LTV @ {ltv.toFixed(1)}% — Approaching limit.</AlertBanner>
                : <AlertBanner type="green">✅ LTV @ {ltv.toFixed(1)}% — Safe range.</AlertBanner>}
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 16 }}>
              <div style={{ flex: "1 1 200px" }}>
                <SvgGauge value={ltv} max={40} label={ltv > 25 ? "DANGER" : ltv > 20 ? "CAUTION" : "SAFE"} subLabel="Loan-to-Value %" thresholds={[
                  { from: 0, to: 0.375, color: C.green }, { from: 0.375, to: 0.5, color: "#84CC16" },
                  { from: 0.5, to: 0.625, color: C.amber }, { from: 0.625, to: 1, color: C.red },
                ]} />
              </div>
              <div style={{ flex: "1 1 240px" }}>
                <div style={{ background: `linear-gradient(135deg, ${C.card}, #1E1B4B)`, border: `1px solid ${C.purple}40`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.purple, marginBottom: 8, textTransform: "uppercase" }}>🛡️ Safe Borrowing Intel</div>
                  <Grid cols={2} gap={10}>
                    <div>
                      <div style={{ fontSize: 10, color: C.textDim }}>MAX SAFE LOAN (25%)</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>${fmt(maxSafeLoan)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: C.textDim }}>AVAILABLE</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: C.green }}>${fmt(remainingSafeCapacity)}</div>
                    </div>
                  </Grid>
                  <div style={{ marginTop: 10, fontSize: 11, color: C.textDim, fontStyle: "italic" }}>
                    Dựa trên NAV: ${fmt(taxable.total)}. Bạn có thể vay thêm <span style={{ color: C.cyan, fontWeight: 700 }}>${fmt(remainingSafeCapacity)}</span> an toàn.
                  </div>
                </div>

                <Section title="Update SBLOC Debt">
                  <InputField label="Date" type="date" value={debtForm.date} onChange={v => setDebtForm({ ...debtForm, date: v })} />
                  <InputField label="Current Debt ($)" type="number" value={debtForm.amount} onChange={v => setDebtForm({ ...debtForm, amount: v })} step="100" />
                  <Btn onClick={handleDebt} full>Update Debt</Btn>
                </Section>
              </div>
            </div>
            {sbloc.length > 1 && (
              <div style={{ background: C.card, borderRadius: 12, padding: "12px 8px", border: `1px solid ${C.border}`, marginTop: 16 }}>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={sbloc}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="date" tick={{ fill: C.textDim, fontSize: 10 }} />
                    <YAxis tick={{ fill: C.textDim, fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="amount" stroke={C.red} fill={C.red + "20"} strokeWidth={2} name="Debt" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Section>
        )}

        {/* [UPGRADE 3] Advanced Dividends Management */}
        {tab === "dividends" && (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px" }}>
              <Section title="Log Dividend">
                <InputField label="Date" type="date" value={divForm.date} onChange={v => setDivForm({ ...divForm, date: v })} />
                {taxTickers.length > 0 && <SelectField label="Ticker" value={divForm.ticker} onChange={v => setDivForm({ ...divForm, ticker: v })} options={[...new Set([...taxTickers, ...assets.filter(a => a.account_type === "Roth").map(a => a.ticker)])]} />}
                <InputField label="Amount ($)" type="number" value={divForm.amount} onChange={v => setDivForm({ ...divForm, amount: v })} step="1" />
                <Btn onClick={handleDiv} full>Record Dividend</Btn>
              </Section>
            </div>
            <div style={{ flex: "2 1 300px" }}>
              <MetricCard label="Total Dividends Received" value={`$${fmt(totalDivs)}`} color={C.green} large />

              {/* Grouped dividends by month with ticker breakdown */}
              <ScrollableHistory maxHeight={480}>
                <div style={{ marginTop: 12 }}>
                  {groupedDividends.length > 0 ? groupedDividends.map(([monthYear, divs]) => {
                    const monthTotal = divs.reduce((s, d) => s + d.amount, 0);
                    // Ticker breakdown for this month
                    const tickerTotals = {};
                    divs.forEach(d => {
                      if (!tickerTotals[d.ticker]) tickerTotals[d.ticker] = 0;
                      tickerTotals[d.ticker] += d.amount;
                    });
                    return (
                      <div key={monthYear} style={{ marginBottom: 14 }}>
                        <div style={{
                          background: `${C.green}10`, padding: "6px 12px", borderRadius: "8px 8px 0 0",
                          borderLeft: `3px solid ${C.green}`, display: "flex", justifyContent: "space-between", alignItems: "center",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: C.green }}>💰 {monthYear}</span>
                            <span style={{ fontSize: 9, color: C.textDim }}>{divs.length} DIVIDEND{divs.length !== 1 ? "S" : ""}</span>
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 700, color: C.green, fontFamily: "'IBM Plex Mono', monospace" }}>+${fmt(monthTotal, 0)}</span>
                        </div>
                        {/* Ticker summary pills */}
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 10px", background: C.cardAlt, borderLeft: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}` }}>
                          {Object.entries(tickerTotals).map(([ticker, amt]) => (
                            <span key={ticker} style={{
                              fontSize: 9, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace",
                              padding: "2px 6px", borderRadius: 4, background: `${C.green}10`, color: C.green,
                              border: `1px solid ${C.green}20`,
                            }}>
                              {ticker}: +${fmt(amt, 0)}
                            </span>
                          ))}
                        </div>
                        <div style={{ border: `1px solid ${C.border}`, borderTop: "none", borderRadius: "0 0 8px 8px", padding: 4 }}>
                          {[...divs].sort((a, b) => b.date.localeCompare(a.date)).map(d => (
                            <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", fontSize: 11, borderBottom: `1px solid ${C.border}40` }}>
                              <span style={{ color: C.textDim }}>{d.date}</span>
                              <span style={{ fontWeight: 700, color: C.cyan }}>{d.ticker}</span>
                              <span style={{ fontWeight: 700, color: C.green, fontFamily: "'IBM Plex Mono', monospace" }}>+${fmt(d.amount)}</span>
                              <button onClick={() => deleteDividend(d.id)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", opacity: 0.6, fontSize: 14 }}>🗑</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }) : (
                    <div style={{ color: C.textDim, fontSize: 12, textAlign: "center", padding: 20 }}>No dividends recorded yet.</div>
                  )}
                </div>
              </ScrollableHistory>
            </div>
          </div>
        )}

        {tab === "actions" && (
          <Section title="Monthly Buy Orders & Actions">
            <InputField label="Month (YYYY-MM)" value={actionMonth} onChange={setActionMonth} />
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input value={newAction} onChange={e => setNewAction(e.target.value)} placeholder='e.g. "Buy $600 SPYI"'
                style={{ flex: 1, padding: "10px 14px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: "none" }}
                onKeyDown={e => e.key === "Enter" && handleAddAction()} />
              <Btn onClick={handleAddAction}>Add</Btn>
            </div>
            {monthActions.map(item => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", marginBottom: 4 }}>
                <input type="checkbox" checked={item.completed} onChange={() => toggleAction(item.id)}
                  style={{ accentColor: C.cyan, width: 18, height: 18 }} />
                <span style={{ flex: 1, fontSize: 13, color: item.completed ? C.textDim : C.text, textDecoration: item.completed ? "line-through" : "none" }}>{item.description}</span>
                <button onClick={() => deleteAction(item.id)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer" }}>🗑</button>
              </div>
            ))}
            {monthActions.length === 0 && <div style={{ color: C.textDim, fontSize: 13, textAlign: "center", padding: 20 }}>No actions for {actionMonth}.</div>}
          </Section>
        )}
      </>
    );
  };

  // ═══════════════════════════════════════════════════════════
  //  PAGE: STRATEGY LAB
  // ═══════════════════════════════════════════════════════════
  const StrategyLabPage = () => {
    const [rate, setRate] = useState(settings.expected_annual_return * 100);
    const [dca, setDca] = useState(Math.max(avgSurplus, 500));
    const projData = useMemo(() => Quant.projectFV(totalNAV, rate / 100 / 12, 240, dca), [totalNAV, rate, dca]);
    const ruleOf72 = (72 / rate).toFixed(1);
    const ruleOf114 = (114 / rate).toFixed(1);
    const inflation = 2.4;
    const ruleOf70 = (70 / inflation).toFixed(1);
    const realReturn = rate - inflation;
    const monthsToTarget = useMemo(() => {
      let v = totalNAV, m = 0;
      while (v < settings.target_nav && m < 600) { v = v * (1 + rate / 100 / 12) + dca; m++; }
      return m;
    }, [totalNAV, rate, dca, settings.target_nav]);

    return (
      <>
        <Section title="Strategy Lab — Staircase Blitz">
          <Grid cols={3} gap={10}>
            <MetricCard label="Expected Return" value={`${rate.toFixed(1)}%`} color={C.cyan} />
            <MetricCard label="Current NAV" value={`$${fmt(totalNAV, 0)}`} sub={`Target: $${settings.target_nav.toLocaleString()}`} color={C.purple} />
            <MetricCard label="Monthly DCA" value={`$${fmt(dca, 0)}`} sub="From surplus" color={C.green} />
          </Grid>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, color: C.textDim, minWidth: 110 }}>Expected return:</span>
              <input type="range" min="4" max="25" step="0.5" value={rate} onChange={e => setRate(parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: C.cyan }} />
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: C.cyan, minWidth: 45, textAlign: "right" }}>{rate.toFixed(1)}%</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, color: C.textDim, minWidth: 110 }}>Monthly DCA:</span>
              <input type="range" min="0" max="5000" step="100" value={dca} onChange={e => setDca(parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: C.green }} />
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: C.green, minWidth: 60, textAlign: "right" }}>${dca.toLocaleString()}</span>
            </div>
          </div>
        </Section>

        <Section title="Investment Rules">
          <Grid cols={3} gap={10}>
            {[
              { name: "Rule of 72", formula: `72 ÷ ${rate}%`, result: `${ruleOf72} years`, color: "#3B82F6", desc: `Double $${totalNAV.toLocaleString()} → $${(totalNAV * 2).toLocaleString()}` },
              { name: "Rule of 114", formula: `114 ÷ ${rate}%`, result: `${ruleOf114} years`, color: C.purple, desc: `Triple to $${(totalNAV * 3).toLocaleString()}` },
              { name: "Rule of 70 (Inflation)", formula: `70 ÷ ${inflation}%`, result: `${ruleOf70} years`, color: C.red, desc: `Purchasing power halves` },
            ].map(r => (
              <div key={r.name} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, marginBottom: 6 }}>{r.name}</div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.cyan, background: C.bg, borderRadius: 6, padding: "4px 8px", marginBottom: 8 }}>{r.formula}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: r.color }}>{r.result}</div>
                <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>{r.desc}</div>
              </div>
            ))}
          </Grid>
        </Section>

        <Section title="Timeline Projection (20 years)">
          <div style={{ background: C.card, borderRadius: 12, padding: "12px 8px", border: `1px solid ${C.border}` }}>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={projData}>
                <defs>
                  <linearGradient id="projGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.purple} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={C.purple} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="month" tick={{ fill: C.textDim, fontSize: 10 }} tickFormatter={v => v % 12 === 0 ? `Y${v / 12}` : ""} interval={11} />
                <YAxis tick={{ fill: C.textDim, fontSize: 10 }} tickFormatter={fmtK} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="nav" stroke={C.purple} fill="url(#projGrad)" strokeWidth={2.5} name="Projected NAV" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, background: `linear-gradient(135deg, ${C.card}, #0C2816)`, border: `1px solid ${C.green}30`, borderRadius: 12, padding: 16, borderLeft: `3px solid ${C.green}` }}>
            <div style={{ fontWeight: 700, color: C.green, marginBottom: 6, fontSize: 14 }}>🎯 Target ${settings.target_nav.toLocaleString()}</div>
            <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>
              With DCA ${dca.toLocaleString()}/mo: reach target in <strong style={{ color: C.cyan }}>{(monthsToTarget / 12).toFixed(1)} years</strong> ({monthsToTarget} months).
              Pure compound (Rule of 72): double in {ruleOf72} years — DCA turbocharges small bases.
            </div>
          </div>
          <div style={{ flex: 1, background: `linear-gradient(135deg, ${C.card}, #2C1A07)`, border: `1px solid ${C.amber}30`, borderRadius: 12, padding: 16, borderLeft: `3px solid ${C.amber}` }}>
            <div style={{ fontWeight: 700, color: C.amber, marginBottom: 6, fontSize: 14 }}>⚠️ Inflation Warning</div>
            <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>
              CPI {inflation}% → purchasing power halves in <strong style={{ color: C.red }}>{ruleOf70} years</strong>.
              Real return = {rate}% - {inflation}% = <strong style={{ color: C.cyan }}>{realReturn.toFixed(1)}%</strong>.
            </div>
          </div>
        </div>
      </>
    );
  };

  // ═══════════════════════════════════════════════════════════
  //  PAGE: MARKET INTEL
  // ═══════════════════════════════════════════════════════════
  const MarketIntelPage = () => {
    const [heatView, setHeatView] = useState("mag7");
    const [heatPeriod, setHeatPeriod] = useState("1d");
    const [periodData, setPeriodData] = useState(heatmapData);
    const [loadingHeat, setLoadingHeat] = useState(false);

    useEffect(() => {
      if (!apiOnline) { setPeriodData(heatmapData); return; }
      let cancelled = false;
      const fetchHeat = async () => {
        setLoadingHeat(true);
        try {
          const [mag7Res, sectorsRes] = await Promise.all([
            fetch(`${API_BASE}/heatmap/mag7?period=${heatPeriod}`).then(r => r.json()).catch(() => null),
            fetch(`${API_BASE}/heatmap/sectors?period=${heatPeriod}`).then(r => r.json()).catch(() => null),
          ]);
          if (cancelled) return;
          const hd = { ...HEATMAP_DATA };
          if (mag7Res && Array.isArray(mag7Res) && mag7Res.length > 0) hd.mag7 = mag7Res;
          if (sectorsRes && Array.isArray(sectorsRes) && sectorsRes.length > 0) hd.sectors = sectorsRes;
          setPeriodData(hd);
        } catch { /* keep fallback */ }
        setLoadingHeat(false);
      };
      fetchHeat();
      return () => { cancelled = true; };
    }, [heatPeriod, apiOnline]);

    const fedNextMeeting = settings.fed_next_meeting || fedRate.nextMeeting || "—";
    const fedProbHold = parseFloat(settings.fed_prob_hold) || 0;
    const fedProbCut = parseFloat(settings.fed_prob_cut) || 0;
    const fedProbHike = parseFloat(settings.fed_prob_hike) || 0;

    return (
      <>
        <Section title="🏛️ Fed Rate Tracker">
          <Grid cols={3} gap={10}>
            <MetricCard label="Current Fed Rate" value={`${fedRate.current}%`} sub={`Prev: ${fedRate.prev}%`} color={C.cyan} large />
            <MetricCard label="Next Meeting" value={fedNextMeeting} color={C.amber} large />
            <div style={{ background: `linear-gradient(135deg, ${C.card}, ${C.cardAlt})`, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 18px" }}>
              <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 }}>Decision Probabilities</div>
              {[["Hold", fedProbHold, C.textMid], ["Cut 25bp", fedProbCut, C.green], ["Hike 25bp", fedProbHike, C.red]].map(([l, v, c]) => (
                <div key={l} style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
                    <span style={{ color: C.textDim }}>{l}</span>
                    <span style={{ fontWeight: 700, color: c, fontFamily: "'IBM Plex Mono', monospace" }}>{v}%</span>
                  </div>
                  <ProgressBar pct={v} color={c} height={6} />
                </div>
              ))}
              <div style={{ fontSize: 9, color: C.textDim, marginTop: 6, fontStyle: "italic" }}>Edit in Settings → Fed Tracker</div>
            </div>
          </Grid>
        </Section>

        <Section title="🗺️ Market Heatmap">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <TabBar tabs={[{ id: "mag7", icon: "💎", label: "Magnificent 7" }, { id: "sectors", icon: "🏗️", label: "Sectors" }]} active={heatView} onChange={setHeatView} />
            <div style={{ display: "inline-flex", gap: 2, background: C.card, borderRadius: 8, padding: 2 }}>
              {["1d", "1w"].map(p => (
                <button key={p} onClick={() => setHeatPeriod(p)} style={{
                  padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700,
                  background: heatPeriod === p ? `${C.amber}20` : "transparent", color: heatPeriod === p ? C.amber : C.textDim,
                  fontFamily: "'IBM Plex Mono', monospace", transition: "all 0.2s",
                }}>{p.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div style={{ background: C.card, borderRadius: 12, padding: 8, border: `1px solid ${C.border}`, position: "relative" }}>
            {loadingHeat && <div style={{ position: "absolute", top: 8, right: 12, fontSize: 10, color: C.amber, fontFamily: "'IBM Plex Mono', monospace" }}>Loading...</div>}
            <ResponsiveContainer width="100%" height={300}>
              <Treemap data={periodData[heatView]} dataKey="size" nameKey="name" content={<TreemapContent />} />
            </ResponsiveContainer>
          </div>
          <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
            {[["< -3%", "#DC2626"], ["-3% to -1%", "#EF4444"], ["-1% to 0%", "#FCA5A5"], ["0% to +1%", "#4ADE80"], ["+1% to +3%", "#22C55E"], ["> +3%", "#16A34A"]].map(([l, c]) => (
              <div key={l} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: C.textDim }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: c }} />{l}
              </div>
            ))}
          </div>
        </Section>

        <Section title="📊 Market Summary">
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, lineHeight: 1.7, fontSize: 13, color: C.textMid }}>
            <strong style={{ color: C.cyan }}>Quantitative Assessment:</strong> VIX @ {vixData.current} indicates {vlbl.toLowerCase()} sentiment.
            Fed Funds Rate at {fedRate.current}% with {fedProbCut}% probability of a cut at the next meeting ({fedNextMeeting}).
            <br /><br />
            <strong style={{ color: C.amber }}>Action Items:</strong> {marketSummary}
            <br /><br />
            <em style={{ color: C.textDim }}>{apiOnline
              ? `Live data from backend. Fed rate source: ${fedRate.source || "API"}. Last refresh: ${lastFetch || "—"}.`
              : "Backend offline — showing cached data. Start backend for live feeds."
            }</em>
          </div>
        </Section>
      </>
    );
  };

  // ═══════════════════════════════════════════════════════════
  //  SETTINGS PANEL
  // ═══════════════════════════════════════════════════════════
  const SettingsPanel = () => {
    const [s, setS] = useState({ ...settings });
    const [newTicker, setNewTicker] = useState("");
    const [newAcct, setNewAcct] = useState("Taxable");
    const [newWeight, setNewWeight] = useState(0);
    const [priceInput, setPriceInput] = useState({});

    const saveSettings = async () => {
      setSettings(s);
      await save("settings", s);
      flash("Settings saved!");
      setShowSettings(false);
    };

    const addTicker = async () => {
      if (!newTicker.trim()) return;
      const updated = [...assets.filter(a => a.ticker !== newTicker.toUpperCase()), { ticker: newTicker.toUpperCase().trim(), account_type: newAcct, target_weight: newWeight }];
      setAssets(updated);
      await save("assets", updated);
      setNewTicker("");
      flash(`Added ${newTicker.toUpperCase()}`);
    };

    const removeTicker = async (ticker) => {
      const updated = assets.filter(a => a.ticker !== ticker);
      setAssets(updated);
      await save("assets", updated);
      flash(`Removed ${ticker}`, "amber");
    };

    const updatePrices = async () => {
      const merged = { ...prices, ...priceInput };
      setPrices(merged);
      await save("prices", merged);
      flash("Prices updated!");
    };

    return (
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(380px, 90vw)", background: C.bg, borderLeft: `1px solid ${C.border}`, zIndex: 1000, overflowY: "auto", padding: 20, boxShadow: "-4px 0 30px rgba(0,0,0,0.5)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, color: C.text, margin: 0 }}>⚙ Settings</h2>
          <button onClick={() => setShowSettings(false)} style={{ background: "none", border: "none", color: C.textDim, fontSize: 24, cursor: "pointer" }}>✕</button>
        </div>
        <Section title="General">
          <InputField label="Target NAV ($)" type="number" value={s.target_nav} onChange={v => setS({ ...s, target_nav: v })} step="10000" />
          <InputField label="Monthly Expenses ($)" type="number" value={s.monthly_expenses} onChange={v => setS({ ...s, monthly_expenses: v })} step="100" />
          <InputField label="Expected Annual Return" type="number" value={s.expected_annual_return} onChange={v => setS({ ...s, expected_annual_return: v })} step="0.01" />
          <Btn onClick={saveSettings} full>Save Settings</Btn>
        </Section>
        <Section title="🏛️ Fed Tracker (Manual)">
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8 }}>FRED provides the current rate automatically. Meeting dates and probabilities must be set manually (source: CME FedWatch).</div>
          <InputField label="Next Fed Meeting Date" value={s.fed_next_meeting || ""} onChange={v => setS({ ...s, fed_next_meeting: v })} placeholder="e.g. 2026-06-18" />
          <Grid cols={3} gap={8}>
            <InputField label="% Prob: Hold" type="number" value={s.fed_prob_hold || 0} onChange={v => setS({ ...s, fed_prob_hold: v })} step="1" min="0" />
            <InputField label="% Prob: Cut" type="number" value={s.fed_prob_cut || 0} onChange={v => setS({ ...s, fed_prob_cut: v })} step="1" min="0" />
            <InputField label="% Prob: Hike" type="number" value={s.fed_prob_hike || 0} onChange={v => setS({ ...s, fed_prob_hike: v })} step="1" min="0" />
          </Grid>
          <Btn onClick={saveSettings} full>Save Fed Settings</Btn>
        </Section>
        <Section title="Manage Tickers">
          {assets.map(a => (
            <div key={a.ticker} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.card, borderRadius: 6, padding: "6px 10px", marginBottom: 4, fontSize: 12 }}>
              <span><strong style={{ color: C.cyan }}>{a.ticker}</strong> — {a.account_type} ({a.target_weight}%)</span>
              <button onClick={() => removeTicker(a.ticker)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer" }}>✕</button>
            </div>
          ))}
          <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            <Grid cols={2} gap={8}>
              <InputField label="Ticker" value={newTicker} onChange={setNewTicker} placeholder="e.g. VOO" />
              <SelectField label="Account" value={newAcct} onChange={setNewAcct} options={["Taxable", "Roth"]} />
            </Grid>
            <InputField label="Target Weight %" type="number" value={newWeight} onChange={setNewWeight} step="5" />
            <Btn onClick={addTicker} full variant="ghost">Add Ticker</Btn>
          </div>
        </Section>
        <Section title="Manual Price Update">
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8 }}>Enter current prices for your tickers. In production, these come from yfinance API.</div>
          {assets.map(a => (
            <div key={a.ticker} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.cyan, minWidth: 50 }}>{a.ticker}</span>
              <input type="number" step="0.01" 
                placeholder={prices[a.ticker] ? `$${typeof prices[a.ticker] === 'object' ? prices[a.ticker].price : prices[a.ticker]}` : "Price"}
                value={priceInput[a.ticker] || ""} 
                onChange={e => {
                  const val = parseFloat(e.target.value) || 0;
                  const oldDiv = typeof prices[a.ticker] === 'object' ? (prices[a.ticker].divRate || 0) : 0;
                  setPriceInput({ ...priceInput, [a.ticker]: { price: val, divRate: oldDiv } });
                }}
                style={{ flex: 1, padding: "6px 10px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", outline: "none" }} />
            </div>
          ))}
          <Btn onClick={updatePrices} full>Update All Prices</Btn>
        </Section>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════════
  //  NAVIGATION
  // ═══════════════════════════════════════════════════════════
  const NAV_ITEMS = [
    { id: "dashboard", icon: "🎯", label: "Dashboard" },
    { id: "cashflow", icon: "💰", label: "Cashflow" },
    { id: "roth", icon: "🛡️", label: "Roth" },
    { id: "taxable", icon: "⚙️", label: "Taxable" },
    { id: "strategy", icon: "🔬", label: "Strategy" },
    { id: "market", icon: "🌐", label: "Market" },
  ];

  const renderPage = () => {
    switch (page) {
      case "dashboard": return <DashboardPage />;
      case "cashflow": return <CashflowPage />;
      case "roth": return <RothShieldPage />;
      case "taxable": return <TaxableEnginePage />;
      case "strategy": return <StrategyLabPage />;
      case "market": return <MarketIntelPage />;
      default: return <DashboardPage />;
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Sans', sans-serif", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        input[type="range"] { height: 4px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @media (max-width: 640px) {
          .whale-grid-3 { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* HEADER */}
      <header style={{ position: "sticky", top: 0, zIndex: 100, background: C.bg + "E8", backdropFilter: "blur(12px)", borderBottom: `1px solid ${C.border}`, padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 28 }}>🐋</span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 700, background: `linear-gradient(135deg, ${C.cyan}, ${C.purple})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>THE WHALE OS</span>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 20, background: apiOnline ? `${C.green}15` : `${C.red}15`, border: `1px solid ${apiOnline ? C.green : C.red}30` }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: apiOnline ? C.green : C.red, boxShadow: apiOnline ? `0 0 6px ${C.green}` : "none", animation: apiOnline ? "pulse 2s infinite" : "none" }} />
                <span style={{ fontSize: 9, fontWeight: 700, color: apiOnline ? C.green : C.red, letterSpacing: "0.05em" }}>{apiOnline ? "LIVE" : "OFFLINE"}</span>
              </div>
              <CloudBadge status={cloudStatus} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 9, color: C.textDim, letterSpacing: "0.15em", textTransform: "uppercase" }}>Personal Finance Command Center</span>
              {lastFetch && <span style={{ fontSize: 8, color: C.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>• {lastFetch}</span>}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {apiOnline && <button onClick={() => fetchMarketData(assets.map(a => a.ticker))} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 8px", color: C.textDim, cursor: "pointer", fontSize: 12 }} title="Refresh market data">⟳</button>}
          <button onClick={() => setShowSettings(true)} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 12px", color: C.textMid, cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>⚙ Settings</button>
        </div>
      </header>

      {/* FLASH MESSAGE */}
      {msg && (
        <div style={{ position: "fixed", top: 60, left: "50%", transform: "translateX(-50%)", zIndex: 200, padding: "10px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600,
          background: msg.type === "green" ? C.green + "20" : msg.type === "red" ? C.red + "20" : C.amber + "20",
          border: `1px solid ${msg.type === "green" ? C.green : msg.type === "red" ? C.red : C.amber}`,
          color: msg.type === "green" ? C.green : msg.type === "red" ? C.red : C.amber,
          animation: "fadeIn 0.3s ease",
        }}>{msg.text}</div>
      )}

      {/* MAIN CONTENT */}
      <main style={{ padding: "16px 16px 90px 16px", maxWidth: 1100, margin: "0 auto" }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16, color: C.text }}>
          {NAV_ITEMS.find(n => n.id === page)?.icon} {NAV_ITEMS.find(n => n.id === page)?.label}
        </h2>
        {renderPage()}
      </main>

      {/* BOTTOM NAVIGATION */}
      <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.bg + "F5", backdropFilter: "blur(12px)", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-around", padding: "6px 0 max(6px, env(safe-area-inset-bottom))", zIndex: 100 }}>
        {NAV_ITEMS.map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} style={{
            background: "none", border: "none", cursor: "pointer", padding: "4px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            color: page === n.id ? C.cyan : C.textDim, transition: "color 0.2s", minWidth: 0, flex: 1,
          }}>
            <span style={{ fontSize: 18 }}>{n.icon}</span>
            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.02em" }}>{n.label}</span>
            {page === n.id && <div style={{ width: 16, height: 2, borderRadius: 1, background: C.cyan, marginTop: 1 }} />}
          </button>
        ))}
      </nav>

      {/* SETTINGS PANEL */}
      {showSettings && (
        <>
          <div onClick={() => setShowSettings(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 999 }} />
          <SettingsPanel />
        </>
      )}
    </div>
  );
}
