// ============================================================
//  持仓记账 + 收益分析 + 策略联动（单页应用，无后端）
//  数据源：eastmoney（基金净值 / 行情 / 国债收益率）
// ============================================================
"use strict";

window.addEventListener("error", (e) => {
  const el = document.getElementById("syncNote");
  if (el) { el.textContent = "JS错误: " + e.message; el.style.color = "#ffe08a"; }
});

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let S = null;
let PRICES = {};
let SERIES = null;
let RANGE = "ALL";
let SIGNAL = null;
let CSV_ROWS = null;
const NAME_CACHE = {};

const LS_KEY = "pf_state_v1";
const LS_CFG = "pf_cfg_v1";

function today() { return new Date().toISOString().slice(0, 10); }
function uid() { return Math.random().toString(36).slice(2, 9); }
function fmt(x, d) {
  if (d === undefined) d = 2;
  if (x === null || x === undefined || isNaN(x)) return "-";
  return Number(x).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPnl(x) {
  if (x === null || x === undefined || isNaN(x)) return "-";
  return (x >= 0 ? "+" : "") + fmt(x, 2);
}

function pct(x, d) { return (x * 100).toFixed(d === undefined ? 2 : d) + "%"; }
function days(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function money(x) { return "¥" + fmt(x, 2); }

// ---------- 默认设置 ----------
function ensureSettings() {
  S.settings = S.settings || {};
  const st = S.settings;
  st.targets = st.targets || { rot: 50, spy: 25, ndx: 25 };
  st.divCode = st.divCode || "515080";
  st.bondCode = st.bondCode || "511010";
  st.pe = st.pe || { value: 13.09, date: "2026-11-20" };
  S.legs = S.legs || {};
  st.plans = S.plans = S.plans || [];
  S.plans.forEach((pl) => {
    if (!pl.per) {
      const d = pl.freq === "daily" ? 21 : pl.freq === "weekly" ? 4 : 1;
      pl.per = pl.monthly ? Number((pl.monthly / d).toFixed(2)) : 0;
    }
  });
  S.planSkip = S.planSkip || {};
}

async function loadState() {
  const local = localStorage.getItem(LS_KEY);
  if (local) { try { S = JSON.parse(local); } catch (e) { S = null; } }
  if (!S) {
    const c0 = cfg();
    if (c0.repo && c0.token) {
      try { const d = await ghRead(c0, true); if (d) S = d; } catch (e) { /* 忽略，走本地 */ }
    }
  }
  if (!S) {
    try { const r = await fetch("data.json?t=" + Date.now()); S = await r.json(); }
    catch (e) { S = { version: 1, accounts: [], cash: {}, flows: [], trades: [], priceCache: {} }; }
  }
  S.accounts = S.accounts || [];
  S.cash = S.cash || {};
  S.flows = S.flows || [];
  S.trades = S.trades || [];
  S.priceCache = S.priceCache || {};
  ensureSettings();
}
let syncTimer = null;
function saveLocal() {
  localStorage.setItem(LS_KEY, JSON.stringify(S));
  const c = cfg();
  if (c.autoSync && c.repo && c.token) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      ghSave(true).then(() => {
        const el = document.getElementById("syncNote");
        if (el) el.textContent = "已自动同步 " + new Date().toLocaleTimeString("zh-CN");
      }).catch(() => {});
    }, 1500);
  }
}

// ---------- 行情 ----------
function jsonpLoad(url, timeout) {
  timeout = timeout || 12000;
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; s.remove(); reject(new Error("timeout")); } }, timeout);
    s.onload = () => { if (!done) { done = true; clearTimeout(t); resolve(); s.remove(); } };
    s.onerror = () => { if (!done) { done = true; clearTimeout(t); s.remove(); reject(new Error("load")); } };
    s.src = url;
    document.head.appendChild(s);
  });
}

async function fetchFundNav(code) {
  const u = "https://fund.eastmoney.com/pingzhongdata/" + code + ".js?v=" + Date.now();
  await jsonpLoad(u);
  const nav = window.Data_netWorthTrend || [];
  const ac = window.Data_ACWorthTrend || [];
  if (window.fS_name) NAME_CACHE[code] = String(window.fS_name).replace(/[A-Z]\(.*\)$/, '');
  window.Data_netWorthTrend = null; window.Data_ACWorthTrend = null;
  if (!nav.length) throw new Error("no nav");
  const acMap = {};
  ac.forEach((p) => { acMap[new Date(p[0]).toISOString().slice(0, 10)] = Number(p[1]); });
  const out = [];
  let tr = 1, prevNav = null, prevAC = null;
  for (const p of nav) {
    const d = new Date(p.x).toISOString().slice(0, 10);
    const px = Number(p.y);
    const acc = acMap[d];
    if (prevNav && acc !== undefined && prevAC !== undefined) tr *= 1 + (acc - prevAC) / prevNav;
    else if (prevNav) tr *= px / prevNav;
    out.push({ date: d, px: px, tr: tr });
    prevNav = px; prevAC = acc;
  }
  return out;
}

async function fetchKline(code, fqt) {
  const q = (fqt === undefined) ? 1 : fqt;
  for (const mk of ["1", "0"]) {
    const cb = "cbk_" + code + "_" + Math.random().toString(36).slice(2, 6);
    let payload = null;
    window[cb] = (js) => { payload = js; };
    try {
      const u = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + mk + "." + code +
        "&fields1=f1&fields2=f51,f53&klt=101&fqt=" + q + "&beg=0&end=20500101&cb=" + cb;
      await jsonpLoad(u);
      if (payload && payload.data && payload.data.klines && payload.data.klines.length) {
        delete window[cb];
        return payload.data.klines.map((k) => {
          const arr = k.split(",");
          return { date: arr[0], px: Number(arr[1]), tr: Number(arr[1]) };
        });
      }
    } catch (e) { /* try next */ }
    delete window[cb];
  }
  return [];
}

// 交易所价格(px) + 前复权(tr)：tr/px 的比值变化用来识别分红
async function fetchKlinePair(code) {
  const raw = await fetchKline(code, 0);
  if (!raw.length) return [];
  let adj = [];
  try { adj = await fetchKline(code, 1); } catch (e) { adj = []; }
  const m = {};
  adj.forEach((a) => { m[a.date] = a.tr; });
  return raw.map((r) => ({ date: r.date, px: r.px, tr: m[r.date] || r.px }));
}


function marketForCode(code) {
  const ts = S.trades.filter((x) => x.code === code);
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i].market) return ts[i].market;
  return "";
}

async function loadPrices(codes, force) {
  const out = {};
  for (const code of codes) {
    const cached = S.priceCache[code];
    const fresh = cached && cached.length && days(cached[cached.length - 1].date, today()) <= 1;
    if (cached && fresh && !force) { out[code] = cached; continue; }
    let arr = [];
    const mkt = marketForCode(code);
    if (mkt === "场内") {
      // 场内：用交易所收盘价，和券商显示一致
      try { arr = await fetchKlinePair(code); } catch (e) { arr = []; }
      if (!arr.length) { try { arr = await fetchFundNav(code); } catch (e) { arr = []; } }
    } else {
      try { arr = await fetchFundNav(code); } catch (e) { arr = []; }
      if (!arr.length) { try { arr = await fetchKlinePair(code); } catch (e) { arr = []; } }
    }
    if (arr.length) {
      if (arr.length > 2000) arr = arr.slice(-2000);
      out[code] = arr; S.priceCache[code] = arr;
    }
    else if (cached) out[code] = cached;
  }
  PRICES = out;
  saveLocal();
}

// ---------- 回放 ----------
function priceOn(code, date) {
  const arr = PRICES[code];
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? arr[ans] : null;
}

function allDates() {
  const set = {};
  for (const c in PRICES) for (const p of PRICES[c]) set[p.date] = 1;
  for (const t of S.trades) set[t.date] = 1;
  for (const f of S.flows) set[f.date] = 1;
  return Object.keys(set).sort();
}

function replay() {
  const dates = allDates();
  if (!dates.length) return [];
  let first = null;
  S.flows.forEach((f) => { if (!first || f.date < first) first = f.date; });
  S.trades.forEach((t) => { if (!first || t.date < first) first = t.date; });
  if (!first) first = dates[0];
  const ds = dates.filter((d) => d >= first);
  const flows = S.flows.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const trades = S.trades.slice().sort((a, b) => (a.date < b.date ? -1 : 1));

  let cash = 0;
  Object.keys(S.cash || {}).forEach((k) => { cash += Number(S.cash[k] || 0); });
  const hold = {};
  const lastE = {};
  let ti = 0, fi = 0;
  const rows = [];
  let nav = 1, prevValue = null;

  for (const d of ds) {
    let cf = 0;
    while (fi < flows.length && flows[fi].date <= d) { cash += Number(flows[fi].amount); cf += Number(flows[fi].amount); fi++; }
    while (ti < trades.length && trades[ti].date <= d) {
      const t = trades[ti];
      const sh = Number(t.shares), px = Number(t.price);
      if (t.side === "buy") { cash -= sh * px + Number(t.fee || 0); hold[t.code] = (hold[t.code] || 0) + sh; }
      else { cash += sh * px - Number(t.fee || 0); hold[t.code] = (hold[t.code] || 0) - sh; }
      ti++;
    }
    let mv = 0;
    Object.keys(hold).forEach((c) => {
      if (Math.abs(hold[c]) < 1e-9) return;
      const e = priceOn(c, d);
      if (!e) return;
      const prev = lastE[c];
      if (prev && prev.date !== e.date && prev.px > 0 && prev.tr > 0) {
        const ratio = (e.tr / prev.tr) / (e.px / prev.px);
        if (ratio > 1.15) hold[c] *= ratio;
        else if (ratio > 1.002) cash += hold[c] * prev.px * (ratio - 1);
      }
      lastE[c] = e;
      mv += hold[c] * e.px;
    });
    const value = mv + cash;
    if (prevValue !== null && prevValue > 0) nav *= (value - cf) / prevValue;
    rows.push({ date: d, value: value, cash: cash, mv: mv, nav: nav, cf: cf });
    prevValue = value;
  }
  return rows;
}

// ---------- 指标 ----------
function sliceFrom(rows, range) {
  if (!rows || !rows.length) return [];
  if (range === "ALL") return rows;
  const last = rows[rows.length - 1].date;
  const map = { "1M": 30, "2M": 61, "3M": 92, "6M": 183, "1Y": 365, "2Y": 730, "3Y": 1095, "5Y": 1826, "10Y": 3653 };
  const n = map[range] || 3650;
  const start = new Date(new Date(last).getTime() - n * 86400000).toISOString().slice(0, 10);
  const out = rows.filter((r) => r.date >= start);
  return out.length >= 2 ? out : rows.slice(-Math.min(rows.length, 2));
}

