// pure Javascript implementation of core technical analysis indicators
// for maximum speed, portability, and zero external dependency footprint.

// SMA (Simple Moving Average)
function calculateSMA(prices, period) {
  const sma = new Array(prices.length).fill(null);
  if (prices.length < period) return sma;
  
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  sma[period - 1] = sum / period;
  
  for (let i = period; i < prices.length; i++) {
    sum = sum - prices[i - period] + prices[i];
    sma[i] = sum / period;
  }
  return sma;
}

// EMA (Exponential Moving Average)
function calculateEMA(prices, period) {
  const ema = new Array(prices.length).fill(null);
  if (prices.length < period) return ema;
  
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  let currentEma = sum / period;
  ema[period - 1] = currentEma;
  
  for (let i = period; i < prices.length; i++) {
    currentEma = prices[i] * k + currentEma * (1 - k);
    ema[i] = currentEma;
  }
  return ema;
}

// Standard Deviation
function calculateStdDev(prices, sma, period) {
  const stdDev = new Array(prices.length).fill(null);
  if (prices.length < period) return stdDev;
  
  for (let i = period - 1; i < prices.length; i++) {
    const currentSma = sma[i];
    let varianceSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      varianceSum += Math.pow(prices[j] - currentSma, 2);
    }
    stdDev[i] = Math.sqrt(varianceSum / period);
  }
  return stdDev;
}

// RSI (Relative Strength Index)
function calculateRSI(prices, period = 14) {
  const rsi = new Array(prices.length).fill(null);
  if (prices.length < period + 1) return rsi;
  
  let gains = 0;
  let losses = 0;
  
  // First RSI value
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    let gain = 0;
    let loss = 0;
    if (diff > 0) gain = diff;
    else loss = -diff;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// MACD (Moving Average Convergence Divergence)
function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const macd = new Array(prices.length).fill(null);
  const signal = new Array(prices.length).fill(null);
  const hist = new Array(prices.length).fill(null);
  
  if (prices.length < slowPeriod) return { macd, signal, hist };
  
  const fastEma = calculateEMA(prices, fastPeriod);
  const slowEma = calculateEMA(prices, slowPeriod);
  
  const macdValues = [];
  for (let i = 0; i < prices.length; i++) {
    if (fastEma[i] !== null && slowEma[i] !== null) {
      macd[i] = fastEma[i] - slowEma[i];
      macdValues.push(macd[i]);
    } else {
      macd[i] = null;
      macdValues.push(0); // placeholder for aligning indices
    }
  }
  
  // Calculate Signal line which is EMA of MACD
  // Need to account for leading null values
  const nonNullStartIdx = macd.findIndex(v => v !== null);
  const validMacdPart = macdValues.slice(nonNullStartIdx);
  const validSignalPart = calculateEMA(validMacdPart, signalPeriod);
  
  for (let i = 0; i < prices.length; i++) {
    if (i >= nonNullStartIdx + signalPeriod - 1) {
      signal[i] = validSignalPart[i - nonNullStartIdx];
      hist[i] = macd[i] - signal[i];
    }
  }
  
  return { macd, signal, hist };
}

// Bollinger Bands
function calculateBB(prices, period = 20, multiplier = 2) {
  const middle = calculateSMA(prices, period);
  const stdDev = calculateStdDev(prices, middle, period);
  
  const upper = new Array(prices.length).fill(null);
  const lower = new Array(prices.length).fill(null);
  const width = new Array(prices.length).fill(null);
  const pctB = new Array(prices.length).fill(null);
  
  for (let i = 0; i < prices.length; i++) {
    if (middle[i] !== null && stdDev[i] !== null) {
      upper[i] = middle[i] + multiplier * stdDev[i];
      lower[i] = middle[i] - multiplier * stdDev[i];
      width[i] = (upper[i] - lower[i]) / middle[i];
      pctB[i] = upper[i] === lower[i] ? 0.5 : (prices[i] - lower[i]) / (upper[i] - lower[i]);
    }
  }
  
  return { upper, middle, lower, width, pctB };
}

