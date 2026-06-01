// ═══════════════════════════════════════════════════
//  scripts/fetch-data.js
//  GitHub Actions 執行：抓取股票資料並存入 data/stocks.json
// ═══════════════════════════════════════════════════

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const SYMBOLS = (process.env.SYMBOLS || '6467,2401,TSLA').split(',').map(s => s.trim());
const OUTPUT  = path.join(__dirname, '..', 'data', 'stocks.json');

// ─── Yahoo Finance 抓取 ───────────────────────────
async function fetchYahoo(symbol) {
  const twSymbol = /^\d+$/.test(symbol) ? symbol + '.TW' : symbol;
  const period2  = Math.floor(Date.now() / 1000);
  const period1  = period2 - 180 * 86400; // 6 個月
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${twSymbol}?interval=1d&period1=${period1}&period2=${period2}`;
  const res  = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    timeout: 15000
  });
  const result = res.data?.chart?.result?.[0];
  if (!result) throw new Error('No data from Yahoo');
  const ts     = result.timestamp;
  const quotes = result.indicators.quote[0];
  const meta   = result.meta;
  const ohlcv  = ts.map((t, i) => ({
    date:   new Date(t * 1000).toISOString().slice(0, 10),
    open:   parseFloat((quotes.open[i]   || quotes.close[i] || 0).toFixed(2)),
    high:   parseFloat((quotes.high[i]   || quotes.close[i] || 0).toFixed(2)),
    low:    parseFloat((quotes.low[i]    || quotes.close[i] || 0).toFixed(2)),
    close:  parseFloat((quotes.close[i]  || 0).toFixed(2)),
    volume: Math.round(quotes.volume[i]  || 0)
  })).filter(d => d.close > 0);
  return {
    symbol,
    name:      meta.longName || meta.shortName || symbol,
    currency:  meta.currency || 'TWD',
    exchange:  meta.exchangeName || '',
    price:     parseFloat((meta.regularMarketPrice || 0).toFixed(2)),
    prevClose: parseFloat((meta.previousClose      || 0).toFixed(2)),
    change:    parseFloat(((meta.regularMarketPrice || 0) - (meta.previousClose || 0)).toFixed(2)),
    changePct: parseFloat((((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100).toFixed(2)),
    ohlcv
  };
}

// ─── 大盤指數 ────────────────────────────────────
async function fetchIndex(symbol, name) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const res  = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000
  });
  const meta = res.data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  return {
    name,
    price:     parseFloat((meta.regularMarketPrice            || 0).toFixed(2)),
    prevClose: parseFloat((meta.previousClose                 || 0).toFixed(2)),
    change:    parseFloat(((meta.regularMarketPrice || 0) - (meta.previousClose || 0)).toFixed(2)),
    changePct: parseFloat((((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100).toFixed(2))
  };
}

// ─── 簡化版技術指標（Node.js 環境） ──────────────
function sma(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) { r.push(null); continue; }
    r.push(arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  }
  return r;
}
function ema(arr, n) {
  const k = 2 / (n + 1); const r = []; let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) { r.push(null); continue; }
    if (prev == null) {
      if (i < n - 1) { r.push(null); continue; }
      prev = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
      r.push(prev); continue;
    }
    prev = arr[i] * k + prev * (1 - k); r.push(prev);
  }
  return r;
}
function last(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; }
function r2(n) { return n == null ? null : parseFloat(n.toFixed(2)); }

function computeIndicators(ohlcv) {
  if (!ohlcv || ohlcv.length < 30) return null;
  const closes = ohlcv.map(d => d.close);
  const highs  = ohlcv.map(d => d.high);
  const lows   = ohlcv.map(d => d.low);
  const vols   = ohlcv.map(d => d.volume);

  // KD
  let prevK = 50, prevD = 50; const Ks = [], Ds = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < 8) { Ks.push(null); Ds.push(null); continue; }
    const sh = Math.max(...highs.slice(i - 8, i + 1)), sl = Math.min(...lows.slice(i - 8, i + 1));
    const rsv = sh === sl ? 50 : (closes[i] - sl) / (sh - sl) * 100;
    const k = (prevK * 2 + rsv) / 3, d = (prevD * 2 + k) / 3;
    Ks.push(k); Ds.push(d); prevK = k; prevD = d;
  }
  // MACD
  const ef = ema(closes, 12), es = ema(closes, 26);
  const dif = ef.map((v, i) => v != null && es[i] != null ? v - es[i] : null);
  const difC = dif.filter(v => v != null);
  const sig  = ema(difC, 9);
  const nullN = dif.filter(v => v == null).length;
  const macdL = Array(nullN).fill(null).concat(sig);
  const osc   = dif.map((v, i) => v != null && macdL[i] != null ? v - macdL[i] : null);
  // RSI
  function rsiCalc(n) {
    const r = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < n) { r.push(null); continue; }
      let g = 0, l = 0;
      for (let j = i - n + 1; j <= i; j++) { const d = closes[j] - closes[j-1]; if (d > 0) g += d; else l -= d; }
      r.push(l === 0 ? 100 : 100 - 100 / (1 + g/n/(l/n)));
    }
    return r;
  }
  // Bollinger
  const mid20 = sma(closes, 20); const bbU = [], bbL = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid20[i] == null) { bbU.push(null); bbL.push(null); continue; }
    const sl = closes.slice(i - 19, i + 1), m = mid20[i];
    const sd = Math.sqrt(sl.reduce((s, v) => s + (v - m) ** 2, 0) / 20);
    bbU.push(m + 2 * sd); bbL.push(m - 2 * sd);
  }
  // Volume ratio
  const recentVol = vols.slice(-6, -1);
  const avgVol    = recentVol.length ? recentVol.reduce((a, b) => a + b, 0) / recentVol.length : 1;
  const volRatio  = avgVol ? vols[vols.length - 1] / avgVol : 1;

  const K = last(Ks), D = last(Ds), prevK2 = Ks[Ks.length-2], prevD2 = Ds[Ds.length-2];
  const difV = last(dif), macdV = last(macdL), oscV = last(osc);
  const prevDif2 = dif[dif.length-2], prevMacd2 = macdL[macdL.length-2];

  let kdSig = 'hold';
  if (K!=null&&D!=null&&prevK2!=null&&prevD2!=null) {
    if (prevK2<=prevD2&&K>D) kdSig = K<20?'strong_buy':'buy';
    else if (prevK2>=prevD2&&K<D) kdSig = K>80?'strong_sell':'sell';
    else if (K<20) kdSig = 'oversold'; else if (K>80) kdSig = 'overbought';
  }
  let macdSig = 'hold';
  if (difV!=null&&macdV!=null&&prevDif2!=null&&prevMacd2!=null) {
    if (prevDif2<=prevMacd2&&difV>macdV) macdSig = 'golden_cross';
    else if (prevDif2>=prevMacd2&&difV<macdV) macdSig = 'death_cross';
    else if (oscV>0) macdSig = 'bullish'; else macdSig = 'bearish';
  }
  const ma5=last(sma(closes,5)),ma20=last(sma(closes,20)),ma60=last(sma(closes,60)),ma120=last(sma(closes,Math.min(120,closes.length)));
  let maArr = 'neutral';
  if (ma5&&ma20&&ma60&&ma120) {
    if (ma5>ma20&&ma20>ma60&&ma60>ma120) maArr='bull';
    else if (ma5<ma20&&ma20<ma60&&ma60<ma120) maArr='bear';
    else if (ma5>ma20) maArr='short_bull';
  }
  const rsi6=last(rsiCalc(6)),rsi12=last(rsiCalc(12)),rsi24=last(rsiCalc(24));
  const bbU_v=last(bbU),bbM_v=last(mid20),bbL_v=last(bbL);
  const close=closes[closes.length-1];
  let bbSig='mid';
  if (close>bbU_v) bbSig='above_upper'; else if (close<bbL_v) bbSig='below_lower';
  else if (close>bbM_v) bbSig='upper_half'; else bbSig='lower_half';

  let score=50;
  if (maArr==='bull') score+=15; else if (maArr==='short_bull') score+=8; else if (maArr==='bear') score-=15;
  if (macdSig==='golden_cross') score+=15; else if (macdSig==='bullish') score+=8;
  else if (macdSig==='death_cross') score-=15; else if (macdSig==='bearish') score-=8;
  if (kdSig==='strong_buy'||kdSig==='buy') score+=10; else if (kdSig==='strong_sell'||kdSig==='sell') score-=10;
  if (rsi6!=null) { if (rsi6<20) score+=8; else if (rsi6>80) score-=8; else if (rsi6>50) score+=3; }
  if (volRatio>=2) score+=8; else if (volRatio>=1.5) score+=4; else if (volRatio<0.5) score-=5;
  score=Math.max(0,Math.min(100,Math.round(score)));

  return {
    K:r2(K), D:r2(D), kdSignal:kdSig,
    dif:r2(difV), macd:r2(macdV), osc:r2(oscV), macdSignal:macdSig,
    rsi6:r2(rsi6), rsi12:r2(rsi12), rsi24:r2(rsi24),
    ma5:r2(ma5), ma20:r2(ma20), ma60:r2(ma60), ma120:r2(ma120), maArrangement:maArr,
    bbUpper:r2(bbU_v), bbMid:r2(bbM_v), bbLower:r2(bbL_v), bbSignal:bbSig,
    volRatio:r2(volRatio),
    score,
    history: {
      closes:  closes.slice(-60).map(v=>r2(v)),
      volumes: vols.slice(-60),
      dates:   ohlcv.slice(-60).map(d=>d.date)
    }
  };
}

// ─── 主程式 ───────────────────────────────────────
async function main() {
  console.log(`\n📊 開始更新股票資料：${SYMBOLS.join(', ')}`);
  const output = { stocks: {}, market: {}, updatedAt: new Date().toISOString() };

  // 大盤
  const indices = [
    ['^TWII','台股 TAIEX'], ['^GSPC','S&P 500'],
    ['^IXIC','NASDAQ'],     ['^VIX','VIX']
  ];
  for (const [sym, name] of indices) {
    try {
      output.market[sym] = await fetchIndex(sym, name);
      console.log(`  ✓ ${name}`);
    } catch (e) { console.warn(`  ✗ ${name}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 800));
  }

  // 個股
  for (const sym of SYMBOLS) {
    try {
      console.log(`  ⟳ 抓取 ${sym}...`);
      const raw = await fetchYahoo(sym);
      const ind = computeIndicators(raw.ohlcv);
      // 不儲存完整 OHLCV（減少檔案大小）
      const { ohlcv, ...meta } = raw;
      output.stocks[sym] = { ...meta, indicators: ind };
      console.log(`  ✓ ${sym} — ${raw.name} 收盤 ${raw.price} 評分 ${ind?.score}`);
    } catch (e) {
      console.warn(`  ✗ ${sym}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ 已寫入 ${OUTPUT}`);
  console.log(`   股票：${Object.keys(output.stocks).length} 支`);
  console.log(`   指數：${Object.keys(output.market).length} 個`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