function metrics(rows) {
  if (!rows || rows.length < 2) return null;
  const ret = rows[rows.length - 1].nav / rows[0].nav - 1;
  let peak = -Infinity, mdd = 0;
  for (const r of rows) { peak = Math.max(peak, r.nav); mdd = Math.min(mdd, r.nav / peak - 1); }
  const d = days(rows[0].date, rows[rows.length - 1].date) || 1;
  const cagr = Math.pow(1 + ret, 365 / d) - 1;
  const rs = [];
  for (let i = 1; i < rows.length; i++) rs.push(rows[i].nav / rows[i - 1].nav - 1);
  const mean = rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
  const vol = Math.sqrt(rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rs.length || 1)) * Math.sqrt(252);
  return { ret: ret, mdd: mdd, cagr: cagr, vol: vol, days: d };
}

// ---------- 持仓 & 归因 ----------
function lastPrice(code) {
  const arr = PRICES[code];
  return arr && arr.length ? arr[arr.length - 1].px : null;
}

function holdings() {
  const hold = {};
  for (const t of S.trades) {
    if (!hold[t.code]) hold[t.code] = { code: t.code, name: t.name || t.code, shares: 0, cost: 0 };
    const h = hold[t.code];
    if (t.side === "buy") { h.shares += Number(t.shares); h.cost += Number(t.shares) * Number(t.price) + Number(t.fee || 0); }
    else {
      const avg = h.shares > 0 ? h.cost / h.shares : 0;
      h.shares -= Number(t.shares);
      h.cost -= avg * Number(t.shares);
    }
  }
  return Object.keys(hold).map((k) => hold[k]).filter((h) => Math.abs(h.shares) > 1e-9);
}

function attribution() {
  const st = {};
  const trades = S.trades.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const t of trades) {
    if (!st[t.code]) st[t.code] = { code: t.code, name: t.name || t.code, shares: 0, cost: 0, realized: 0, invested: 0 };
    const h = st[t.code];
    const sh = Number(t.shares), px = Number(t.price), fee = Number(t.fee || 0);
    if (t.side === "buy") { h.shares += sh; h.cost += sh * px + fee; h.invested += sh * px + fee; }
    else {
      const avg = h.shares > 0 ? h.cost / h.shares : 0;
      h.realized += sh * (px - avg) - fee;
      h.cost -= avg * sh;
      h.shares -= sh;
    }
  }
  return Object.keys(st).map((k) => {
    const h = st[k];
    const p = lastPrice(h.code);
    const mv = p ? p * h.shares : 0;
    const un = p ? mv - h.cost : 0;
    const total = h.realized + un;
    return {
      code: h.code, name: h.name, realized: h.realized, unrealized: un, total: total,
      // 收益率按「累计买入成本」算，卖出回本的部分也算投入，已清仓的标的也能给出结果
      rate: h.invested > 0 ? total / h.invested : null
    };
  }).sort((a, b) => b.total - a.total);
}

// ---------- 信号 ----------
function bucketOf(erp) {
  if (!isFinite(erp)) return null;
  if (erp > 6) return { eq: 100, tag: "加倍定投", cls: "warn", desc: ">6%：满仓红利，不配国债" };
  if (erp > 5) return { eq: 70, tag: "正常持有", cls: "", desc: "5~6%：70% 红利 + 30% 国债" };
  if (erp > 4) return { eq: 40, tag: "降低权益", cls: "", desc: "4~5%：40% 红利 + 60% 国债" };
  return { eq: 0, tag: "清仓权益", cls: "cool", desc: "≤4%：0% 红利 + 100% 国债" };
}

function fetchY10() {
  return new Promise((resolve, reject) => {
    const cb = "cby" + Date.now();
    window[cb] = (js) => {
      try {
        const row = js && js.result && js.result.data && js.result.data[0];
        resolve(row ? Number(row.EMM00166466) : null);
      } catch (e) { resolve(null); }
    };
    jsonpLoad("https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD" +
      "&columns=ALL&pageNumber=1&pageSize=1&sortColumns=SOLAR_DATE&sortTypes=-1&callback=" + cb)
      .catch(() => resolve(null));
  });
}

async function loadSignal(force) {
  if (!force && SIGNAL && days(SIGNAL.date || "2000-01-01", today()) <= 1) return SIGNAL;
  let sig = null;
  try {
    const r = await fetch("signal.json?t=" + Date.now());
    if (r.ok) { const j = await r.json(); if (j && j.pe) sig = j; }
  } catch (e) { /* 没有就算了 */ }
  const y10 = await fetchY10();
  const pe = (sig && sig.pe) || S.settings.pe.value;
  const date = (sig && sig.date) || S.settings.pe.date || today();
  SIGNAL = { date: date, pe: pe, y10: y10 !== null ? y10 : (sig && sig.y10) || null, src: sig ? "自建信号文件" : "手动/实时" };
  SIGNAL.erp = (SIGNAL.y10 && pe) ? (100 / pe - SIGNAL.y10) : null;
  return SIGNAL;
}

// ---------- 渲染：持仓 ----------
function render() {
  if (Object.keys(PRICES).length) { try { materializePlans(); } catch (e) { console.error(e); } }
  SERIES = replay();
  const rows = SERIES;
  const last = rows.length ? rows[rows.length - 1] : { value: 0, mv: 0, cash: 0, date: "-", cf: 0 };
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const invested = S.flows.reduce((a, f) => a + Number(f.amount), 0);
  const totalPnl = last.value - invested;
  const dayPnl = prev ? last.value - prev.value - (last.cf || 0) : 0;

  $("#kpiValue").textContent = money(last.value);
  $("#kpiPnl").textContent = (totalPnl >= 0 ? "+" : "") + fmt(totalPnl, 2);
  $("#kpiPnl").className = "v " + (totalPnl >= 0 ? "up" : "down");
  $("#kpiDay").textContent = (dayPnl >= 0 ? "+" : "") + fmt(dayPnl, 2);
  $("#kpiDay").className = "v " + (dayPnl >= 0 ? "up" : "down");
  $("#kpiInvest").textContent = money(invested);
  $("#asof").textContent = last.date;

  renderHoldings();
  renderCombo();
  renderAttribution();
  renderTrades();
  renderFlows();
  renderPlans();
  renderStrategy();
  renderGroups();
  renderAnalyze();
}

function legOf(code) {
  if (S.legs[code]) return S.legs[code];
  if (code === S.settings.divCode || code === S.settings.bondCode) return (S.groups[0] || {}).id || "rot";
  return SAT;
}

const SAT = "sat";

function ensureGroups() {
  if (!S.groups || !S.groups.length) {
    const tg = (S.settings && S.settings.targets) ? S.settings.targets : { rot: 50, spy: 25, ndx: 25 };
    S.groups = [
      { id: "rot", name: "股债轮动", target: Number(tg.rot) || 50 },
      { id: "spy", name: "标普500", target: Number(tg.spy) || 25 },
      { id: "ndx", name: "纳指", target: Number(tg.ndx) || 25 }
    ];
  }
  Object.keys(S.legs || {}).forEach((k) => { if (S.legs[k] === "other") S.legs[k] = SAT; });
}

function groupList() {
  return (S.groups || []).concat([{ id: SAT, name: "自选（不参与）", target: 0, sat: true }]);
}

function groupName(id) {
  const g = groupList().find((x) => x.id === id);
  return g ? g.name : id;
}

function groupOptions(sel) {
  return groupList().map((g) => "<option value='" + g.id + "'" + (g.id === sel ? " selected" : "") + ">" + g.name + "</option>").join("");
}

// ---------- 组合选择 & 组合统计 ----------
const LS_PICK = "pf_pick_v1";

function pnlCls(x) { return x >= 0 ? "up" : "down"; }

function rateText(rate) {
  if (rate === null || rate === undefined || !isFinite(rate)) return "-";
  return (rate >= 0 ? "+" : "") + pct(rate);
}

// 一组持仓的汇总：市值 / 成本 / 浮动盈亏 / 收益率（缺现价的标的不计入）
function statOf(hs) {
  let mv = 0, cost = 0, miss = 0;
  hs.forEach((h) => {
    const p = lastPrice(h.code);
    if (!p) { miss++; return; }
    mv += p * h.shares;
    cost += h.cost;
  });
  const pnl = mv - cost;
  return { mv: mv, cost: cost, pnl: pnl, rate: cost > 0 ? pnl / cost : null, miss: miss, n: hs.length };
}

// 选中的标的集合（记在本机，默认选中全部分组里的策略标的）
function pickStore() {
  if (!window.PICK) {
    let codes = null;
    try {
      const raw = localStorage.getItem(LS_PICK);
      if (raw !== null) codes = JSON.parse(raw);
    } catch (e) { codes = null; }
    if (!Array.isArray(codes)) codes = holdings().filter((h) => legOf(h.code) !== SAT).map((h) => h.code);
    const map = {};
    codes.forEach((c) => { map[c] = 1; });
    window.PICK = { codes: map };
  }
  return window.PICK;
}

function pickSave() {
  try { localStorage.setItem(LS_PICK, JSON.stringify(Object.keys(pickStore().codes))); } catch (e) { /* ignore */ }
}

function pickHas(code) { return !!pickStore().codes[code]; }

function pickToggle(code, on) {
  const P = pickStore();
  if (on) P.codes[code] = 1; else delete P.codes[code];
}

// 清掉已不再持有的代码（卖出/清空数据后自动失效）
function pickClean() {
  const codes = holdings().map((h) => h.code);
  const P = pickStore();
  let dirty = false;
  Object.keys(P.codes).forEach((c) => { if (codes.indexOf(c) < 0) { delete P.codes[c]; dirty = true; } });
  if (dirty) pickSave();
}

function pickCodes() {
  pickClean();
  const map = pickStore().codes;
  return holdings().map((h) => h.code).filter((c) => map[c]);
}

function pickSet(codes) {
  const P = pickStore();
  P.codes = {};
  codes.forEach((c) => { P.codes[c] = 1; });
  pickSave();
}

// 持仓表头的「全选」状态跟着当前筛选结果走
function syncHoldChecks() {
  const box = $("#holdAll");
  if (!box) return;
  const list = Array.from(document.querySelectorAll("#holdBody .hsel"));
  const on = list.filter((c) => c.checked).length;
  box.checked = list.length > 0 && on === list.length;
  box.indeterminate = on > 0 && on < list.length;
}

