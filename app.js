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

const LS_KEY = "pf_state_v1";
const LS_CFG = "pf_cfg_v1";

function today() { return new Date().toISOString().slice(0, 10); }
function uid() { return Math.random().toString(36).slice(2, 9); }
function fmt(x, d) {
  if (d === undefined) d = 2;
  if (x === null || x === undefined || isNaN(x)) return "-";
  return Number(x).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pct(x, d) { return (x * 100).toFixed(d === undefined ? 2 : d) + "%"; }
function days(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function money(x) { return "¥" + fmt(x, 0); }

// ---------- 默认设置 ----------
function ensureSettings() {
  S.settings = S.settings || {};
  const st = S.settings;
  st.targets = st.targets || { rot: 50, spy: 25, ndx: 25 };
  st.divCode = st.divCode || "515080";
  st.bondCode = st.bondCode || "511010";
  st.pe = st.pe || { value: 13.09, date: "2026-11-20" };
  S.legs = S.legs || {};
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

async function fetchKline(code) {
  for (const mk of ["1", "0"]) {
    const cb = "cbk_" + code + "_" + Math.random().toString(36).slice(2, 6);
    let payload = null;
    window[cb] = (js) => { payload = js; };
    try {
      const u = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + mk + "." + code +
        "&fields1=f1&fields2=f51,f53&klt=101&fqt=1&beg=0&end=20500101&cb=" + cb;
      await jsonpLoad(u);
      if (payload && payload.data && payload.data.klines && payload.data.klines.length) {
        delete window[cb];
        return payload.data.klines.map((k) => {
          const p = k.split(",");
          return { date: p[0], px: Number(p[1]), tr: Number(p[1]) };
        });
      }
    } catch (e) { /* next */ }
    delete window[cb];
  }
  return [];
}

async function loadPrices(codes, force) {
  const out = {};
  for (const code of codes) {
    const cached = S.priceCache[code];
    const fresh = cached && cached.length && days(cached[cached.length - 1].date, today()) <= 1;
    if (cached && fresh && !force) { out[code] = cached; continue; }
    let arr = [];
    try { arr = await fetchFundNav(code); } catch (e) { arr = []; }
    if (!arr.length) { try { arr = await fetchKline(code); } catch (e) { arr = []; } }
    if (arr.length) { out[code] = arr; S.priceCache[code] = arr; }
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
    if (!st[t.code]) st[t.code] = { code: t.code, name: t.name || t.code, shares: 0, cost: 0, realized: 0 };
    const h = st[t.code];
    const sh = Number(t.shares), px = Number(t.price), fee = Number(t.fee || 0);
    if (t.side === "buy") { h.shares += sh; h.cost += sh * px + fee; }
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
    return { code: h.code, name: h.name, realized: h.realized, unrealized: un, total: h.realized + un };
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
  SERIES = replay();
  const rows = SERIES;
  const last = rows.length ? rows[rows.length - 1] : { value: 0, mv: 0, cash: 0, date: "-", cf: 0 };
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const invested = S.flows.reduce((a, f) => a + Number(f.amount), 0);
  const totalPnl = last.value - invested;
  const dayPnl = prev ? last.value - prev.value - (last.cf || 0) : 0;

  $("#kpiValue").textContent = money(last.value);
  $("#kpiPnl").textContent = (totalPnl >= 0 ? "+" : "") + fmt(totalPnl, 0);
  $("#kpiPnl").className = "v " + (totalPnl >= 0 ? "up" : "down");
  $("#kpiDay").textContent = (dayPnl >= 0 ? "+" : "") + fmt(dayPnl, 0);
  $("#kpiDay").className = "v " + (dayPnl >= 0 ? "up" : "down");
  $("#kpiInvest").textContent = money(invested);
  $("#asof").textContent = last.date;

  renderHoldings();
  renderAttribution();
  renderTrades();
  renderStrategy();
  renderAnalyze();
}

function legOf(code) {
  if (S.legs[code]) return S.legs[code];
  if (code === S.settings.divCode || code === S.settings.bondCode) return "rot";
  return "other";
}

const LEG_NAME = { rot: "股债轮动", spy: "标普500", ndx: "纳指", other: "其他" };

function renderHoldings() {
  const hs = holdings();
  const tb = $("#holdBody");
  tb.innerHTML = "";
  let total = 0;
  hs.forEach((h) => { const p = lastPrice(h.code); if (p) total += p * h.shares; });
  hs.forEach((h) => {
    const px = lastPrice(h.code);
    const mv = px ? px * h.shares : 0;
    const pnl = px ? mv - h.cost : null;
    const leg = legOf(h.code);
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + h.code + "</td><td class='l'>" + h.name + "</td>" +
      "<td class='l hide-s'><select class='legsel' data-code='" + h.code + "'>" +
      ["rot", "spy", "ndx", "other"].map((k) => "<option value='" + k + "'" + (k === leg ? " selected" : "") + ">" + LEG_NAME[k] + "</option>").join("") +
      "</select></td>" +
      "<td>" + fmt(h.shares, 0) + "</td><td class='hide-s'>" + fmt(h.shares ? h.cost / h.shares : 0, 4) + "</td>" +
      "<td>" + (px ? fmt(px, 4) : "-") + "</td><td>" + (px ? fmt(mv, 0) : "-") + "</td>" +
      "<td class='" + (pnl >= 0 ? "up" : "down") + "'>" + (pnl !== null ? (pnl >= 0 ? "+" : "") + fmt(pnl, 0) : "-") + "</td>" +
      "<td class='hide-s'>" + (mv && total ? pct(mv / total) : "-") + "</td>";
    tb.appendChild(tr);
  });
  if (!hs.length) tb.innerHTML = "<tr><td colspan='9' class='muted'>还没有持仓，去「交易」里记一笔</td></tr>";
  tb.onchange = (e) => {
    const sel = e.target;
    if (sel.classList.contains("legsel")) {
      S.legs[sel.getAttribute("data-code")] = sel.value;
      saveLocal(); renderStrategy();
    }
  };
  let cashSum = 0;
  Object.keys(S.cash || {}).forEach((k) => { cashSum += Number(S.cash[k] || 0); });
  $("#cashNote").textContent = "现金 " + money(cashSum);
}

function renderAttribution() {
  const tb = $("#attrBody");
  tb.innerHTML = "";
  const rows = attribution();
  const total = rows.reduce((a, r) => a + Math.abs(r.total), 0);
  rows.forEach((r) => {
    const cls = r.total >= 0 ? "up" : "down";
    const tr = document.createElement("tr");
    tr.innerHTML = "<td class='l'>" + r.name + " <span class='muted'>" + r.code + "</span></td>" +
      "<td class='" + (r.realized >= 0 ? "up" : "down") + "'>" + (r.realized >= 0 ? "+" : "") + fmt(r.realized, 0) + "</td>" +
      "<td class='" + (r.unrealized >= 0 ? "up" : "down") + "'>" + (r.unrealized >= 0 ? "+" : "") + fmt(r.unrealized, 0) + "</td>" +
      "<td class='" + cls + "'><b>" + (r.total >= 0 ? "+" : "") + fmt(r.total, 0) + "</b></td>" +
      "<td>" + (total ? pct(r.total / Math.abs(total)) : "-") + "</td>";
    tb.appendChild(tr);
  });
  if (!rows.length) tb.innerHTML = "<tr><td colspan='5' class='muted'>暂无数据</td></tr>";
}

// ---------- 渲染：交易 ----------
function renderTrades() {
  const tb = $("#tradeBody");
  tb.innerHTML = "";
  const ts = S.trades.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  ts.forEach((t) => {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + t.date + "</td><td class='hide-s'>" + (t.accountName || t.account || "") + "</td>" +
      "<td>" + t.code + "</td><td class='l'>" + (t.name || "") + "</td>" +
      "<td class='" + (t.side === "buy" ? "up" : "down") + "'>" + (t.side === "buy" ? "买入" : "卖出") + "</td>" +
      "<td>" + fmt(t.shares, 0) + "</td><td>" + fmt(t.price, 4) + "</td>" +
      "<td class='hide-s'>" + fmt(t.fee || 0, 2) + "</td><td><button class='mini' data-del='" + t.id + "'>删</button></td>";
    tb.appendChild(tr);
  });
  if (!ts.length) tb.innerHTML = "<tr><td colspan='9' class='muted'>暂无交易记录</td></tr>";
  tb.onclick = (e) => {
    const id = e.target.getAttribute && e.target.getAttribute("data-del");
    if (!id) return;
    if (!confirm("删除这条记录？")) return;
    S.trades = S.trades.filter((x) => x.id !== id);
    saveLocal(); render();
  };
}

// ---------- 渲染：策略 ----------
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
    const total = lastTotal();
    $("#sigRec").textContent = "本月建议：" + b.desc + "（按当前总资产 " + money(total) + "，红利约 " + money(total * b.eq / 100) + "，国债约 " + money(total * (100 - b.eq) / 100) + "）";
  }
  renderRebalance();
  renderRotInternal();
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
  const lv = legValues();
  const total = lastTotal();
  const cash = total - (lv.rot + lv.spy + lv.ndx + lv.other);
  const t = S.settings.targets;
  const rows = [
    ["rot", "股债轮动", t.rot],
    ["spy", "标普500", t.spy],
    ["ndx", "纳指", t.ndx],
  ];
  const tb = $("#rbBody");
  tb.innerHTML = "";
  rows.forEach(([k, name, tgt]) => {
    const act = total ? (lv[k] / total) * 100 : 0;
    const dev = act - tgt;
    const amt = (tgt / 100) * total - lv[k];
    const cls = Math.abs(dev) > 5 ? "dev warn" : "dev";
    const tr = document.createElement("tr");
    tr.innerHTML = "<td class='l'>" + name + "</td><td>" + tgt + "%</td><td>" + act.toFixed(1) + "%</td>" +
      "<td class='" + cls + "'>" + (dev >= 0 ? "+" : "") + dev.toFixed(1) + "pp</td>" +
      "<td class='" + (amt >= 0 ? "down" : "up") + "'>" + (Math.abs(amt) < total * 0.005 ? "不动" : (amt > 0 ? "买入 " : "卖出 ") + money(Math.abs(amt))) + "</td>";
    tb.appendChild(tr);
  });
  $("#rbTotal").textContent = "总资产 " + money(total) + " · 现金 " + money(cash);
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
    const tr = document.createElement("tr");
    tr.innerHTML = "<td class='l'>" + name + "</td><td>" + fmt(v, 0) + "</td><td>" + tgt + "%</td>" +
      "<td class='" + (Math.abs(dev) > 5 ? "dev warn" : "dev") + "'>" + (dev >= 0 ? "+" : "") + dev.toFixed(1) + "pp</td>";
    tb.appendChild(tr);
  });
  if (!sum) tb.innerHTML = "<tr><td colspan='4' class='muted'>轮动腿还没有持仓</td></tr>";
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
    parsed.forEach((p) => S.trades.push(Object.assign({ id: uid(), account: (S.accounts[0] || {}).id || "A" }, p)));
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
      fee: Number($("#tFee").value || 0), leg: $("#tLeg").value
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

  $("#btnInit").onclick = importInit;
  $("#initDate").value = today();
  $("#initText").addEventListener("input", () => {
    const rows = parseInitLines($("#initText").value, $("#initDate").value || today());
    $("#initPreview").textContent = rows.length
      ? "识别到 " + rows.length + " 只，总成本约 " + money(rows.reduce((a, r) => a + r.shares * r.price, 0))
      : "格式：代码,名称,份额,成本价,日期";
  });

  $("#targetForm").onsubmit = (e) => {
    e.preventDefault();
    S.settings.targets = { rot: Number($("#tgRot").value), spy: Number($("#tgSpy").value), ndx: Number($("#tgNdx").value) };
    S.settings.divCode = $("#tgDiv").value.trim() || "515080";
    S.settings.bondCode = $("#tgBond").value.trim() || "511010";
    saveLocal(); renderStrategy();
    alert("已保存：轮动 " + S.settings.targets.rot + "% / 标普 " + S.settings.targets.spy + "% / 纳指 " + S.settings.targets.ndx + "%");
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
  if (!codes.length) { PRICES = {}; render(); return; }
  $("#syncNote").textContent = "拉取行情中…";
  await loadPrices(codes, force);
  $("#syncNote").textContent = "行情已更新 " + new Date().toLocaleTimeString("zh-CN");
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
  const txt = decodeURIComponent(escape(atob(j.content.replace(/\n/g, ""))));
  const d = JSON.parse(txt);
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
  S = d; ensureSettings(); saveLocal(); render();
  alert("\u5df2\u4ece\u4e91\u7aef\u62c9\u53d6");
}

async function ghSave(quiet) {
  const c = cfg();
  if (!c.repo || !c.token) { if (!quiet) alert("\u5148\u5728\u300c\u8bbe\u7f6e\u300d\u91cc\u586b\u79c1\u6709\u6570\u636e\u4ed3\u5e93\u548c token"); return; }
  const path = c.path || "data.json";
  const u = "https://api.github.com/repos/" + c.repo + "/contents/" + path;
  let sha = null;
  const r0 = await fetch(u, { headers: { Authorization: "token " + c.token } });
  if (r0.ok) { const j0 = await r0.json(); sha = j0.sha; }
  const body = { message: "update portfolio " + new Date().toISOString(), content: btoa(unescape(encodeURIComponent(JSON.stringify(S, null, 2)))) };
  if (sha) body.sha = sha;
  const r = await fetch(u, { method: "PUT", headers: { Authorization: "token " + c.token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { if (!quiet) alert("\u4e0a\u4f20\u5931\u8d25\uff1a" + r.status + " " + (await r.text()).slice(0, 200)); return; }
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
  $("#tgRot").value = S.settings.targets.rot;
  $("#tgSpy").value = S.settings.targets.spy;
  $("#tgNdx").value = S.settings.targets.ndx;
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

  render();
  await refreshPrices(false);
  await loadSignal(false);
  renderStrategy();
  const hashTab = location.hash.replace("#", "");
  if (hashTab && ["hold","trade","strategy","analyze","set"].indexOf(hashTab) >= 0) {
    const map = {hold:"pHold", trade:"pTrade", strategy:"pStrategy", analyze:"pAnalyze", set:"pSet"};
    const b = $('.tab[data-p="' + map[hashTab] + '"]'); if (b) b.click();
  }
  if (location.hash === "#trade") { const b = $('.tab[data-p="pTrade"]'); if (b) b.click(); }
  if (location.hash === "#strategy") { const b = $('.tab[data-p="pStrategy"]'); if (b) b.click(); }
  if (location.hash === "#analyze") { const b = $('.tab[data-p="pAnalyze"]'); if (b) b.click(); }
  if (location.search.indexOf("w=1") >= 0) {
    const d = document.getElementById("asof");
    if (d) d.textContent = "vw=" + window.innerWidth + " sw=" + document.documentElement.scrollWidth + " bw=" + document.body.scrollWidth;
  }
  window.addEventListener("resize", () => renderAnalyze());
}
document.addEventListener("DOMContentLoaded", main);