// VWAP (Volume Weighted Average Price)
// For rolling 100-candle lookback since we ingest streaming data
function calculateVWAP(candles, period = 100) {
  const vwap = new Array(candles.length).fill(null);
  if (candles.length < 1) return vwap;

  for (let i = 0; i < candles.length; i++) {
    const startIdx = Math.max(0, i - period + 1);
    let pvSum = 0;
    let volSum = 0;
    for (let j = startIdx; j <= i; j++) {
      const c = candles[j];
      const typicalPrice = (c.high + c.low + c.close) / 3;
      pvSum += typicalPrice * c.volume;
      volSum += c.volume;
    }
    vwap[i] = volSum === 0 ? candles[i].close : pvSum / volSum;
  }
  return vwap;
}

// ATR (Average True Range)
function calculateATR(candles, period = 14) {
  const atr = new Array(candles.length).fill(null);
  if (candles.length < 2) return atr;

  const tr = new Array(candles.length).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const h_l = candles[i].high - candles[i].low;
    const h_pc = Math.abs(candles[i].high - candles[i - 1].close);
    const l_pc = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(h_l, h_pc, l_pc);
  }

  // Initial ATR is simple average of TRs
  let trSum = 0;
  for (let i = 0; i < period; i++) {
    trSum += tr[i];
  }
  atr[period - 1] = trSum / period;

  // Smoothing ATR
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// ADX (Average Directional Index) using Wilder's smoothing
function calculateADX(candles, period = 14) {
  const adx = new Array(candles.length).fill(null);
  if (candles.length < period * 2) return adx;

  const tr = new Array(candles.length).fill(0);
  const plusDM = new Array(candles.length).fill(0);
  const minusDM = new Array(candles.length).fill(0);

  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    const h_l = c.high - c.low;
    const h_pc = Math.abs(c.high - prev.close);
    const l_pc = Math.abs(c.low - prev.close);
    tr[i] = Math.max(h_l, h_pc, l_pc);

    const upMove = c.high - prev.high;
    const downMove = prev.low - c.low;

    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }

  const smoothedTR = new Array(candles.length).fill(null);
  const smoothedPlusDM = new Array(candles.length).fill(null);
  const smoothedMinusDM = new Array(candles.length).fill(null);

  let trSum = 0;
  let plusDMSum = 0;
  let minusDMSum = 0;

  for (let i = 0; i < period; i++) {
    trSum += tr[i];
    plusDMSum += plusDM[i];
    minusDMSum += minusDM[i];
  }

  smoothedTR[period - 1] = trSum;
  smoothedPlusDM[period - 1] = plusDMSum;
  smoothedMinusDM[period - 1] = minusDMSum;

  for (let i = period; i < candles.length; i++) {
    smoothedTR[i] = smoothedTR[i - 1] - (smoothedTR[i - 1] / period) + tr[i];
    smoothedPlusDM[i] = smoothedPlusDM[i - 1] - (smoothedPlusDM[i - 1] / period) + plusDM[i];
    smoothedMinusDM[i] = smoothedMinusDM[i - 1] - (smoothedMinusDM[i - 1] / period) + minusDM[i];
  }

  const dx = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const trVal = smoothedTR[i];
    if (trVal === 0) {
      dx[i] = 0;
      continue;
    }
    const plusDI = 100 * (smoothedPlusDM[i] / trVal);
    const minusDI = 100 * (smoothedMinusDM[i] / trVal);
    const sum = plusDI + minusDI;
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sum;
  }

  let dxSum = 0;
  for (let i = period - 1; i < period * 2 - 1; i++) {
    dxSum += dx[i];
  }
  adx[period * 2 - 2] = dxSum / period;

  for (let i = period * 2 - 1; i < candles.length; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }

  return adx;
}