function renderCombo() {
  const chips = $("#comboChips"), tb = $("#comboBody"), note = $("#comboSel");
  if (!chips || !tb) return;
  const hs = holdings();
  const sel = hs.filter((h) => pickHas(h.code));
  const gl = groupList();

  // 分组按钮：再点一次整组移出；「策略/全部/清空」是整体替换
  let chipHtml = "<button class='chip add' data-pick='strat'>策略</button>" +
    "<button class='chip add' data-pick='all'>全部</button>" +
    "<button class='chip add' data-pick='none'>清空</button>";
  gl.forEach((g) => {
    const mine = hs.filter((h) => legOf(h.code) === g.id);
    if (!mine.length) return;
    const on = mine.every((h) => pickHas(h.code));
    chipHtml += "<button class='chip" + (on ? " on" : "") + "' data-pickgrp='" + g.id + "'>" +
      g.name + " <span>" + mine.length + "</span></button>";
  });
  chips.innerHTML = chipHtml;

  chips.onclick = (e) => {
    const b = e.target.closest ? e.target.closest("button") : e.target;
    if (!b) return;
    const k = b.getAttribute("data-pick"), gid = b.getAttribute("data-pickgrp");
    if (k === "all") pickSet(hs.map((h) => h.code));
    else if (k === "strat") pickSet(hs.filter((h) => legOf(h.code) !== SAT).map((h) => h.code));
    else if (k === "none") pickSet([]);
    else if (gid) {
      const mine = hs.filter((h) => legOf(h.code) === gid);
      const on = !mine.every((h) => pickHas(h.code));
      mine.forEach((h) => pickToggle(h.code, on));
      pickSave();
    }
    renderHoldings();
    renderCombo();
  };

  const tot = statOf(sel);
  const rows = [];
  gl.forEach((g) => {
    const mine = sel.filter((h) => legOf(h.code) === g.id);
    if (!mine.length) return;
    const s = statOf(mine);
    const allN = hs.filter((h) => legOf(h.code) === g.id).length;
    rows.push("<tr><td class='l'>" + g.name +
      (mine.length < allN ? " <span class='muted'>" + mine.length + "/" + allN + " 只</span>" : "") + "</td>" +
      "<td>" + money(s.mv) + "</td><td class='hide-s'>" + money(s.cost) + "</td>" +
      "<td class='" + pnlCls(s.pnl) + "'>" + fmtPnl(s.pnl) + "</td>" +
      "<td class='" + pnlCls(s.pnl) + "'><b>" + rateText(s.rate) + "</b></td>" +
      "<td class='hide-s'>" + (tot.mv ? pct(s.mv / tot.mv) : "-") + "</td></tr>");
  });
  if (rows.length > 1) {
    rows.push("<tr class='sumrow'><td class='l'>合计 " + sel.length + " 只</td>" +
      "<td>" + money(tot.mv) + "</td><td class='hide-s'>" + money(tot.cost) + "</td>" +
      "<td class='" + pnlCls(tot.pnl) + "'>" + fmtPnl(tot.pnl) + "</td>" +
      "<td class='" + pnlCls(tot.pnl) + "'><b>" + rateText(tot.rate) + "</b></td>" +
      "<td class='hide-s'>" + (tot.mv ? "100.00%" : "-") + "</td></tr>");
  }
  tb.innerHTML = rows.length ? rows.join("")
    : "<tr><td colspan='6' class='muted'>点上面的分组，或在持仓表里勾选标的</td></tr>";

  if (note) {
    note.textContent = sel.length
      ? "已选 " + sel.length + " 只 · 盈亏 " + fmtPnl(tot.pnl) + "（" + rateText(tot.rate) + "）" +
        (tot.miss ? " · " + tot.miss + " 只缺现价" : "")
      : "未选择";
  }
}

function marketOf(code) {
  const ts = S.trades.filter((x) => x.code === code);
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i].market) return ts[i].market;
  return "";
}

// 老数据没有类型字段时，按代码先估一次（只跑一次，之后以用户选择为准）
function migrateMarket() {
  let n = 0;
  S.trades.forEach((x) => {
    if (!x.market) { x.market = /^(5|15|16|11|12)/.test(String(x.code)) ? "场内" : "场外"; n++; }
  });
  (S.plans || []).forEach((pl) => {
    if (!pl.market) { pl.market = "场外"; n++; }
  });
  if (n) saveLocal();
  return n;
}

function accountOf(code) {
  const ts = S.trades.filter((x) => x.code === code);
  const last = ts[ts.length - 1];
  if (!last) return "";
  const acc = (S.accounts || []).find((a) => a.id === last.account);
  return acc ? acc.name : (last.account || "");
}

function renderHoldings() {
  const all = holdings();
  const satList = all.filter((h) => legOf(h.code) === SAT);
  const hs = all.filter((h) => legOf(h.code) !== SAT);
  renderSatellite(satList);
  const tb = $("#holdBody");
  if (!tb) return;
  if (!window.HOLD_FILTER) window.HOLD_FILTER = { type: "", account: "", leg: "" };
  const F = window.HOLD_FILTER;

  // 下拉选项
  const accSel = $("#holdAccount"), legSel = $("#holdLeg"), typeSel = $("#holdType");
  if (accSel) {
    const accs = [];
    hs.forEach((h) => { const a = accountOf(h.code); if (a && accs.indexOf(a) < 0) accs.push(a); });
    accSel.innerHTML = "<option value=''>全部账户</option>" + accs.map((a) => "<option value='" + a + "'>" + a + "</option>").join("");
    accSel.value = accs.indexOf(F.account) >= 0 ? F.account : "";
    F.account = accSel.value;
  }
  if (legSel) {
    const legs = [];
    hs.forEach((h) => { const l = legOf(h.code); if (legs.indexOf(l) < 0) legs.push(l); });
    legSel.innerHTML = "<option value=''>全部分组</option>" + legs.map((l) => "<option value='" + l + "'>" + groupName(l) + "</option>").join("");
    legSel.value = legs.indexOf(F.leg) >= 0 ? F.leg : "";
    F.leg = legSel.value;
  }
  if (typeSel) typeSel.value = F.type;

  const list = hs.filter((h) => {
    if (F.type && (marketOf(h.code) || "未分类") !== F.type) return false;
    if (F.account && accountOf(h.code) !== F.account) return false;
    if (F.leg && legOf(h.code) !== F.leg) return false;
    return true;
  });

  let total = 0;
  list.forEach((h) => { const p = lastPrice(h.code); if (p) total += p * h.shares; });

  tb.innerHTML = "";
  list.forEach((h) => {
    const px = lastPrice(h.code);
    const mv = px ? px * h.shares : 0;
    const pnl = px ? mv - h.cost : null;
    const rate = pnl !== null && h.cost > 0 ? pnl / h.cost : null;
    const leg = legOf(h.code);
    const mk = marketOf(h.code);
    const tr = document.createElement("tr");
    tr.innerHTML = "<td><input type='checkbox' class='hsel' data-code='" + h.code + "'" + (pickHas(h.code) ? " checked" : "") + "></td>" +
      "<td class='hide-xs'>" + h.code + "</td><td class='l'>" + h.name +
      " <select class='mksel' data-code='" + h.code + "' style='width:auto;padding:1px 4px;font-size:11px;display:inline-block'>" +
      ["场内", "场外"].map((k) => "<option value='" + k + "'" + (k === mk ? " selected" : "") + ">" + k + "</option>").join("") +
      "</select>" +
      "<div class='sub-m'>" + h.code + " · 市值 " + (px ? money(mv) : "-") + " · 份额 " + fmt(h.shares, 2) + "</div></td>" +
      "<td class='l hide-s'><select class='legsel' data-code='" + h.code + "'>" +
      groupOptions(leg) +
      "</select></td>" +
      "<td class='hide-xs'>" + fmt(h.shares, 2) + "</td><td class='hide-s'>" + fmt(h.shares ? h.cost / h.shares : 0, 4) + "</td>" +
      "<td class='hide-xs'>" + (px ? fmt(px, 4) : "-") + "</td><td class='hide-xs'>" + (px ? fmt(mv, 2) : "-") + "</td>" +
      "<td class='" + (pnl === null ? "" : pnlCls(pnl)) + "'>" + (pnl !== null ? fmtPnl(pnl) : "-") + "</td>" +
      "<td class='" + (rate === null ? "" : pnlCls(rate)) + "'><b>" + rateText(rate) + "</b></td>" +
      "<td class='hide-s'>" + (mv && total ? pct(mv / total) : "-") + "</td>";
    tb.appendChild(tr);
  });
  if (!list.length) {
    tb.innerHTML = "<tr><td colspan='11' class='muted'>" + (hs.length ? "没有符合筛选的持仓" : "还没有策略持仓，去「交易」里记一笔") + "</td></tr>";
  } else {
    // 合计行：当前筛选结果的整体市值 / 盈亏 / 收益率
    const s = statOf(list);
    const tr = document.createElement("tr");
    tr.className = "sumrow";
    tr.innerHTML = "<td></td><td class='hide-xs'></td>" +
      "<td class='l'>合计 " + list.length + " 只" + (s.miss ? " · " + s.miss + " 只缺现价" : "") +
      "<div class='sub-m'>市值 " + money(s.mv) + " · 成本 " + money(s.cost) + "</div></td>" +
      "<td class='hide-s'></td><td class='hide-xs'></td>" +
      "<td class='hide-s'></td><td class='hide-xs'></td><td class='hide-xs'>" + money(s.mv) + "</td>" +
      "<td class='" + pnlCls(s.pnl) + "'>" + fmtPnl(s.pnl) + "</td>" +
      "<td class='" + pnlCls(s.pnl) + "'><b>" + rateText(s.rate) + "</b></td>" +
      "<td class='hide-s'>" + (s.mv ? "100.00%" : "-") + "</td>";
    tb.appendChild(tr);
  }

  const allBox = $("#holdAll");
  if (allBox) {
    const picked = list.filter((h) => pickHas(h.code)).length;
    allBox.checked = list.length > 0 && picked === list.length;
    allBox.indeterminate = picked > 0 && picked < list.length;
    allBox.onchange = () => {
      const on = allBox.checked;
      list.forEach((h) => pickToggle(h.code, on));
      pickSave();
      tb.querySelectorAll(".hsel").forEach((c) => { c.checked = on; });
      syncHoldChecks();
      renderCombo();
    };
  }

  tb.onchange = (e) => {
    const sel = e.target;
    if (sel.classList.contains("hsel")) {
      pickToggle(sel.getAttribute("data-code"), sel.checked);
      pickSave();
      syncHoldChecks();
      renderCombo();
      return;
    }
    if (sel.classList.contains("mksel")) {
      const mcode = sel.getAttribute("data-code");
      let hit = false;
      S.trades.forEach((x) => { if (x.code === mcode) { x.market = sel.value; hit = true; } });
      if (hit) { saveLocal(); renderHoldings(); }
      return;
    }
    if (sel.classList.contains("legsel")) {
      S.legs[sel.getAttribute("data-code")] = sel.value;
      saveLocal(); renderStrategy();
    }
  };
  if (typeSel) typeSel.onchange = () => { F.type = typeSel.value; renderHoldings(); };
  if (accSel) accSel.onchange = () => { F.account = accSel.value; renderHoldings(); };
  if (legSel) legSel.onchange = () => { F.leg = legSel.value; renderHoldings(); };

  const lastRow = SERIES && SERIES.length ? SERIES[SERIES.length - 1] : null;
  $("#cashNote").textContent = "现金 " + money(lastRow ? lastRow.cash : 0) +
    (list.length !== hs.length ? " · 显示 " + list.length + "/" + hs.length : "");
}

