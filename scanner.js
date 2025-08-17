const fetch = require('node-fetch');

// Constants from HC.html
const BATCH_SIZE = 120;
const BATCH_DELAY_MS = 10;
const CURR_N = 15;   // current window size
const PREV_N = 15;   // previous window size
const SLOPE_N = 60;  // slope window
const BASE_N = 240;  // baseline window
const EPS = 1e-9;

// Utility functions extracted from HC.html
const sleep = ms => new Promise(res => setTimeout(res, ms));

const chunk = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

async function fetchJSON(url, { retries = 2, timeoutMs = 15000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(url, { 
        signal: ctrl.signal, 
        headers: { 'Accept': 'application/json' } 
      });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      return data;
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
}

function computeMetrics(candles) {
  let sumOC = 0, sumHL = 0, count = 0;
  for (const c of candles) {
    const open = parseFloat(c[1]);
    const high = parseFloat(c[2]);
    const low = parseFloat(c[3]);
    const close = parseFloat(c[4]);
    if (!isFinite(open) || !isFinite(close) || !isFinite(high) || !isFinite(low) || open === 0) continue;
    const oc = Math.abs((close - open) / open) * 100;
    const hl = ((high - low) / open) * 100;
    sumOC += oc;
    sumHL += hl;
    count++;
  }
  const avgOc = count ? sumOC / count : 0;
  const avgHl = count ? sumHL / count : 0;
  return { avgOc, avgHl, count };
}

function ocSeriesFromCandles(candles, maxLen = BASE_N + 60) {
  if (!candles || !candles.length) return [];
  // Determine order by timestamp and ensure chronological ascending
  const arr = candles.slice(0, maxLen).map(c => [Number(c[0]), c]);
  if (arr.length >= 2 && arr[0][0] > arr[1][0]) arr.reverse();
  const series = [];
  for (const [, c] of arr) {
    const o = parseFloat(c[1]), h = parseFloat(c[2]), l = parseFloat(c[3]), cl = parseFloat(c[4]);
    if (!isFinite(o) || !isFinite(cl) || o === 0) continue;
    const oc = Math.abs((cl - o) / o) * 100;
    series.push(oc);
  }
  return series.slice(-maxLen); // cap length
}

function mean(xs) { 
  if (!xs.length) return 0; 
  return xs.reduce((a, b) => a + b, 0) / xs.length; 
}

function variance(xs, m) {
  if (xs.length <= 1) return 0;
  const mu = (m != null) ? m : mean(xs);
  return xs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (xs.length - 1);
}

function stddev(xs, m) { 
  return Math.sqrt(variance(xs, m)); 
}

function slopeOLS(xs) {
  // xs chronological; slope over last SLOPE_N (or fewer if not enough)
  const n = Math.min(xs.length, SLOPE_N);
  if (n < 3) return 0;
  const start = xs.length - n;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i; // 0..n-1
    const y = xs[start + i];
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < EPS) return 0;
  const b1 = (n * sumXY - sumX * sumY) / denom;
  return b1;
}

async function getSymbols() {
  const tickersUrl = 'https://api.bybit.com/v5/market/tickers?category=linear';
  const tData = await fetchJSON(tickersUrl);
  if (tData.retCode !== 0) throw new Error('Tickers error: ' + tData.retMsg);
  const all = (tData.result?.list || [])
    .map(x => x.symbol)
    .filter(sym => typeof sym === 'string' && sym.endsWith('USDT'));
  const uniq = [...new Set(all)];
  return uniq;
}

async function getDelistingSet() {
  const instUrl = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000';
  const data = await fetchJSON(instUrl);
  if (data.retCode !== 0) throw new Error('Instruments error: ' + data.retMsg);
  const list = data.result?.list || [];
  const delist = new Set(list.filter(x => Number(x.deliveryTime) > 0).map(x => x.symbol));
  return delist;
}