// Main processing function: Computes all indicators and strategy votes
function computeTechnicalData(candles) {
  if (!candles || candles.length < 200) {
    return null; // Force standby if history is insufficient
  }

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const rsi = calculateRSI(closes, 14);
  const rsi7 = calculateRSI(closes, 7);
  const rsi21 = calculateRSI(closes, 21);
  const macdObj = calculateMACD(closes);
  const bbObj = calculateBB(closes);
  const vwap = calculateVWAP(candles, 100);
  const atr = calculateATR(candles, 14);
  
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  
  const volSma20 = calculateSMA(volumes, 20);
  const adx = calculateADX(candles, 14);
  const sma50 = calculateSMA(closes, 50);

  // Custom safe SMA of ATR over 20 periods
  const atrSma20 = new Array(atr.length).fill(null);
  for (let i = 0; i < atr.length; i++) {
    const start = Math.max(0, i - 20 + 1);
    let sum = 0;
    let count = 0;
    for (let j = start; j <= i; j++) {
      if (atr[j] !== null && !isNaN(atr[j])) {
        sum += atr[j];
        count++;
      }
    }
    atrSma20[i] = count > 0 ? sum / count : null;
  }

  // Map indicators to candles
  const results = candles.map((c, i) => {
    const isReady = i >= 200; // Require 200 candles for full indicators
    
    // Core features with NaN and null safety guards
    const rawRsi = rsi[i];
    const rsiVal = (rawRsi === null || isNaN(rawRsi)) ? 50.0 : rawRsi;

    const rawMacd = macdObj.macd[i];
    const macdVal = (rawMacd === null || isNaN(rawMacd)) ? 0.0 : rawMacd;

    const rawSignal = macdObj.signal[i];
    const macdSignal = (rawSignal === null || isNaN(rawSignal)) ? 0.0 : rawSignal;

    const rawHist = macdObj.hist[i];
    const macdHist = (rawHist === null || isNaN(rawHist)) ? 0.0 : rawHist;

    const rawBbUpper = bbObj.upper[i];
    const bbUpper = (rawBbUpper === null || isNaN(rawBbUpper)) ? c.close : rawBbUpper;

    const rawBbMiddle = bbObj.middle[i];
    const bbMiddle = (rawBbMiddle === null || isNaN(rawBbMiddle)) ? c.close : rawBbMiddle;

    const rawBbLower = bbObj.lower[i];
    const bbLower = (rawBbLower === null || isNaN(rawBbLower)) ? c.close : rawBbLower;

    const rawBbWidth = bbObj.width[i];
    const bbWidth = (rawBbWidth === null || isNaN(rawBbWidth)) ? 0.0 : rawBbWidth;

    const rawBbPctB = bbObj.pctB[i];
    const bbPctB = (rawBbPctB === null || isNaN(rawBbPctB)) ? 0.5 : rawBbPctB;

    const rawVwap = vwap[i];
    const vwapVal = (rawVwap === null || isNaN(rawVwap)) ? c.close : rawVwap;

    const rawAtr = atr[i];
    const atrVal = (rawAtr === null || isNaN(rawAtr)) ? 0.0 : rawAtr;

    const rawE20 = ema20[i];
    const e20 = (rawE20 === null || isNaN(rawE20)) ? c.close : rawE20;

    const rawE50 = ema50[i];
    const e50 = (rawE50 === null || isNaN(rawE50)) ? c.close : rawE50;

    const rawE200 = ema200[i];
    const e200 = (rawE200 === null || isNaN(rawE200)) ? c.close : rawE200;

    // Candle structure features
    const bodySize = c.open === 0 ? 0 : Math.abs(c.close - c.open) / c.open;
    const upperWick = c.open === 0 ? 0 : (c.high - Math.max(c.open, c.close)) / c.open;
    const lowerWick = c.open === 0 ? 0 : (Math.min(c.open, c.close) - c.low) / c.open;
    const volumeRatio = volSma20[i] && volSma20[i] !== 0 ? c.volume / volSma20[i] : 1.0;

    // Technical Strategy Votes (Only vote if features are ready)
    let rsiVote = 0;
    if (isReady) {
      if (rsiVal < 30) rsiVote = 1;      // Oversold (BUY)
      else if (rsiVal > 70) rsiVote = -1; // Overbought (SELL)
    }

    let macdVote = 0;
    if (isReady && i > 0 && macdObj.hist[i - 1] !== null) {
      const prevHist = (macdObj.hist[i - 1] === null || isNaN(macdObj.hist[i - 1])) ? 0.0 : macdObj.hist[i - 1];
      if (prevHist < 0 && macdHist > 0) macdVote = 1;     // Golden cross (BUY)
      else if (prevHist > 0 && macdHist < 0) macdVote = -1; // Death cross (SELL)
    }

    let bbVote = 0;
    if (isReady) {
      if (c.close < bbLower) bbVote = 1;       // Band breakout down (BUY)
      else if (c.close > bbUpper) bbVote = -1;  // Band breakout up (SELL)
    }

    let emaVote = 0;
    if (isReady && i > 0 && ema20[i - 1] !== null && ema50[i - 1] !== null) {
      const prevE20 = (ema20[i - 1] === null || isNaN(ema20[i - 1])) ? c.close : ema20[i - 1];
      const prevE50 = (ema50[i - 1] === null || isNaN(ema50[i - 1])) ? c.close : ema50[i - 1];
      const prevDiff = prevE20 - prevE50;
      const currDiff = e20 - e50;
      if (prevDiff < 0 && currDiff > 0) emaVote = 1;     // EMA 20 crossing EMA 50 up (BUY)
      else if (prevDiff > 0 && currDiff < 0) emaVote = -1; // EMA 20 crossing EMA 50 down (SELL)
    }

    let vwapVote = 0;
    if (isReady) {
      if (c.close > vwapVal && c.open < vwapVal) vwapVote = 1;     // Cross above VWAP (BUY)
      else if (c.close < vwapVal && c.open > vwapVal) vwapVote = -1; // Cross below VWAP (SELL)
    }

    // Regime Classification
    const adxVal = adx[i];
    const atrSmaVal = atrSma20[i] || atrVal;

    let regime = 'NEUTRAL';
    if (isReady && adxVal !== null && !isNaN(adxVal)) {
      if (atrVal > atrSmaVal * 1.4) {
        regime = 'VOLATILE';
      } else if (adxVal > 25) {
        regime = 'TRENDING';
      } else if (adxVal < 20) {
        regime = 'RANGING';
      }
    }

    return {
      ...c,
      isReady,
      rsi: rsiVal,
      rsi7: (rsi7[i] === null || isNaN(rsi7[i])) ? 50.0 : rsi7[i],
      rsi21: (rsi21[i] === null || isNaN(rsi21[i])) ? 50.0 : rsi21[i],
      macd: macdVal,
      macdSignal,
      macdHist,
      bbUpper,
      bbMiddle,
      bbLower,
      bbWidth,
      bbPctB,
      vwap: vwapVal,
      atr: atrVal,
      ema20: e20,
      ema50: e50,
      ema200: e200,
      priceAboveEma50: isReady && c.close > e50,
      sma50: (sma50[i] === null || isNaN(sma50[i])) ? c.close : sma50[i],
      bodySize,
      upperWick,
      lowerWick,
      volumeRatio,
      adx: adxVal || 0.0,
      regime,
      votes: {
        rsi: rsiVote,
        macd: macdVote,
        bb: bbVote,
        ema: emaVote,
        vwap: vwapVote
      }
    };
  });

  return results;
}