function renderSatellite(list) {
  const card = $("#satCard"), tb = $("#satBody");
  if (!card || !tb) return;
  if (!list.length) { card.style.display = "none"; return; }
  card.style.display = "";
  tb.innerHTML = "";
  let mvSum = 0, costSum = 0, pnlSum = 0, miss = 0;
  list.forEach((h) => {
    const px = lastPrice(h.code);
    const mv = px ? px * h.shares : 0;
    const pnl = px ? mv - h.cost : null;
    const rate = pnl !== null && h.cost > 0 ? pnl / h.cost : null;
    if (px) { mvSum += mv; costSum += h.cost; pnlSum += pnl; } else miss++;
    const tr = document.createElement("tr");
    tr.innerHTML = "<td><input type='checkbox' class='hsel' data-code='" + h.code + "'" + (pickHas(h.code) ? " checked" : "") + "></td>" +
      "<td class='hide-xs'>" + h.code + "</td><td class='l'>" + h.name +
      "<div class='sub-m'>" + h.code + " · 市值 " + (px ? money(mv) : "-") + " · 份额 " + fmt(h.shares, 2) + "</div></td>" +
      "<td class='l'><select class='satleg' data-code='" + h.code + "'>" + groupOptions(SAT) + "</select></td>" +
      "<td class='hide-xs'>" + fmt(h.shares, 2) + "</td><td class='hide-s'>" + fmt(h.shares ? h.cost / h.shares : 0, 4) + "</td>" +
      "<td class='hide-xs'>" + (px ? fmt(px, 4) : "-") + "</td><td class='hide-xs'>" + (px ? fmt(mv, 2) : "-") + "</td>" +
      "<td class='" + (pnl === null ? "" : pnlCls(pnl)) + "'>" + (pnl !== null ? fmtPnl(pnl) : "-") + "</td>" +
      "<td class='" + (rate === null ? "" : pnlCls(rate)) + "'><b>" + rateText(rate) + "</b></td>";
    tb.appendChild(tr);
  });
  $("#satSum").textContent = "成本 " + money(costSum) + " · 市值 " + money(mvSum) +
    " · 盈亏 " + fmtPnl(pnlSum) + "（" + rateText(costSum ? pnlSum / costSum : null) + "）" +
    (miss ? " · " + miss + " 只缺现价" : "");
  tb.onchange = (e) => {
    const sel = e.target;
    if (!sel.classList) return;
    if (sel.classList.contains("hsel")) {
      pickToggle(sel.getAttribute("data-code"), sel.checked);
      pickSave(); syncHoldChecks(); renderCombo();
      return;
    }
    if (!sel.classList.contains("satleg")) return;
    const code = sel.getAttribute("data-code");
    S.legs[code] = sel.value;
    saveLocal(); render();
  };
}

function renderAttribution() {
  const tb = $("#attrBody");
  tb.innerHTML = "";
  const rows = attribution();
  const total = rows.reduce((a, r) => a + Math.abs(r.total), 0);
  rows.forEach((r) => {
    const cls = r.total >= 0 ? "up" : "down";
    const tr = document.createElement("tr");
    tr.innerHTML = "<td class='l'>" + r.name + " <span class='muted'>" + r.code + "</span>" +
      "<div class='sub-m'>已实现 " + fmtPnl(r.realized) + " · 浮动 " + fmtPnl(r.unrealized) + "</div></td>" +
      "<td class='hide-xs " + (r.realized >= 0 ? "up" : "down") + "'>" + fmtPnl(r.realized) + "</td>" +
      "<td class='hide-xs " + (r.unrealized >= 0 ? "up" : "down") + "'>" + fmtPnl(r.unrealized) + "</td>" +
      "<td class='" + cls + "'><b>" + fmtPnl(r.total) + "</b></td>" +
      "<td class='" + (r.rate === null ? "" : pnlCls(r.rate)) + "'><b>" + rateText(r.rate) + "</b></td>" +
      "<td class='hide-s'>" + (total ? pct(r.total / Math.abs(total)) : "-") + "</td>";
    tb.appendChild(tr);
  });
  if (!rows.length) tb.innerHTML = "<tr><td colspan='6' class='muted'>暂无数据</td></tr>";
}

// ---------- 渲染：交易 ----------
function renderTrades() {
  const tb = $("#tradeBody");
  const fsel = $("#tradeFilter");
  if (!tb) return;
  if (!window.TRADE_FILTER) window.TRADE_FILTER = { code: "", kind: "" };
  const F = window.TRADE_FILTER;

  // 填充筛选下拉（保留选择）
  const codes = [];
  S.trades.forEach((x) => { if (codes.indexOf(x.code) < 0) codes.push(x.code); });
  const cur = F.code;
  fsel.innerHTML = "<option value=''>全部标的</option>" +
    codes.map((c) => {
      const nm = (S.trades.find((x) => x.code === c) || {}).name || c;
      return "<option value='" + c + "'>" + nm + " (" + c + ")</option>";
    }).join("");
  fsel.value = codes.indexOf(cur) >= 0 ? cur : "";
  F.code = fsel.value;
  $("#tradeKind").value = F.kind;

  const list = S.trades
    .filter((x) => !F.code || x.code === F.code)
    .filter((x) => !F.kind || (F.kind === "auto" ? !!x.auto : !x.auto))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  tb.innerHTML = "";
  list.forEach((t) => {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td><input type='checkbox' class='tsel' data-id='" + t.id + "'></td>" +
      "<td>" + t.date + "</td><td class='hide-s'>" + (t.accountName || t.account || "") + "</td>" +
      "<td>" + t.code + "</td><td class='l'>" + (t.name || "") + (t.auto ? " <span class='muted'>定投</span>" : "") + "</td>" +
      "<td class='" + (t.side === "buy" ? "up" : "down") + "'>" + (t.side === "buy" ? "买入" : "卖出") + "</td>" +
      "<td>" + fmt(t.shares, 2) + "</td><td>" + fmt(t.price, 4) + "</td>" +
      "<td class='hide-s'>" + fmt(t.fee || 0, 2) + "</td><td><button class='mini' data-del='" + t.id + "'>删</button></td>";
    tb.appendChild(tr);
  });
  if (!list.length) tb.innerHTML = "<tr><td colspan='10' class='muted'>没有符合条件的记录</td></tr>";
  const cnt = $("#tradeCount");
  if (cnt) cnt.textContent = list.length + " / " + S.trades.length + " 条";

  const all = $("#tradeAll");
  if (all) { all.checked = false; }
  tb.onclick = (e) => {
    const id = e.target.getAttribute && e.target.getAttribute("data-del");
    if (!id) return;
    if (!confirm("删除这条记录？")) return;
    delTrades([id]);
  };
  fsel.onchange = () => { F.code = fsel.value; renderTrades(); };
  $("#tradeKind").onchange = () => { F.kind = $("#tradeKind").value; renderTrades(); };
  if (all) all.onclick = () => {
    tb.querySelectorAll(".tsel").forEach((c) => { c.checked = all.checked; });
  };
}

function delTrades(ids) {
  ids.forEach((id) => {
    const t = S.trades.find((x) => x.id === id);
    if (t && t.planId) {
      S.planSkip[t.planId] = S.planSkip[t.planId] || [];
      S.planSkip[t.planId].push(t.date);
    }
  });
  S.trades = S.trades.filter((x) => ids.indexOf(x.id) < 0);
  saveLocal(); render();
}

// ---------- 渲染：策略 ----------
// ---------- 定投计划 ----------
function periodAmount(plan) {
  return Number(plan.per) || 0;
}

function perDiv(freq) {
  return freq === "daily" ? 21 : freq === "weekly" ? 4 : 1;
}

function execDates(plan, arr) {
  if (!arr.length) return [];
  if (plan.freq === "daily") return arr.slice();
  if (plan.freq === "monthly") {
    const d0 = Number(plan.day) || 1;
    const hit = arr.find((d) => Number(d.slice(8, 10)) >= d0);
    return [hit || arr[arr.length - 1]];
  }
  const wd = Math.min(5, Math.max(1, Number(plan.day) || 1));
  const groups = [];
  const first = new Date(arr[0] + "T00:00:00");
  const offset = ((first.getDay() === 0 ? 7 : first.getDay()) - 1);
  arr.forEach((d) => {
    const dd = Number(d.slice(8, 10));
    const idx = Math.floor((dd - 1 + offset) / 7);
    if (!groups[idx]) groups[idx] = [];
    groups[idx].push(d);
  });
  return groups.filter(Boolean).map((g) => {
    const hit = g.find((d) => { const w = new Date(d + "T00:00:00").getDay(); return (w === 0 ? 7 : w) >= wd; });
    return hit || g[g.length - 1];
  });
}

function materializePlans() {
  if (!S.plans || !S.plans.length) return 0;
  const todayStr = today();
  let added = 0;
  S.plans.forEach((plan) => {
    if (plan.enabled === false) return;
    const series = PRICES[plan.code];
    if (!series || !series.length) return;
    const skip = S.planSkip[plan.id] || [];
    const acc = (S.accounts[0] || {}).id || "A";
    const amt = periodAmount(plan);
    const byMonth = {};
    series.forEach((p) => {
      if (p.date < (plan.start || "2000-01-01") || p.date > todayStr) return;
      const m = p.date.slice(0, 7);
      (byMonth[m] = byMonth[m] || []).push(p.date);
    });
    Object.keys(byMonth).sort().forEach((m) => {
      const ex = execDates(plan, byMonth[m]);
      ex.forEach((d) => {
        if (skip.indexOf(d) >= 0) return;
        if (S.trades.some((t) => t.planId === plan.id && t.date === d)) return;
        const e = priceOn(plan.code, d);
        if (!e || !e.px) return;
        const shares = Number((amt / e.px).toFixed(4));
        S.flows.push({ id: uid(), date: d, account: acc, amount: Number(amt.toFixed(2)), note: "定投扣款 " + plan.code });
        S.trades.push({
          id: uid(), date: d, account: acc, code: plan.code, name: plan.name || plan.code,
          side: "buy", shares: shares, price: Number(e.px.toFixed(6)), fee: 0, auto: true, planId: plan.id, market: plan.market || "场外"
        });
        added++;
      });
    });
  });
  if (added) saveLocal();
  return added;
}

function manualNAV() {
  const code = prompt("代码", (S.plans[0] || {}).code || (S.trades[0] || {}).code || "");
  if (!code) return;
  const d = prompt("净值日期（YYYY-MM-DD）", today());
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return alert("日期格式不对");
  const v = prompt("单位净值（基金 App 上的那个数）", "");
  const px = Number(v);
  if (!px) return alert("净值不对");
  const arr = S.priceCache[code] = (S.priceCache[code] || []).filter((x) => x.date !== d);
  const last = arr.filter((x) => x.date < d).slice(-1)[0] || arr[arr.length - 1];
  arr.push({ date: d, px: px, tr: last && last.px ? last.tr * (px / last.px) : 1 });
  arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  PRICES[code] = arr;
  const n = materializePlans();
  saveLocal(); render();
  alert("已补 " + d + " 净值 " + px + (n ? "，生成 " + n + " 笔定投" : ""));
}