async function fetchKlines(symbol, interval) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=1000`;
  const data = await fetchJSON(url);
  if (data.retCode !== 0) throw new Error(`${symbol}(${interval}m): ${data.retMsg}`);
  return data.result?.list || [];
}

function buildSignalStats(symbol, ocSeries1) {
  const n = ocSeries1.length;
  if (n < CURR_N + PREV_N + 5) return null;

  const base = ocSeries1.slice(-BASE_N);
  const baseMean = mean(base);
  const baseStd = stddev(base, baseMean);

  const curr = mean(ocSeries1.slice(-CURR_N));
  const prev = mean(ocSeries1.slice(-(CURR_N + PREV_N), -CURR_N));
  const zCurr = baseStd > EPS ? (curr - baseMean) / baseStd : (baseMean > EPS ? (curr / baseMean - 1) / 0.1 : 0);
  const zPrev = baseStd > EPS ? (prev - baseMean) / baseStd : (baseMean > EPS ? (prev / baseMean - 1) / 0.1 : 0);
  const slope = slopeOLS(ocSeries1);

  return {
    symbol,
    ocSeries1,
    stats: {
      curr, prev, baseMean, baseStd,
      zCurr, zPrev, slope,
      ratio: curr / Math.max(prev, EPS),
      drop: Math.max(prev - curr, 0)
    }
  };
}

function detectSignals(signalRows) {
  // Hot now: highest zCurr
  const hot = signalRows
    .filter(r => Number.isFinite(r.stats.zCurr))
    .sort((a, b) => b.stats.zCurr - a.stats.zCurr)[0];

  // Rising: positive slope and curr > prev, rank by slope * zCurr
  const rising = signalRows
    .filter(r => r.stats.slope > 0 && r.stats.curr > r.stats.prev)
    .sort((a, b) => (b.stats.slope * (b.stats.zCurr || 0)) - (a.stats.slope * (a.stats.zCurr || 0)))[0];

  // Cooling off: big drop and previously elevated (zPrev high), negative slope; rank by normalized drop
  const cooling = signalRows
    .filter(r => r.stats.prev > r.stats.curr && r.stats.zPrev > 1.5 && r.stats.slope < 0)
    .map(r => ({ ...r, score: (r.stats.prev - r.stats.curr) / Math.max(r.stats.baseStd, EPS) }))
    .sort((a, b) => b.score - a.score)[0];

  return {
    hotNow: hot ? {
      symbol: hot.symbol,
      current: hot.stats.curr,
      zScore: hot.stats.zCurr,
      slope: hot.stats.slope
    } : null,
    rising: rising ? {
      symbol: rising.symbol,
      ratio: rising.stats.curr / Math.max(rising.stats.prev, EPS),
      slope: rising.stats.slope,
      zScore: rising.stats.zCurr
    } : null,
    coolingOff: cooling ? {
      symbol: cooling.symbol,
      drop: cooling.stats.prev - cooling.stats.curr,
      prevZScore: cooling.stats.zPrev,
      slope: cooling.stats.slope
    } : null
  };
}

async function scanSymbols() {
  const symbols = await getSymbols();
  const delistSet = await getDelistingSet();
  const filtered = symbols.filter(s => !delistSet.has(s));
  const batches = chunk(filtered, BATCH_SIZE);

  const signalRows = [];
  let errors = 0;

  async function trackedFetch(symbol, interval) {
    try {
      const data = await fetchKlines(symbol, interval);
      return { ok: true, data };
    } catch (e) {
      errors++;
      return { ok: false, err: e };
    }
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const promises = batch.map(async (symbol) => {
      // Fetch all timeframes like original HC.html
      const [r1, r3, r5, r15] = await Promise.all([
        trackedFetch(symbol, 1),
        trackedFetch(symbol, 3),
        trackedFetch(symbol, 5),
        trackedFetch(symbol, 15),
      ]);

      const m1 = r1.ok ? computeMetrics(r1.data) : { avgOc: 0, avgHl: 0, count: 0 };
      const m3 = r3.ok ? computeMetrics(r3.data) : { avgOc: 0, avgHl: 0, count: 0 };
      const m5 = r5.ok ? computeMetrics(r5.data) : { avgOc: 0, avgHl: 0, count: 0 };
      const m15 = r15.ok ? computeMetrics(r15.data) : { avgOc: 0, avgHl: 0, count: 0 };

      // Build 1m OC% series for signals (like original)
      let ocSeries1 = [];
      if (r1.ok) {
        ocSeries1 = ocSeriesFromCandles(r1.data, BASE_N + SLOPE_N);
      }

      if (!m1.count && !m3.count && !m5.count && !m15.count) {
        return;
      }

      // We don't need to store the full row data, just process for signals

      // Prepare signal stats if enough 1m data
      const statRow = buildSignalStats(symbol, ocSeries1);
      if (statRow) {
        signalRows.push(statRow);
      }

      // No need to calculate combined metrics since we're not logging them
    });

    await Promise.all(promises);
    if (i < batches.length - 1) await sleep(BATCH_DELAY_MS);
  }

  return detectSignals(signalRows);
}

module.exports = { scanSymbols };
