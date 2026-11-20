// 逻辑自测：在 node 里加载 app.js 的纯函数部分（无 DOM 部分）
const fs = require("fs");
const path = require("path");

let src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const cut = src.indexOf("// ---------- 渲染");
src = src.slice(0, cut);

global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = {
  querySelector: () => ({ textContent: "", className: "", value: "", innerHTML: "" }),
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild: () => {}, remove: () => {} }),
  addEventListener: () => {},
};
global.window = global;
global.addEventListener = () => {};

eval(src + "\n;global.__replay=replay;global.__metrics=metrics;global.__set=(s,p)=>{S=s;PRICES=p};");

let fails = 0;
function run(name, got, exp, tol = 1e-6) {
  const ok = Math.abs(got - exp) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${got}, exp ${exp}`);
}

// --- 用例 1：单笔买入 + 价格波动（px=tr，无分红） ---
const prices = {
  TEST: [
    { date: "2026-01-02", px: 10, tr: 10 },
    { date: "2026-01-03", px: 11, tr: 11 },
    { date: "2026-01-06", px: 9, tr: 9 },
  ],
};
const state = {
  version: 1,
  accounts: [{ id: "A", name: "证券" }],
  cash: { A: 0 },
  flows: [{ id: "f1", date: "2026-01-02", account: "A", amount: 100000 }],
  trades: [{ id: "t1", date: "2026-01-02", account: "A", code: "TEST", name: "测试", side: "buy", shares: 1000, price: 10, fee: 0 }],
  priceCache: prices,
};
__set(state, prices);
const rows = __replay();
run("期初市值", rows[0].value, 100000);
run("01-03 市值", rows[1].value, 101000);
run("01-06 市值", rows[2].value, 99000);
run("01-03 净值", rows[1].nav, 1.01);
run("01-06 净值", rows[2].nav, 0.99);

const m = __metrics(rows);
run("区间收益", m.ret, -0.01);
run("最大回撤", m.mdd, 0.99 / 1.01 - 1);

// --- 用例 2：中途入金不扭曲净值 ---
const state2 = JSON.parse(JSON.stringify(state));
state2.flows.push({ id: "f2", date: "2026-01-03", account: "A", amount: 50000 });
__set(state2, prices);
const rows2 = __replay();
const m2 = __metrics(rows2);
run("入金后 01-03 市值", rows2[1].value, 151000);
run("入金不改变净值(01-03)", rows2[1].nav, 1.01);
run("入金稀释后总收益", m2.ret, 1.01 * (149000 / 151000) - 1);   // 权益被稀释

// --- 用例 3：卖出 ---
const state3 = JSON.parse(JSON.stringify(state));
state3.trades.push({ id: "t2", date: "2026-01-03", account: "A", code: "TEST", name: "测试", side: "sell", shares: 1000, price: 11, fee: 0 });
__set(state3, prices);
const rows3 = __replay();
run("卖出后 01-06 市值", rows3[2].value, 101000);
run("卖出后收益", __metrics(rows3).ret, 0.01);

// --- 用例 4：现金分红（px 不变、tr 涨 5%） ---
const pdiv = {
  TEST: [
    { date: "2026-01-02", px: 10, tr: 10 },
    { date: "2026-01-03", px: 10, tr: 10.5 },
  ],
};
const state4 = JSON.parse(JSON.stringify(state));
__set(state4, pdiv);
const rows4 = __replay();
run("分红后总资产", rows4[1].value, 100500);
run("分红后现金", rows4[1].cash, 90500);
run("分红计入收益", __metrics(rows4).ret, 0.005);

// --- 用例 5：份额拆分（px 减半、tr 不变） ---
const psplit = {
  TEST: [
    { date: "2026-01-02", px: 10, tr: 10 },
    { date: "2026-01-03", px: 5, tr: 10 },
  ],
};
const state5 = JSON.parse(JSON.stringify(state));
__set(state5, psplit);
const rows5 = __replay();
run("拆分后总资产不变", rows5[1].value, 100000);
run("拆分后收益为 0", __metrics(rows5).ret, 0);

console.log(fails ? `\n${fails} 条失败` : "\n全部通过");
process.exitCode = fails ? 1 : 0;