function renderPlans() {
  const tb = $("#planBody");
  if (!tb) return;
  tb.innerHTML = "";
  (S.plans || []).forEach((plan) => {
    const arr0 = PRICES[plan.code];
    const lastNav = arr0 && arr0.length ? arr0[arr0.length - 1].date : null;
    let why = "0 笔";
    if (!arr0 || !arr0.length) why = "<span class='dev warn'>净值未加载</span>";
    else if (!periodAmount(plan)) why = "<span class='dev warn'>每次金额为 0</span>";
    else if (plan.start && lastNav && plan.start > lastNav) why = "<span class='dev' style='color:#8a94a6'>待净值（最新 " + lastNav.slice(5) + "）</span>";
    else why = "0 笔（待补）";
    const doneT = S.trades.filter((t) => t.planId === plan.id);
    const done = doneT.length;
    const lastDone = done ? doneT.map((x) => x.date).sort().slice(-1)[0] : null;
    const tr = document.createElement("tr");
    const pname = (plan.name && plan.name !== plan.code) ? plan.name : (NAME_CACHE[plan.code] || plan.code);
    tr.innerHTML = "<td class='l'>" + pname + " <span class='muted'>" + plan.code + "</span></td>" +
      "<td>" + (plan.freq === "daily" ? "每日" : plan.freq === "weekly" ? "每周" : "每月") + "</td>" +
      "<td><b>" + money(periodAmount(plan)) + "</b></td>" +
      "<td>" + money(periodAmount(plan) * perDiv(plan.freq)) + "</td>" +
      "<td>" + (done ? done + " 笔 <span class='muted'>至 " + lastDone.slice(5) + "</span>" : why) + "</td>" +
      "<td><button class='mini' data-delplan='" + plan.id + "'>删</button></td>";
    tb.appendChild(tr);
  });
  if (!(S.plans || []).length) tb.innerHTML = "<tr><td colspan='6' class='muted'>还没有定投计划</td></tr>";
  const sum = (S.plans || []).reduce((a, p) => a + periodAmount(p) * perDiv(p.freq), 0);
  const el = $("#planSum");
  if (el) el.textContent = "每月合计 " + money(sum);
  const note = $("#planNote");
  if (note) {
    let lastNav = null;
    (S.plans || []).forEach((pl) => {
      const arr = PRICES[pl.code];
      if (arr && arr.length) {
        const d = arr[arr.length - 1].date;
        if (!lastNav || d > lastNav) lastNav = d;
      }
    });
    note.textContent = lastNav
      ? "净值最新到 " + lastNav + "（场外 T+1 公布），之后的交易日会在净值出来后自动补。"
      : "生成的记录会写进「交易记录」，带「定投」标记，可单独删除（删了不会再生成）。";
  }
  tb.onclick = (e) => {
    const id = e.target.getAttribute && e.target.getAttribute("data-delplan");
    if (!id) return;
    if (!confirm("删除这条计划？已生成的交易记录会保留")) return;
    S.plans = S.plans.filter((p) => p.id !== id);
    saveLocal(); render();
  };
}

function renderFlows() {
  const tb = $("#flowBody");
  if (!tb) return;
  tb.innerHTML = "";
  const fs = S.flows.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  fs.forEach((f) => {
    const amt = Number(f.amount);
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + f.date + "</td><td class='l'>" + (f.account || "") + "</td>" +
      "<td class='" + (amt >= 0 ? "down" : "up") + "'>" + (amt >= 0 ? "+" : "") + fmt(amt, 2) + "</td>" +
      "<td class='l'>" + (f.note || "") + "</td>" +
      "<td><button class='mini' data-delflow='" + f.id + "'>删</button></td>";
    tb.appendChild(tr);
  });
  if (!fs.length) tb.innerHTML = "<tr><td colspan='5' class='muted'>还没有入金记录</td></tr>";
  const sum = fs.reduce((a, f) => a + Number(f.amount), 0);
  const el = $("#flowSum");
  if (el) el.textContent = "净投入 " + money(sum);
  tb.onclick = (e) => {
    const id = e.target.getAttribute && e.target.getAttribute("data-delflow");
    if (!id) return;
    if (!confirm("删除这条资金记录？")) return;
    S.flows = S.flows.filter((x) => x.id !== id);
    saveLocal(); render();
  };
}

function renderGroups() {
  const tb = $("#grpBody");
  if (!tb) return;
  tb.innerHTML = "";
  (S.groups || []).forEach((g) => {
    const tr = document.createElement("tr");
    tr.setAttribute("data-id", g.id);
    tr.innerHTML = "<td class='l'><input class='gname' value='" + (g.name || "") + "' style='width:100%'></td>" +
      "<td><input class='gtarget' type='number' min='0' step='1' value='" + (Number(g.target) || 0) + "' style='width:80px;text-align:right'></td>" +
      "<td><button class='mini' data-delgrp='" + g.id + "'>删</button></td>";
    tb.appendChild(tr);
  });
  if (!(S.groups || []).length) tb.innerHTML = "<tr><td colspan='3' class='muted'>还没有分组</td></tr>";
  const sum = (S.groups || []).reduce((a, g) => a + Number(g.target || 0), 0);
  const el = $("#grpSum");
  if (el) el.textContent = "目标合计 " + sum + "%";
  tb.onclick = (e) => {
    const id = e.target.getAttribute && e.target.getAttribute("data-delgrp");
    if (!id) return;
    if (!confirm("删除该分组？已归到它的持仓会变成「自选」")) return;
    S.groups = S.groups.filter((g) => g.id !== id);
    Object.keys(S.legs).forEach((k) => { if (S.legs[k] === id) S.legs[k] = SAT; });
    saveLocal(); render(); renderGroups();
  };
}

function renderStrategy() {
  const sig = SIGNAL;
  const card = $("#sigErp");
  if (!sig || !sig.erp) {
    card.textContent = "-";
    $("#sigTag").textContent = "无信号";
    $("#sigRec").textContent = "点「刷新信号数据」或「手动填 PE」";
  } else {
    const b = bucketOf(sig.erp);
    card.textContent = sig.erp.toFixed(2) + "%";
    card.style.color = sig.erp > 6 ? "#d9480f" : sig.erp > 4 ? "#2f6fed" : "#0ca678";
    const tag = $("#sigTag");
    tag.textContent = b.tag + " · 权益 " + b.eq + "%";
    tag.className = "tag " + b.cls;
    $("#sigDate").textContent = (sig.date || "") + " 更新";
    $("#sigBar").innerHTML = "<i style='width:" + b.eq + "%;background:" + (b.eq >= 70 ? "#e03131" : b.eq > 0 ? "#f08c00" : "#2f9e44") + "'></i>";
    $("#sigPct").textContent = "红利 " + b.eq + "%";
    $("#sigBond").textContent = "国债 " + (100 - b.eq) + "%";
    $("#sigBasis").textContent = "沪深300 PE " + fmt(sig.pe, 2) + " · 10Y国债 " + (sig.y10 ? fmt(sig.y10, 3) + "%" : "-") + " · " + (sig.src || "");
    const total = stratBase();
    $("#sigRec").textContent = "本月建议：" + b.desc + "（按策略金额 " + money(total) + "，红利约 " + money(total * b.eq / 100) + "，国债约 " + money(total * (100 - b.eq) / 100) + "）";
  }
  renderRebalance();
  renderRotInternal();
}

function stratBase() {
  let satMv = 0;
  holdings().forEach((h) => {
    if (legOf(h.code) !== SAT) return;
    const p = lastPrice(h.code);
    if (p) satMv += p * h.shares;
  });
  return Math.max(0, lastTotal() - satMv);
}

function lastTotal() {
  if (!SERIES || !SERIES.length) return 0;
  return SERIES[SERIES.length - 1].value;
}

function legValues() {
  const out = { rot: 0, spy: 0, ndx: 0, other: 0 };
  holdings().forEach((h) => {
    const p = lastPrice(h.code);
    const v = p ? p * h.shares : 0;
    out[legOf(h.code)] += v;
  });
  return out;
}