// Generate the 40+ feature vector object for a specific candle index
// We extract indicators and rolling lags of close, high, low, volume, rsi, MACD, etc.
function extractFeatureVector(computedCandles, index, sentimentScore = 0.0, fearGreed = 50) {
  if (index < 30 || index >= computedCandles.length) return null;

  const current = computedCandles[index];
  
  // Basic features (16 features)
  const features = {
    open: current.open,
    high: current.high,
    low: current.low,
    close: current.close,
    volume: current.volume,
    rsi: current.rsi || 50,
    rsi7: current.rsi7 || 50,
    rsi21: current.rsi21 || 50,
    macd: current.macd || 0,
    macdSignal: current.macdSignal || 0,
    macdHist: current.macdHist || 0,
    bbWidth: current.bbWidth || 0,
    bbPctB: current.bbPctB || 0.5,
    vwapRatio: current.vwap ? current.close / current.vwap : 1.0,
    emaSpread20_50: (current.ema20 && current.ema50) ? (current.ema20 - current.ema50) / current.close : 0.0,
    emaSpread50_200: (current.ema50 && current.ema200) ? (current.ema50 - current.ema200) / current.close : 0.0,
    bodySize: current.bodySize,
    upperWick: current.upperWick,
    lowerWick: current.lowerWick,
    volumeRatio: current.volumeRatio,
    sentiment: sentimentScore,
    fearGreed: fearGreed
  };

  // Add lag features (previous candles) to make it 40+ features
  for (let lag = 1; lag <= 5; lag++) {
    const prev = computedCandles[index - lag] || current;
    
    // Percent returns for lags
    features[`return_lag_${lag}`] = (current.close - prev.close) / prev.close;
    
    // Close / Indicator ratios for lags
    features[`rsi_lag_${lag}`] = prev.rsi || 50;
    features[`macd_hist_lag_${lag}`] = prev.macdHist || 0;
    features[`vol_ratio_lag_${lag}`] = prev.volumeRatio || 1.0;
    features[`body_size_lag_${lag}`] = prev.bodySize || 0.0;
  }

  return features;
}

module.exports = {
  computeTechnicalData,
  extractFeatureVector
};
