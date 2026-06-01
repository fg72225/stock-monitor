// ═══════════════════════════════════════════════════
//  indicators.js — 技術指標自動計算引擎
//  KD / MACD / RSI / 布林通道 / 均線
// ═══════════════════════════════════════════════════

const Indicators = {

  // ─── 簡單移動平均 ───────────────────────────────
  sma(arr, period) {
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      const sum = arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
    return result;
  },

  // ─── 指數移動平均 ───────────────────────────────
  ema(arr, period) {
    const k = 2 / (period + 1);
    const result = [];
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === null) { result.push(null); continue; }
      if (prev === null) {
        if (i < period - 1) { result.push(null); continue; }
        prev = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
        result.push(prev); continue;
      }
      prev = arr[i] * k + prev * (1 - k);
      result.push(prev);
    }
    return result;
  },

  // ─── KD 隨機指標 (RSV → K → D) ─────────────────
  kd(highs, lows, closes, period = 9, kSmooth = 3, dSmooth = 3) {
    const K = [], D = [], RSV = [];
    let prevK = 50, prevD = 50;
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) { K.push(null); D.push(null); RSV.push(null); continue; }
      const sliceH = highs.slice(i - period + 1, i + 1);
      const sliceL = lows.slice(i - period + 1, i + 1);
      const hh = Math.max(...sliceH), ll = Math.min(...sliceL);
      const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
      RSV.push(rsv);
      const k = (prevK * (kSmooth - 1) + rsv) / kSmooth;
      const d = (prevD * (dSmooth - 1) + k) / dSmooth;
      K.push(k); D.push(d);
      prevK = k; prevD = d;
    }
    return { K, D, RSV };
  },

  // ─── MACD ───────────────────────────────────────
  macd(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = this.ema(closes, fast);
    const emaSlow = this.ema(closes, slow);
    const dif = emaFast.map((v, i) => (v !== null && emaSlow[i] !== null) ? v - emaSlow[i] : null);
    const difClean = dif.filter(v => v !== null);
    const sigLine = this.ema(difClean, signal);
    // 補回 null 對齊
    const nullCount = dif.filter(v => v === null).length;
    const macdLine = Array(nullCount).fill(null).concat(sigLine);
    const osc = dif.map((v, i) => (v !== null && macdLine[i] !== null) ? v - macdLine[i] : null);
    return { dif, macd: macdLine, osc };
  },

  // ─── RSI ────────────────────────────────────────
  rsi(closes, period = 14) {
    const result = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < period) { result.push(null); continue; }
      let gains = 0, losses = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const diff = closes[j] - closes[j - 1];
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const avgGain = gains / period, avgLoss = losses / period;
      if (avgLoss === 0) { result.push(100); continue; }
      const rs = avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
    return result;
  },

  // ─── 布林通道 ────────────────────────────────────
  bollinger(closes, period = 20, stdDev = 2) {
    const mid = this.sma(closes, period);
    const upper = [], lower = [];
    for (let i = 0; i < closes.length; i++) {
      if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = mid[i];
      const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
      const sd = Math.sqrt(variance);
      upper.push(mean + stdDev * sd);
      lower.push(mean - stdDev * sd);
    }
    return { upper, mid, lower };
  },

  // ─── 量比 ────────────────────────────────────────
  volumeRatio(volumes, period = 5) {
    if (!volumes || volumes.length < period + 1) return null;
    const recent = volumes.slice(-period - 1, -1);
    const avg = recent.reduce((a, b) => a + b, 0) / period;
    const today = volumes[volumes.length - 1];
    return avg === 0 ? 0 : today / avg;
  },

  // ─── 取最後一個非 null 值 ────────────────────────
  last(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null) return arr[i];
    }
    return null;
  },

  // ─── 主計算入口：給定 OHLCV 陣列，回傳所有指標 ──
  compute(ohlcv) {
    if (!ohlcv || ohlcv.length < 30) return null;
    const opens   = ohlcv.map(d => d.open);
    const highs   = ohlcv.map(d => d.high);
    const lows    = ohlcv.map(d => d.low);
    const closes  = ohlcv.map(d => d.close);
    const volumes = ohlcv.map(d => d.volume);

    const kdResult   = this.kd(highs, lows, closes);
    const macdResult = this.macd(closes);
    const boll       = this.bollinger(closes);

    const K = this.last(kdResult.K);
    const D = this.last(kdResult.D);
    const prevK = kdResult.K[kdResult.K.length - 2];
    const prevD = kdResult.D[kdResult.D.length - 2];

    const dif  = this.last(macdResult.dif);
    const macd = this.last(macdResult.macd);
    const osc  = this.last(macdResult.osc);
    const prevOsc = macdResult.osc[macdResult.osc.length - 2];

    const rsi6  = this.last(this.rsi(closes, 6));
    const rsi12 = this.last(this.rsi(closes, 12));
    const rsi24 = this.last(this.rsi(closes, 24));

    const ma5   = this.last(this.sma(closes, 5));
    const ma10  = this.last(this.sma(closes, 10));
    const ma20  = this.last(this.sma(closes, 20));
    const ma60  = this.last(this.sma(closes, 60));
    const ma120 = this.last(this.sma(closes, 120));

    const bbUpper = this.last(boll.upper);
    const bbMid   = this.last(boll.mid);
    const bbLower = this.last(boll.lower);

    const volRatio = this.volumeRatio(volumes);
    const close = closes[closes.length - 1];

    // ─ KD 訊號 ─
    let kdSignal = 'hold';
    if (K !== null && D !== null && prevK !== null && prevD !== null) {
      if (prevK <= prevD && K > D) kdSignal = K < 20 ? 'strong_buy' : 'buy';
      else if (prevK >= prevD && K < D) kdSignal = K > 80 ? 'strong_sell' : 'sell';
      else if (K < 20) kdSignal = 'oversold';
      else if (K > 80) kdSignal = 'overbought';
    }

    // ─ MACD 訊號 ─
    let macdSignal = 'hold';
    if (dif !== null && macd !== null) {
      const prevDif  = macdResult.dif[macdResult.dif.length - 2];
      const prevMacd = macdResult.macd[macdResult.macd.length - 2];
      if (prevDif !== null && prevMacd !== null) {
        if (prevDif <= prevMacd && dif > macd) macdSignal = 'golden_cross';
        else if (prevDif >= prevMacd && dif < macd) macdSignal = 'death_cross';
        else if (osc > 0 && prevOsc < osc) macdSignal = 'bullish';
        else if (osc < 0 && prevOsc > osc) macdSignal = 'bearish';
      }
    }

    // ─ 布林訊號 ─
    let bbSignal = 'mid';
    if (close > bbUpper) bbSignal = 'above_upper';
    else if (close < bbLower) bbSignal = 'below_lower';
    else if (close > bbMid) bbSignal = 'upper_half';
    else bbSignal = 'lower_half';

    // ─ 均線排列 ─
    let maArrangement = 'neutral';
    if (ma5 && ma20 && ma60 && ma120) {
      if (ma5 > ma20 && ma20 > ma60 && ma60 > ma120) maArrangement = 'bull';
      else if (ma5 < ma20 && ma20 < ma60 && ma60 < ma120) maArrangement = 'bear';
      else if (ma5 > ma20) maArrangement = 'short_bull';
    }

    // ─ AI 綜合評分 ─
    let score = 50;
    if (maArrangement === 'bull') score += 15;
    else if (maArrangement === 'short_bull') score += 8;
    else if (maArrangement === 'bear') score -= 15;
    if (macdSignal === 'golden_cross') score += 15;
    else if (macdSignal === 'bullish') score += 8;
    else if (macdSignal === 'death_cross') score -= 15;
    else if (macdSignal === 'bearish') score -= 8;
    if (kdSignal === 'strong_buy' || kdSignal === 'buy') score += 10;
    else if (kdSignal === 'strong_sell' || kdSignal === 'sell') score -= 10;
    if (rsi6 !== null) {
      if (rsi6 < 20) score += 8;
      else if (rsi6 > 80) score -= 8;
      else if (rsi6 > 50) score += 3;
    }
    if (volRatio !== null) {
      if (volRatio >= 2) score += 8;
      else if (volRatio >= 1.5) score += 4;
      else if (volRatio < 0.5) score -= 5;
    }
    if (bbSignal === 'above_upper') score -= 5;
    else if (bbSignal === 'below_lower') score += 5;
    score = Math.max(0, Math.min(100, Math.round(score)));

    return {
      close, opens, highs, lows, closes, volumes,
      K, D, kdSignal,
      dif, macd, osc, macdSignal,
      rsi6, rsi12, rsi24,
      ma5, ma10, ma20, ma60, ma120, maArrangement,
      bbUpper, bbMid, bbLower, bbSignal,
      volRatio,
      score,
      history: { closes: closes.slice(-60), volumes: volumes.slice(-60) }
    };
  }
};