function renderRebalance() {
  const lv = {};
  let satMv = 0, totalMv = 0;
  holdings().forEach((h) => {
    const p = lastPrice(h.code);
    const v = p ? p * h.shares : 0;
    const g = legOf(h.code);
    lv[g] = (lv[g] || 0) + v;
    totalMv += v;
    if (g === SAT) satMv += v;
  });
  const total = lastTotal();
  const cash = total - totalMv;
  const base = total - satMv;
  const gs = S.groups || [];
  const tsum = gs.reduce((a, g) => a + Number(g.target || 0), 0) || 1;

  const tb = $("#rbBody");
  tb.innerHTML = "";
  gs.forEach((g) => {
    const tgt = (Number(g.target || 0) / tsum) * 100;
    const act = base ? ((lv[g.id] || 0) / base) * 100 : 0;
    const dev = act - tgt;
    const amt = (tgt / 100) * base - (lv[g.id] || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = "<td class='l'>" + g.name + "</td><td>" + tgt.toFixed(1) + "%</td><td>" + act.toFixed(1) + "%</td>" +
      "<td class='" + (Math.abs(dev) > 5 ? "dev warn" : "dev") + "'>" + (dev >= 0 ? "+" : "") + dev.toFixed(1) + "pp</td>" +
      "<td class='" + (amt >= 0 ? "down" : "up") + "'>" + (Math.abs(amt) < base * 0.005 ? "不动" : (amt > 0 ? "买入 " : "卖出 ") + money(Math.abs(amt))) + "</td>";
    tb.appendChild(tr);
  });
  if (!gs.length) tb.innerHTML = "<tr><td colspan='5' class='muted'>还没有策略分组，去设置里加</td></tr>";
  $("#rbTotal").textContent = "策略金额 " + money(base) + (satMv ? " · 自选 " + money(satMv) : "") + " · 现金 " + money(cash);
}

function renderRotInternal() {
  const tb = $("#rotBody");
  tb.innerHTML = "";
  const div = S.settings.divCode, bond = S.settings.bondCode;
  const hs = holdings();
  const get = (code) => { const h = hs.find((x) => x.code === code); const p = h ? lastPrice(code) : null; return h && p ? p * h.shares : 0; };
  const dv = get(div), bv = get(bond);
  const sum = dv + bv;
  const b = SIGNAL && SIGNAL.erp ? bucketOf(SIGNAL.erp) : null;
  const tgtDiv = b ? b.eq : 50;
  const actDiv = sum ? (dv / sum) * 100 : 0;
  const rows = [[div + " 红利", dv, tgtDiv], [bond + " 国债", bv, 100 - tgtDiv]];
  rows.forEach(([name, v, tgt]) => {
    const act = sum ? (v / sum) * 100 : 0;
    const dev = act - tgt;
    const amt = (tgt / 100) * sum - v;
    const tr = document.createElement("tr");
    tr.innerHTML = "<td class='l'>" + name + "</td><td>" + fmt(v, 2) + "</td><td>" + tgt + "%</td>" +
      "<td class='" + (Math.abs(dev) > 5 ? "dev warn" : "dev") + "'>" + (dev >= 0 ? "+" : "") + dev.toFixed(1) + "pp</td>" +
      "<td class='" + (amt >= 0 ? "down" : "up") + "'>" +
      (Math.abs(amt) < Math.max(1, sum * 0.005) ? "不动" : (amt > 0 ? "买入 " : "卖出 ") + money(Math.abs(amt))) + "</td>";
    tb.appendChild(tr);
  });
  if (!sum) tb.innerHTML = "<tr><td colspan='5' class='muted'>轮动组还没有持仓</td></tr>";
  const note = $("#rotNote");
  if (note) {
    note.textContent = sum
      ? "轮动组共 " + money(sum) + "，目标 红利 " + tgtDiv + "% / 国债 " + (100 - tgtDiv) + "%（由利差信号决定）。"
      : "轮动组 = 红利 ETF + 国债 ETF，目标比例由上面的利差信号决定。";
  }
}

// ---------- 渲染：分析 ----------
function renderAnalyze() {
  const rows = sliceFrom(SERIES || [], RANGE);
  const m = metrics(rows);
  $("#aRet").textContent = m ? pct(m.ret) : "-";
  $("#aRet").className = m && m.ret >= 0 ? "up" : "down";
  $("#aMdd").textContent = m ? pct(m.mdd) : "-";
  $("#aCagr").textContent = m ? pct(m.cagr) : "-";
  $("#aVol").textContent = m ? pct(m.vol) : "-";
  $("#aDays").textContent = m ? m.days + " 天" : "-";
  drawChart(rows);
}

function drawChart(rows) {
  const cv = $("#chart");
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 280;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!rows || rows.length < 2) {
    ctx.fillStyle = "#999"; ctx.font = "14px sans-serif"; ctx.fillText("暂无足够数据", 20, 30); return;
  }
  const padL = 62, padR = 16, padT = 16, padB = 34;
  const cw = W - padL - padR, ch = H - padT - padB;
  const navs = rows.map((r) => r.nav);
  const dds = [];
  let peak = -Infinity;
  for (const v of navs) { peak = Math.max(peak, v); dds.push(v / peak - 1); }
  const minN = Math.min.apply(null, navs), maxN = Math.max.apply(null, navs);
  const pad = (maxN - minN) * 0.12 || 0.05;
  const y0 = minN - pad, y1 = maxN + pad;
  const X = (i) => padL + (cw * i) / (rows.length - 1);
  const Y = (v) => padT + ch - ((v - y0) / (y1 - y0)) * ch;

  ctx.strokeStyle = "#eef1f5"; ctx.lineWidth = 1;
  ctx.fillStyle = "#8a94a6"; ctx.font = "11px -apple-system,sans-serif";
  for (let k = 0; k <= 4; k++) {
    const v = y0 + ((y1 - y0) * k) / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(3), 6, y + 4);
  }
  const mddMin = Math.min.apply(null, dds);
  if (mddMin < 0) {
    ctx.beginPath(); ctx.moveTo(X(0), padT + ch);
    dds.forEach((d, i) => ctx.lineTo(X(i), padT + ch - (-d / -mddMin) * ch * 0.28));
    ctx.lineTo(X(dds.length - 1), padT + ch); ctx.closePath();
    ctx.fillStyle = "rgba(224,49,49,0.10)"; ctx.fill();
  }
  ctx.beginPath();
  navs.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = "#2f6fed"; ctx.lineWidth = 1.8; ctx.stroke();
  ctx.fillStyle = "#8a94a6";
  for (let k = 0; k <= 4; k++) {
    const i = Math.round((rows.length - 1) * k / 4);
    ctx.fillText(rows[i].date.slice(2, 7), X(i) - 14, H - 12);
  }
  ctx.fillStyle = "#2f6fed";
  ctx.beginPath(); ctx.arc(X(navs.length - 1), Y(navs[navs.length - 1]), 3, 0, 7); ctx.fill();
}

// ---------- CSV ----------
function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  for (const line of lines) {
    const cells = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === delim) { cells.push(cur.trim()); cur = ""; }
        else cur += ch;
      }
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

const COLMAP = {
  date: ["日期", "成交日期", "发生日期", "交易日期", "委托日期", "date"],
  code: ["代码", "证券代码", "基金代码", "产品代码", "code"],
  name: ["名称", "证券名称", "基金名称", "产品名称", "name"],
  side: ["方向", "买卖标志", "买卖", "操作", "业务名称", "业务", "摘要", "side"],
  shares: ["数量", "成交数量", "份额", "成交份额", "发生数量", "shares"],
  price: ["价格", "成交价格", "成交均价", "净值", "成交净值", "price"],
  fee: ["费用", "手续费", "佣金", "交易费用", "总费用", "fee"],
  amount: ["金额", "成交金额", "发生金额", "amount"]
};

function pickCol(header, keys) {
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i]).replace(/\s/g, "");
    for (const k of keys) if (h.indexOf(k) >= 0) return i;
  }
  return -1;
}

function parseSide(v) {
  const s = String(v);
  if (/卖|赎回|sell/i.test(s)) return "sell";
  if (/买|申购|buy/i.test(s)) return "buy";
  return "";
}

function normDate(v) {
  const s = String(v).replace(/[^\d]/g, "");
  if (s.length === 8) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
  return String(v).slice(0, 10);
}

function previewCSV(rows) {
  const box = $("#csvPreview");
  if (!rows || !rows.length) { box.innerHTML = "没读出数据，检查文件格式"; return; }
  const head = rows[0];
  const ci = {
    date: pickCol(head, COLMAP.date), code: pickCol(head, COLMAP.code), name: pickCol(head, COLMAP.name),
    side: pickCol(head, COLMAP.side), shares: pickCol(head, COLMAP.shares), price: pickCol(head, COLMAP.price),
    fee: pickCol(head, COLMAP.fee), amount: pickCol(head, COLMAP.amount)
  };
  if (ci.date < 0 || ci.code < 0 || ci.side < 0 || ci.shares < 0) {
    box.innerHTML = "缺少必要列（日期/代码/方向/数量）。可用「下载模板」看格式。";
    return;
  }
  const parsed = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const side = parseSide(r[ci.side]);
    const sh = Number(String(r[ci.shares]).replace(/[,\s]/g, ""));
    let px = ci.price >= 0 ? Number(String(r[ci.price]).replace(/[,\s]/g, "")) : 0;
    const amt = ci.amount >= 0 ? Number(String(r[ci.amount]).replace(/[,\s]/g, "")) : 0;
    if (!px && amt && sh) px = Math.abs(amt) / sh;
    if (!side || !sh || !px) continue;
    parsed.push({
      date: normDate(r[ci.date]), code: String(r[ci.code]).trim(), name: ci.name >= 0 ? String(r[ci.name]).trim() : "",
      side: side, shares: sh, price: px, fee: ci.fee >= 0 ? Number(String(r[ci.fee]).replace(/[,\s]/g, "")) || 0 : 0
    });
  }
  CSV_ROWS = parsed;
  box.innerHTML = "识别到 <b>" + parsed.length + "</b> 条：" + parsed.slice(0, 3).map((p) =>
    p.date + " " + p.code + (p.side === "buy" ? " 买" : " 卖") + " " + p.shares + "@" + p.price).join("；") +
    (parsed.length > 3 ? " …" : "") + "<br>";
  const btn = document.createElement("button");
  btn.textContent = "确认导入 " + parsed.length + " 条";
  btn.style.cssText = "margin-top:8px;padding:9px 14px;border:0;border-radius:9px;background:#2f6fed;color:#fff;font-size:14px";
  btn.onclick = () => {
    parsed.forEach((p) => S.trades.push(Object.assign({ id: uid(), account: (S.accounts[0] || {}).id || "A", market: $("#initMarket").value || "场内" }, p)));
    saveLocal(); CSV_ROWS = null; box.innerHTML = "已导入 " + parsed.length + " 条"; render(); refreshPrices();
  };
  box.appendChild(btn);
}

function readFileSmart(file, cb) {
  const fr = new FileReader();
  fr.onload = () => {
    const buf = fr.result;
    let text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { text = new TextDecoder("gbk").decode(buf); }
    cb(text);
  };
  fr.readAsArrayBuffer(file);
}

function templateCSV() {
  const head = "日期,代码,名称,方向,数量,价格,费用\n";
  const body = "2026-11-20,515080,中证红利ETF,买入,63700,1.568,5\n2026-12-01,040046,华安纳斯达克100,买入,315,4.755,2.25\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + head + body], { type: "text/csv" }));
  a.download = "对账单模板.csv"; a.click();
}

// ---------- 单只添加持仓 ----------
function pvNum(sel) { const v = Number(String($(sel).value).replace(/[,\s]/g, "")); return isFinite(v) ? v : 0; }

function previewPos() {
  const code = $("#pCode").value.trim();
  const sh = pvNum("#pShares");
  const mv = pvNum("#pMv");
  const costRaw = pvNum("#pCost");
  const mkt = $("#pMarket").value;
  const px = code ? lastPrice(code) : null;
  let shares = sh;
  if (!shares && mv && px) shares = mv / px;
  const cost = mkt === "场内" ? costRaw * shares : costRaw;   // 场内填单价，场外填总额
  const parts = [];
  if (code && NAME_CACHE[code] && !$("#pName").value) $("#pName").value = NAME_CACHE[code];
  if (px) parts.push("现价 " + fmt(px, 4));
  else if (code) parts.push("现价待拉取");
  if (shares && cost) {
    const cp = cost / shares;
    parts.push("成本价 " + fmt(cp, 4));
    if (px) {
      const val = shares * px;
      const pnl = val - cost;
      parts.push("市值 " + money(val));
      parts.push("盈亏 " + (pnl >= 0 ? "+" : "") + fmt(pnl, 2) + "（" + pct(pnl / cost) + "）");
    }
  }
  $("#pPreview").textContent = parts.length ? parts.join(" · ") : "填入代码和成本，其余自动算";
}

async function addPosition() {
  const code = $("#pCode").value.trim();
  let shares = pvNum("#pShares");
  const mv = pvNum("#pMv");
  const costRaw = pvNum("#pCost");
  const mkt = $("#pMarket").value;
  if (!code) return alert("填一下代码");
  if (!costRaw) return alert(mkt === "场内" ? "填一下成本价（单股）" : "填一下持仓成本总额");
  if (!shares && mv) {
    const px = lastPrice(code);
    if (!px) return alert("还没拉到现价，请稍等或直接填份额");
    shares = mv / px;
  }
  if (!shares) return alert("填一下份额（或市值）");
  const price = mkt === "场内" ? costRaw : costRaw / shares;
  const cost = price * shares;
  if (!confirm("确认添加 " + code + "\n份额 " + fmt(shares, 2) + "\n成本价 " + fmt(price, 4) + "\n总成本 " + money(cost))) return;
  const acc = (S.accounts[0] || {}).id || "A";
  const date = $("#pDate").value || today();
  const name = $("#pName").value.trim() || NAME_CACHE[code] || code;
  S.flows.push({ id: uid(), date: date, account: acc, amount: Number(cost.toFixed(2)), note: "期初持仓 " + code });
  S.trades.push({ id: uid(), date: date, account: acc, code: code, name: name, side: "buy", shares: Number(shares.toFixed(4)), price: Number(price.toFixed(6)), fee: 0, init: true, market: $("#pMarket").value });
  if (!S.legs[code]) S.legs[code] = "other";
  saveLocal(); render(); refreshPrices();
  $("#pCode").value = ""; $("#pName").value = ""; $("#pShares").value = ""; $("#pMv").value = ""; $("#pCost").value = "";
  $("#pPreview").textContent = "已添加 " + code;
}

