// ═══════════════════════════════════════════════════
//  stockApi.js — 股票資料抓取模組
//  來源 1：TWSE OpenAPI（台股，免費無需金鑰）
//  來源 2：Yahoo Finance v8 proxy（美股 / 台股補充）
//  來源 3：本地快取 data/stocks.json（GitHub Actions）
// ═══════════════════════════════════════════════════

const StockAPI = {

  // Yahoo Finance proxy（CORS-safe public endpoints）
  YF_PROXY: 'https://query1.finance.yahoo.com/v8/finance/chart/',
  // TWSE 日K API
  TWSE_DAY: 'https://www.twse.com.tw/exchangeReport/STOCK_DAY',
  // 外資買賣超（TWSE）
  TWSE_INSTIT: 'https://www.twse.com.tw/fund/TWT38U',
  // 快取檔路徑（GitHub Actions 每日更新）
  CACHE_PATH: './data/stocks.json',

  // ─── 判斷是否為台股代號 ────────────────────────
  isTW(symbol) {
    return /^\d{4,6}$/.test(symbol);
  },

  // ─── 從快取讀取（優先使用，避免 CORS 問題）──────
  async fromCache() {
    try {
      const res = await fetch(this.CACHE_PATH + '?t=' + Date.now());
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  },

  // ─── Yahoo Finance：抓取 OHLCV 歷史 ─────────────
  async fetchYahoo(symbol, months = 6) {
    const twSymbol = this.isTW(symbol) ? symbol + '.TW' : symbol;
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - months * 30 * 86400;
    const url = `${this.YF_PROXY}${twSymbol}?interval=1d&period1=${period1}&period2=${period2}&events=history`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('No data');
      const ts     = result.timestamp;
      const quotes = result.indicators.quote[0];
      const ohlcv  = ts.map((t, i) => ({
        date:   new Date(t * 1000).toISOString().slice(0, 10),
        open:   quotes.open[i]   ?? quotes.close[i],
        high:   quotes.high[i]   ?? quotes.close[i],
        low:    quotes.low[i]    ?? quotes.close[i],
        close:  quotes.close[i],
        volume: quotes.volume[i] ?? 0
      })).filter(d => d.close !== null && d.close !== undefined);
      const meta   = result.meta;
      return {
        symbol,
        name:     meta.longName || meta.shortName || symbol,
        currency: meta.currency,
        exchange: meta.exchangeName,
        price:    meta.regularMarketPrice,
        prevClose:meta.previousClose,
        change:   meta.regularMarketPrice - meta.previousClose,
        changePct:(meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100,
        ohlcv
      };
    } catch (e) {
      console.warn(`[StockAPI] Yahoo fetch failed for ${symbol}:`, e.message);
      return null;
    }
  },

  // ─── TWSE：抓取台股月K資料（近N個月）────────────
  async fetchTWSE(symbol, months = 6) {
    const allOHLCV = [];
    const now = new Date();
    for (let m = 0; m < months; m++) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const yyyymm = d.getFullYear() * 100 + (d.getMonth() + 1);
      try {
        const res = await fetch(
          `${this.TWSE_DAY}?response=json&date=${yyyymm}01&stockNo=${symbol}`
        );
        if (!res.ok) continue;
        const json = await res.json();
        if (json.stat !== 'OK' || !json.data) continue;
        for (const row of json.data) {
          // row: [日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數]
          const twDate = row[0].replace(/\//g, '-');
          const [y, mo, day] = twDate.split('-');
          const iso = `${parseInt(y) + 1911}-${mo}-${day}`;
          const toNum = s => parseFloat(s.replace(/,/g, ''));
          allOHLCV.push({
            date:   iso,
            open:   toNum(row[3]),
            high:   toNum(row[4]),
            low:    toNum(row[5]),
            close:  toNum(row[6]),
            volume: Math.round(toNum(row[1]) / 1000) // 張
          });
        }
      } catch (e) {
        console.warn(`[TWSE] ${symbol} ${yyyymm} failed:`, e.message);
      }
      await new Promise(r => setTimeout(r, 300)); // Rate limit protection
    }
    allOHLCV.sort((a, b) => a.date.localeCompare(b.date));
    if (!allOHLCV.length) return null;
    const last = allOHLCV[allOHLCV.length - 1];
    const prev = allOHLCV[allOHLCV.length - 2];
    const chg  = prev ? last.close - prev.close : 0;
    return {
      symbol,
      name:      json?.title?.split(' ')[1] || symbol,
      currency:  'TWD',
      exchange:  'TWSE',
      price:     last.close,
      prevClose: prev?.close,
      change:    chg,
      changePct: prev ? chg / prev.close * 100 : 0,
      ohlcv:     allOHLCV
    };
  },

  // ─── 抓取法人買賣超（TWSE）────────────────────────
  async fetchInstitutional(symbol) {
    try {
      const today = new Date();
      const yyyymmdd = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
      const url = `https://www.twse.com.tw/fund/TWT38U?response=json&date=${yyyymmdd}&stockNo=${symbol}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.stat !== 'OK' || !json.data?.length) return null;
      // 取最近幾日資料統計
      const rows = json.data.slice(0, 10).map(r => ({
        date:    r[0],
        foreign: parseInt(r[4].replace(/,/g, '')) || 0, // 外資買賣超（張）
        trust:   parseInt(r[7].replace(/,/g, '')) || 0, // 投信買賣超
        dealer:  parseInt(r[10].replace(/,/g, '')) || 0 // 自營商買賣超
      }));
      const days3  = rows.slice(0, 3);
      const days5  = rows.slice(0, 5);
      const days10 = rows.slice(0, 10);
      const sum = (arr, key) => arr.reduce((s, r) => s + r[key], 0);
      return {
        latest:     rows[0],
        foreign3d:  sum(days3, 'foreign'),
        trust3d:    sum(days3, 'trust'),
        dealer3d:   sum(days3, 'dealer'),
        foreign5d:  sum(days5, 'foreign'),
        foreign10d: sum(days10, 'foreign'),
        consecutive: calcConsecutive(rows, 'foreign')
      };
    } catch (e) {
      console.warn(`[TWSE Instit] ${symbol}:`, e.message);
      return null;
    }
  },

  // ─── 大盤指數（TAIEX + 美股）────────────────────
  async fetchMarketIndex() {
    const indices = [
      { symbol: '^TWII',  name: '台股 TAIEX' },
      { symbol: '^GSPC',  name: 'S&P 500'   },
      { symbol: '^IXIC',  name: 'NASDAQ'    },
      { symbol: '^VIX',   name: 'VIX'       }
    ];
    const results = {};
    for (const idx of indices) {
      try {
        const url = `${this.YF_PROXY}${idx.symbol}?interval=1d&range=5d`;
        const res = await fetch(url);
        const json = await res.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (!meta) continue;
        results[idx.symbol] = {
          name:      idx.name,
          price:     meta.regularMarketPrice,
          prevClose: meta.previousClose,
          change:    meta.regularMarketPrice - meta.previousClose,
          changePct: (meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100
        };
      } catch (e) {
        console.warn(`[Index] ${idx.symbol} failed`);
      }
    }
    return results;
  },

  // ─── 主入口：抓一支股票的完整資料 ────────────────
  async fetchStock(symbol) {
    let data = null;
    // 台股優先用 Yahoo（有 CORS-friendly endpoint）
    data = await this.fetchYahoo(symbol);
    if (!data || data.ohlcv.length < 30) {
      data = null;
    }
    return data;
  },

  // ─── 批次抓取多支股票 ─────────────────────────────
  async fetchAll(symbols, onProgress) {
    // 先嘗試讀快取
    const cache = await this.fromCache();
    if (cache && cache.updatedAt) {
      const age = Date.now() - new Date(cache.updatedAt).getTime();
      if (age < 4 * 3600 * 1000) { // 4 小時內快取有效
        if (onProgress) onProgress(100, '載入快取資料');
        return cache;
      }
    }

    const result = { stocks: {}, market: {}, updatedAt: new Date().toISOString() };

    // 大盤指數
    if (onProgress) onProgress(5, '抓取大盤指數...');
    result.market = await this.fetchMarketIndex();

    // 個股資料
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const pct = Math.round(10 + (i / symbols.length) * 85);
      if (onProgress) onProgress(pct, `抓取 ${sym}...`);
      const raw = await this.fetchStock(sym);
      if (raw) {
        const indicators = Indicators.compute(raw.ohlcv);
        // 台股加抓法人
        let institutional = null;
        if (this.isTW(sym)) {
          if (onProgress) onProgress(pct + 2, `${sym} 法人資料...`);
          institutional = await this.fetchInstitutional(sym);
        }
        result.stocks[sym] = { ...raw, indicators, institutional };
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (onProgress) onProgress(100, '資料載入完成');
    return result;
  }
};

// 計算連續買超/賣超天數
function calcConsecutive(rows, key) {
  let count = 0;
  const dir = rows[0]?.[key] >= 0 ? 1 : -1;
  for (const row of rows) {
    if ((row[key] >= 0 ? 1 : -1) === dir) count++;
    else break;
  }
  return { days: count, direction: dir > 0 ? 'buy' : 'sell' };
}
