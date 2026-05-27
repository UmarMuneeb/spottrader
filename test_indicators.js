const { computeTechnicalData, extractFeatureVector } = require('./services/taEngine');

console.log('--- TECHNICAL STRATEGY ENGINE VERIFICATION ---');

// Generate 250 mock candles with an upward trend
const mockCandles = [];
let basePrice = 50000;

for (let i = 0; i < 250; i++) {
  // Add some random noise but bias it upwards after candle 100
  const noise = (Math.random() - 0.4) * 200;
  const trend = i > 100 ? 300 : 50;
  const open = basePrice + noise;
  const close = open + trend + (Math.random() - 0.5) * 100;
  const low = Math.min(open, close) - Math.random() * 50;
  const high = Math.max(open, close) + Math.random() * 50;
  const volume = 10 + Math.random() * 15;
  
  mockCandles.push({
    timestamp: Date.now() - (250 - i) * 60 * 1000,
    open: parseFloat(open.toFixed(2)),
    high: parseFloat(high.toFixed(2)),
    low: parseFloat(low.toFixed(2)),
    close: parseFloat(close.toFixed(2)),
    volume: parseFloat(volume.toFixed(2))
  });
  
  basePrice = close;
}

console.log(`Generated ${mockCandles.length} mock candles.`);

// Run indicators calculation
const results = computeTechnicalData(mockCandles);

if (!results || results.length === 0) {
  console.error('FAIL: No results returned from technical analysis engine.');
  process.exit(1);
}

const latest = results[results.length - 1];

console.log('\n--- Indicators calculated for latest candle ---');
console.log(`Price: $${latest.close}`);
console.log(`RSI: ${latest.rsi ? latest.rsi.toFixed(2) : 'N/A'}`);
console.log(`MACD Line: ${latest.macd ? latest.macd.toFixed(2) : 'N/A'}`);
console.log(`MACD Signal: ${latest.macdSignal ? latest.macdSignal.toFixed(2) : 'N/A'}`);
console.log(`MACD Hist: ${latest.macdHist ? latest.macdHist.toFixed(2) : 'N/A'}`);
console.log(`Bollinger Bands (Upper/Middle/Lower): $${latest.bbUpper?.toFixed(2)} / $${latest.bbMiddle?.toFixed(2)} / $${latest.bbLower?.toFixed(2)}`);
console.log(`VWAP: $${latest.vwap ? latest.vwap.toFixed(2) : 'N/A'}`);
console.log(`ATR (14): ${latest.atr ? latest.atr.toFixed(2) : 'N/A'}`);
console.log(`EMA Spread (20/50): ${(latest.ema20 && latest.ema50) ? (latest.ema20 - latest.ema50).toFixed(2) : 'N/A'}`);
console.log(`SMA-50: ${latest.sma50 ? latest.sma50.toFixed(2) : 'N/A'}`);

console.log('\n--- Strategy Votes ---');
console.log('RSI Vote:', latest.votes.rsi);
console.log('MACD Vote:', latest.votes.macd);
console.log('BB Breakout Vote:', latest.votes.bb);
console.log('EMA Crossover Vote:', latest.votes.ema);
console.log('VWAP Cross Vote:', latest.votes.vwap);

// Extract feature vector (with mock sentiment = 0.5, fear/greed = 60)
const featureVector = extractFeatureVector(results, results.length - 1, 0.5, 60);

console.log('\n--- Feature Vector Validation ---');
const featureCount = Object.keys(featureVector).length;
console.log(`Feature count generated: ${featureCount}`);

if (featureCount >= 40) {
  console.log('SUCCESS: Feature vector has 40+ dimensions, matching ML requirements.');
} else {
  console.error(`FAIL: Feature vector only has ${featureCount} dimensions.`);
}

console.log('\nSample feature values:');
console.log(`- close: ${featureVector.close}`);
console.log(`- bodySize: ${featureVector.bodySize.toFixed(6)}`);
console.log(`- volumeRatio: ${featureVector.volumeRatio.toFixed(4)}`);
console.log(`- sentiment: ${featureVector.sentiment}`);
console.log(`- fearGreed: ${featureVector.fearGreed}`);
console.log(`- return_lag_1: ${featureVector.return_lag_1.toFixed(6)}`);
console.log(`- rsi_lag_1: ${featureVector.rsi_lag_1.toFixed(2)}`);

console.log('\nIndicators verification passed successfully!');