// ---------- 导入现有持仓 ----------
function parseInitLines(text, defDate) {
  const out = [];
  text.split(/\r?\n/).forEach((line) => {
    line = line.trim();
    if (!line) return;
    let parts = line.split(/[,\t;\uff0c]+/).map((x) => x.trim()).filter((x) => x !== "");
    if (parts.length < 4) parts = line.split(/\s+/).filter((x) => x !== "");
    if (parts.length < 4) return;
    const code = parts[0];
    const name = parts[1] || code;
    const shares = Number(String(parts[2]).replace(/[,\s]/g, ""));
    const price = Number(String(parts[3]).replace(/[,\s]/g, ""));
    let date = defDate;
    if (parts[4] && /^\d{4}-\d{2}-\d{2}$/.test(parts[4])) date = parts[4];
    if (!code || !isFinite(shares) || !isFinite(price) || !shares || !price) return;
    out.push({ code: code, name: name, shares: shares, price: price, date: date });
  });
  return out;
}

function importInit() {
  const defDate = $("#initDate").value || today();
  const rows = parseInitLines($("#initText").value, defDate);
  if (!rows.length) return alert("没解析到内容。\n格式：代码,名称,份额,成本价,日期");
  const total = rows.reduce((a, r) => a + r.shares * r.price, 0);
  if (!confirm("将导入 " + rows.length + " 只持仓，总成本约 " + money(total) + "，\n并生成等额入金记录。继续？")) return;
  const acc = (S.accounts[0] || {}).id || "A";
  rows.forEach((r) => {
    S.flows.push({ id: uid(), date: r.date, account: acc, amount: Number((r.shares * r.price).toFixed(2)), note: "期初持仓 " + r.code });
    S.trades.push({ id: uid(), date: r.date, account: acc, code: r.code, name: r.name, side: "buy", shares: r.shares, price: r.price, fee: 0, init: true });
    if (!S.legs[r.code]) S.legs[r.code] = "other";
  });
  saveLocal(); render(); refreshPrices();
  $("#initText").value = "";
  $("#initPreview").textContent = "已导入 " + rows.length + " 只";
}

// ---------- 交互 ----------
function accountOptions() {
  return (S.accounts || []).map((a) => "<option value='" + a.id + "'>" + a.name + "</option>").join("");
}

function bindTabs() {
  $$(".tab").forEach((b) => {
    b.onclick = () => {
      $$(".tab").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      $$(".panel").forEach((p) => p.classList.remove("on"));
      const panel = $("#" + b.dataset.p);
      if (panel) panel.classList.add("on");
      if (b.dataset.p === "pAnalyze") renderAnalyze();
      if (b.dataset.p === "pStrategy") { loadSignal().then(renderStrategy); }
    };
  });
}

function bindForms() {
  $("#tDate").value = today();
  $("#fDate").value = today();
  $("#tAccount").innerHTML = accountOptions();
  $("#fAccount").innerHTML = accountOptions();

  $("#tradeForm").onsubmit = (e) => {
    e.preventDefault();
    const t = {
      id: uid(), date: $("#tDate").value, account: $("#tAccount").value,
      code: $("#tCode").value.trim(), name: $("#tName").value.trim() || $("#tCode").value.trim(),
      side: $("#tSide").value, shares: Number($("#tShares").value), price: Number($("#tPrice").value),
      fee: Number($("#tFee").value || 0), leg: $("#tLeg").value, market: $("#tMarket").value
    };
    if (!t.code || !t.shares || !t.price) return alert("代码/份额/价格必填");
    S.legs[t.code] = t.leg;
    S.trades.push(t); saveLocal(); render();
    $("#tShares").value = ""; $("#tPrice").value = ""; $("#tFee").value = "";
    refreshPrices();
  };

  $("#flowForm").onsubmit = (e) => {
    e.preventDefault();
    const f = { id: uid(), date: $("#fDate").value, account: $("#fAccount").value, amount: Number($("#fAmt").value), note: $("#fNote").value };
    if (!f.amount) return alert("金额必填（入金为正，出金为负）");
    S.flows.push(f); saveLocal(); render();
    $("#fAmt").value = "";
  };

  $("#pDate").value = today();
  const syncCostLabel = () => {
    const mkt = $("#pMarket").value;
    $("#pCostLabel").textContent = mkt === "场内" ? "成本价（单股，元）" : "持仓成本（总额，元）";
    $("#pCost").placeholder = mkt === "场内" ? "114.0443" : "99882";
    previewPos();
  };
  $("#pMarket").addEventListener("change", syncCostLabel);
  syncCostLabel();

  ["#pCode", "#pShares", "#pMv", "#pCost"].forEach((sel) => {
    $(sel).addEventListener("input", previewPos);
  });
  $("#pCode").addEventListener("blur", async () => {
    const code = $("#pCode").value.trim();
    if (!code) return;
    if (!PRICES[code]) await loadPrices([code], false);
    previewPos();
  });
  $("#posForm").onsubmit = (e) => { e.preventDefault(); addPosition(); };

  $("#plCode").addEventListener("blur", async () => {
    const code = $("#plCode").value.trim();
    const hint = $("#plNameHint");
    if (!code) { hint.textContent = "输入代码后自动显示基金名称"; return; }
    if (NAME_CACHE[code]) { hint.textContent = "名称：" + NAME_CACHE[code]; return; }
    hint.textContent = "查询中…";
    try { if (!PRICES[code]) await loadPrices([code], false); } catch (e) { /* ignore */ }
    hint.textContent = NAME_CACHE[code] ? "名称：" + NAME_CACHE[code] : "未查到该代码（可能是场内代码或代码有误）";
  });

  $("#plStart").value = today();
  $("#btnPlanSync").onclick = async () => { await refreshPrices(true); };
  $("#btnPlanNav").onclick = manualNAV;
  $("#btnDelSel").onclick = () => {
    const ids = Array.from(document.querySelectorAll(".tsel")).filter((c) => c.checked).map((c) => c.getAttribute("data-id"));
    if (!ids.length) return alert("先勾选要删除的记录");
    if (!confirm("删除选中的 " + ids.length + " 条记录？")) return;
    delTrades(ids);
  };

  $("#planForm").onsubmit = async (e) => {
    e.preventDefault();
    const code = $("#plCode").value.trim();
    const per = Number($("#plPer").value);
    if (!code || !per) return alert("填一下代码和每次金额");
    if (!NAME_CACHE[code]) {
      try { if (!PRICES[code]) await loadPrices([code], false); } catch (e) { /* ignore */ }
    }
    const freq = $("#plFreq").value;
    const plan = {
      id: uid(), code: code, name: NAME_CACHE[code] || code, per: per,
      freq: freq, day: Number($("#plDay").value) || 1,
      start: $("#plStart").value || today(), leg: $("#plLeg").value, market: $("#plMarket").value || "场外", enabled: true
    };
    S.plans.push(plan);
    S.legs[code] = plan.leg;
    saveLocal(); render(); refreshPrices();
    $("#plCode").value = ""; $("#plPer").value = "";
    alert("已创建定投计划，正在按历史净值补生成记录…");
  };
  const planPreview = () => {
    const per = Number($("#plPer").value) || 0;
    const freq = $("#plFreq").value;
    const div = perDiv(freq);
    const unit = freq === "daily" ? "个交易日" : freq === "weekly" ? "周" : "月";
    $("#plPreview").textContent = per
      ? "每次 " + money(per) + " → 每月约 " + money(per * div) + "（按 " + div + " " + unit + "算）"
      : "填每次金额，自动换算每月投入";
  };
  $("#plPer").addEventListener("input", planPreview);
  $("#plFreq").addEventListener("change", planPreview);
  planPreview();

  $("#btnInit").onclick = importInit;
  $("#initDate").value = today();
  $("#initText").addEventListener("input", () => {
    const rows = parseInitLines($("#initText").value, $("#initDate").value || today());
    $("#initPreview").textContent = rows.length
      ? "识别到 " + rows.length + " 只，总成本约 " + money(rows.reduce((a, r) => a + r.shares * r.price, 0))
      : "格式：代码,名称,份额,成本价,日期";
  });

  $("#btnAddGrp").onclick = () => {
    S.groups.push({ id: "g" + Date.now().toString(36), name: "新分组", target: 0 });
    saveLocal(); renderGroups();
  };
  $("#btnSaveGrp").onclick = () => {
    const rows = Array.from(document.querySelectorAll("#grpBody tr[data-id]"));
    S.groups = rows.map((r) => ({
      id: r.getAttribute("data-id"),
      name: r.querySelector(".gname").value.trim() || "未命名",
      target: Number(r.querySelector(".gtarget").value) || 0
    }));
    saveLocal(); render(); renderGroups();
    alert("已保存");
  };
  $("#btnSaveEtf").onclick = () => {
    S.settings.divCode = $("#tgDiv").value.trim() || "515080";
    S.settings.bondCode = $("#tgBond").value.trim() || "511010";
    saveLocal(); renderStrategy();
    alert("已保存");
  };

  $$(".rbtn").forEach((b) => {
    b.onclick = () => {
      $$(".rbtn").forEach((x) => x.classList.remove("on"));
      b.classList.add("on"); RANGE = b.dataset.r; renderAnalyze();
    };
  });

  $("#btnCsv").onclick = () => $("#fileCsv").click();
  $("#fileCsv").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    readFileSmart(f, (text) => { previewCSV(parseCSV(text)); e.target.value = ""; });
  };
  $("#btnTpl").onclick = templateCSV;

  $("#btnSigRefresh").onclick = async () => {
    SIGNAL = null;
    await loadSignal(true);
    renderStrategy();
  };
  $("#btnSigManual").onclick = () => {
    const pe = prompt("输入沪深300 PE(TTM)：", String(S.settings.pe.value || ""));
    if (!pe) return;
    const y10 = prompt("输入中国 10 年期国债收益率(%)，留空则用实时值：", SIGNAL && SIGNAL.y10 ? String(SIGNAL.y10) : "");
    S.settings.pe = { value: Number(pe), date: today() };
    SIGNAL = { date: today(), pe: Number(pe), y10: y10 ? Number(y10) : (SIGNAL ? SIGNAL.y10 : null), src: "手动" };
    SIGNAL.erp = SIGNAL.y10 ? 100 / SIGNAL.pe - SIGNAL.y10 : null;
    saveLocal(); renderStrategy();
  };
}

