# -*- coding: utf-8 -*-
"""抓取沪深300 PE 与 中国10年期国债收益率，生成 signal.json。

用法：
    python scripts/fetch_signal.py

由 GitHub Actions 每天定时跑一次（见 .github/workflows/update-signal.yml），
页面读取仓库根目录的 signal.json 即可，不需要任何 token。
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "signal.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
HDR = {"User-Agent": UA, "Referer": "https://www.csindex.com.cn/"}


def get(url, headers=None, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers or HDR)
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def fetch_pe():
    """沪深300 PE(TTM)。中证指数官网的 peg 字段。"""
    today = datetime.now()
    start = (today - timedelta(days=20)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    url = ("https://www.csindex.com.cn/csindex-home/perf/index-perf?"
           f"indexCode=000300&startDate={start}&endDate={end}")
    js = json.loads(get(url))
    for row in reversed(js.get("data") or []):
        if row.get("peg"):
            return float(row["peg"]), row["tradeDate"]
    raise RuntimeError("PE 未取到")


def fetch_y10():
    """中国 10 年期国债收益率（东财）。EMM00166466。"""
    url = ("https://datacenter-web.eastmoney.com/api/data/v1/get?"
           "reportName=RPTA_WEB_TREASURYYIELD&columns=ALL&pageNumber=1&pageSize=5"
           "&sortColumns=SOLAR_DATE&sortTypes=-1")
    js = json.loads(get(url, headers={"User-Agent": UA,
                                      "Referer": "https://data.eastmoney.com/"}))
    for row in (js.get("result") or {}).get("data") or []:
        v = row.get("EMM00166466")
        if v is not None:
            return float(v), row["SOLAR_DATE"][:10]
    raise RuntimeError("10Y 未取到")


def bucket(erp):
    if erp > 6:
        return 100, "加倍定投"
    if erp > 5:
        return 70, "正常持有"
    if erp > 4:
        return 40, "降低权益"
    return 0, "清仓权益"


def main():
    pe, pe_date = fetch_pe()
    y10, y10_date = fetch_y10()
    if len(pe_date) == 8:
        pe_date = f"{pe_date[:4]}-{pe_date[4:6]}-{pe_date[6:8]}"
    erp = 100.0 / pe - y10
    eq, tag = bucket(erp)
    out = {
        "date": max(pe_date, y10_date),
        "pe": round(pe, 2),
        "y10": round(y10, 4),
        "erp": round(erp, 3),
        "equity": eq,
        "bucket": tag,
        "updated": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": "csindex(000300 PE) + eastmoney(10Y CGB)",
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