async function refreshPrices(force) {
  const codes = [];
  S.trades.forEach((t) => { if (codes.indexOf(t.code) < 0) codes.push(t.code); });
  (S.plans || []).forEach((p) => { if (codes.indexOf(p.code) < 0) codes.push(p.code); });
  if (!codes.length) { PRICES = {}; render(); return; }
  $("#syncNote").textContent = "拉取行情中…";
  await loadPrices(codes, force);
  const n = materializePlans();
  $("#syncNote").textContent = "行情已更新 " + new Date().toLocaleTimeString("zh-CN") + (n ? "，生成定投 " + n + " 笔" : "");
  render();
}

// ---------- 云同步 ----------
function cfg() { try { return JSON.parse(localStorage.getItem(LS_CFG) || "{}"); } catch (e) { return {}; } }
function saveCfg(c) { localStorage.setItem(LS_CFG, JSON.stringify(c)); }

async function ghRead(c, quiet) {
  const u = "https://api.github.com/repos/" + c.repo + "/contents/" + (c.path || "data.json");
  const r = await fetch(u, { headers: { Authorization: "token " + c.token, Accept: "application/vnd.github+json" } });
  if (!r.ok) { if (!quiet) { alert(r.status === 404
      ? "\u8bfb\u53d6\u5931\u8d25\uff1a404\n\n\u5e38\u89c1\u539f\u56e0\uff1a\n1) \u4ed3\u5e93\u540d\u5199\u9519\u6216\u4ed3\u5e93\u4e0d\u5b58\u5728\n2) token \u6ca1\u52fe\u9009\u8fd9\u4e2a\u4ed3\u5e93\uff08fine-grained \u5fc5\u987b\u624b\u52a8\u9009\uff09\n3) \u6587\u4ef6\u4e0d\u5b58\u5728\uff0c\u6bd4\u5982\u5b9e\u9645\u53eb data.json.txt\n\n\u70b9\u300c\u6d4b\u8bd5\u8fde\u63a5\u300d\u53ef\u5b9a\u4f4d\u662f\u54ea\u4e00\u6b65\u3002"
      : "\u8bfb\u53d6\u5931\u8d25\uff1a" + r.status); } return null; }
  const j = await r.json();
  if (!j.content || j.encoding === "none") {
    if (!quiet) alert("云端文件读不到内容。\n\n常见原因：\n1) 文件是空的（上一次保存中断）\n2) 文件超过 1MB，GitHub 的 Contents 接口不返回内容\n\n解决办法：在数据正常的设备上点「同步到云端」重新上传（新版会自动去掉行情缓存，体积小很多）。");
    return null;
  }
  const txt = decodeURIComponent(escape(atob(j.content.replace(/\n/g, ""))));
  if (!txt.trim()) { if (!quiet) alert("云端文件是空的。请在有数据的设备上重新「同步到云端」。"); return null; }
  let d;
  try { d = JSON.parse(txt); } catch (e) {
    if (!quiet) alert("云端文件解析失败（可能内容不完整）。\n建议在数据正常的设备上重新「同步到云端」。");
    return null;
  }
  d.priceCache = d.priceCache || {};
  return d;
}

async function testConn() {
  const c = cfg();
  if (!c.repo || !c.token) return alert("先填仓库和 token");
  const H = { Authorization: "token " + c.token, Accept: "application/vnd.github+json" };
  const out = [];
  let r = await fetch("https://api.github.com/user", { headers: H });
  if (r.ok) { const j = await r.json(); out.push("✅ token 有效，属于 " + j.login); }
  else { out.push("❌ token 无效/过期（/user " + r.status + "）"); }
  r = await fetch("https://api.github.com/repos/" + c.repo, { headers: H });
  if (r.ok) {
    const j = await r.json();
    out.push("✅ 仓库可访问：" + j.full_name + (j.private ? "（私有）" : "（公开）"));
  } else {
    out.push("❌ 仓库访问失败 " + r.status + "：" + (r.status === 404 ? "仓库名不对，或 token 没勾选这个仓库" : "权限不足"));
  }
  const path = c.path || "data.json";
  r = await fetch("https://api.github.com/repos/" + c.repo + "/contents/" + path, { headers: H });
  if (r.ok) {
    const j = await r.json();
    out.push("✅ 文件存在：" + j.path + "（" + j.size + " 字节）");
  } else if (r.status === 404) {
    out.push("❌ 文件不存在：" + path + "（Windows 常把名字存成 data.json.txt，去仓库网页确认）");
  } else {
    out.push("❌ 文件读取失败 " + r.status);
  }
  alert(out.join("\n"));
}

async function ghLoad() {
  const c = cfg();
  if (!c.repo || !c.token) return alert("\u5148\u5728\u300c\u8bbe\u7f6e\u300d\u91cc\u586b\u79c1\u6709\u6570\u636e\u4ed3\u5e93\u548c token");
  const d = await ghRead(c, false);
  if (!d) return;
  S = d;
  ensureSettings(); ensureGroups(); migrateMarket();
  const tl = $("#tLeg"), pl = $("#plLeg");
  if (tl) tl.innerHTML = groupOptions((S.groups[0] || {}).id || SAT);
  if (pl) pl.innerHTML = groupOptions((S.groups[0] || {}).id || SAT);
  saveLocal(); render();
  alert("\u5df2\u4ece\u4e91\u7aef\u62c9\u53d6");
  refreshPrices(false);
}

async function ghSave(quiet) {
  const c = cfg();
  if (!c.repo || !c.token) { if (!quiet) alert("\u5148\u5728\u300c\u8bbe\u7f6e\u300d\u91cc\u586b\u79c1\u6709\u6570\u636e\u4ed3\u5e93\u548c token"); return; }
  const path = c.path || "data.json";
  const u = "https://api.github.com/repos/" + c.repo + "/contents/" + path;
  let sha = null;
  const r0 = await fetch(u, { headers: { Authorization: "token " + c.token } });
  if (r0.ok) { const j0 = await r0.json(); sha = j0.sha; }
  const clone = Object.assign({}, S);
  delete clone.priceCache;                       // 行情缓存不上云，省体积
  let payload = JSON.stringify(clone, null, 2);
  if (payload.length > 900000) {
    if (!confirm("数据约 " + Math.round(payload.length / 1024) + " KB，接近 GitHub 1MB 上限，可能上传失败。继续？")) return;
  }
  const body = { message: "update portfolio " + new Date().toISOString(), content: btoa(unescape(encodeURIComponent(payload))) };
  if (sha) body.sha = sha;
  const r = await fetch(u, { method: "PUT", headers: { Authorization: "token " + c.token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    if (r.status === 409 || r.status === 422) {
      if (!quiet) alert("云端已被另一台设备改过（版本冲突）。\n请先点「从云端拉取」，确认后再同步。");
      return;
    }
    if (!quiet) alert("\u4e0a\u4f20\u5931\u8d25\uff1a" + r.status + " " + (await r.text()).slice(0, 200));
    return;
  }
  if (!quiet) alert("\u5df2\u540c\u6b65\u5230\u4e91\u7aef");
}

// ---------- 启动 ----------
async function main() {
  await loadState();
  bindTabs(); bindForms();

  const c = cfg();
  $("#ghRepo").value = c.repo || "";
  $("#ghToken").value = c.token || "";
  $("#ghPath").value = c.path || "data.json";
  $("#autoSync").checked = !!c.autoSync;
  $("#dataRepoState").textContent = c.repo ? "已连接 " + c.repo : "未配置（数据存本机）";
  $("#tgDiv").value = S.settings.divCode;
  $("#tgBond").value = S.settings.bondCode;

  $("#saveCfg").onclick = () => {
    const nc = {
      repo: $("#ghRepo").value.trim(),
      token: $("#ghToken").value.trim(),
      path: $("#ghPath").value.trim() || "data.json",
      autoSync: $("#autoSync").checked
    };
    saveCfg(nc);
    $("#dataRepoState").textContent = nc.repo ? "已连接 " + nc.repo : "未配置（数据存本机）";
    alert("已保存到本机");
  };
  $("#btnTest").onclick = testConn;
  $("#ghLoad").onclick = ghLoad;
  $("#ghSave").onclick = ghSave;
  $("#btnRefresh").onclick = () => refreshPrices(true);
  $("#btnExport").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], { type: "application/json" }));
    a.download = "portfolio-" + today() + ".json"; a.click();
  };
  $("#btnReset").onclick = () => {
    if (!confirm("清空本机所有持仓 / 交易 / 入金记录？")) return;
    if (!confirm("再确认一次：不可恢复（云端私有仓库不会被清空）")) return;
    const accounts = S.accounts;
    S = { version: 2, accounts: accounts, cash: {}, flows: [], trades: [], settings: S.settings, legs: {}, priceCache: {}, meta: { updated: today() } };
    ensureSettings(); saveLocal(); render();
    alert("已清空");
  };
  $("#btnImport").onclick = () => $("#fileImport").click();
  $("#fileImport").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { S = JSON.parse(rd.result); ensureSettings(); saveLocal(); render(); alert("导入成功"); }
      catch (x) { alert("文件格式错误"); }
    };
    rd.readAsText(f);
  };

  ensureGroups();
  $("#tLeg").innerHTML = groupOptions((S.groups[0] || {}).id || SAT);
  $("#plLeg").innerHTML = groupOptions((S.groups[0] || {}).id || SAT);
  migrateMarket();
  render();
  await refreshPrices(false);
  await loadSignal(false);
  renderStrategy();
  const hashTab = location.hash.replace("#", "");
  if (hashTab && ["hold","trade","plan","strategy","analyze","set"].indexOf(hashTab) >= 0) {
    const map = {hold:"pHold", trade:"pTrade", plan:"pPlan", strategy:"pStrategy", analyze:"pAnalyze", set:"pSet"};
    const b = $('.tab[data-p="' + map[hashTab] + '"]'); if (b) b.click();
  }
  if (location.hash === "#trade") { const b = $('.tab[data-p="pTrade"]'); if (b) b.click(); }
  if (location.hash === "#strategy") { const b = $('.tab[data-p="pStrategy"]'); if (b) b.click(); }
  if (location.hash === "#analyze") { const b = $('.tab[data-p="pAnalyze"]'); if (b) b.click(); }
  if (location.search.indexOf("w=1") >= 0) {
    const d = document.getElementById("asof");
    if (d) d.textContent = "vw=" + window.innerWidth + " sw=" + document.documentElement.scrollWidth + " bw=" + document.body.scrollWidth;
  }
  if (location.search.indexOf("navtest") >= 0) {
    let msg = "MOB:";
    try {
      const u = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?FCODE=021000&pageIndex=1&pageSize=5&deviceid=1&plat=Android&product=EFund&version=6.2.8";
      const r = await fetch(u, { cache: "no-store" });
      const j = await r.json();
      msg += " status=" + r.status + " n=" + ((j && j.Datas) || []).length + " first=" + ((j && j.Datas && j.Datas[0] || {}).FSRQ);
    } catch (e) { msg += " ERR " + e.message; }
    const el = document.getElementById("planNote");
    if (el) el.textContent = msg;
  }
  window.addEventListener("resize", () => renderAnalyze());
}
document.addEventListener("DOMContentLoaded", main);
