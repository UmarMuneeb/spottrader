const axios = require('axios');
const config = require('../config.json');
const { get, all, logToDb } = require('../db/database');

const cooldownTimers = {}; // Store last trade timestamp per symbol

// Fetch rolling 4h sentiment for a symbol (or GLOBAL if symbol news not available)
async function getRollingSentimentScore(symbol) {
  try {
    const baseSymbol = symbol.split('/')[0]; // e.g. BTC from BTC/USDT
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    
    // Query database for average sentiment score over the last 4 hours
    const row = await get(
      `SELECT AVG(score) as avg_score, COUNT(score) as cnt FROM sentiment 
       WHERE (symbol = ? OR symbol = 'GLOBAL') AND timestamp >= ?`,
      [baseSymbol, fourHoursAgo]
    );

    if (row && row.cnt > 0) {
      return parseFloat(row.avg_score);
    }
    return 0.0; // Default neutral sentiment if no articles found
  } catch (err) {
    await logToDb('WARNING', 'CONFIRM', `Failed to calculate rolling sentiment: ${err.message}`);
    return 0.0;
  }
}

// Ingests news headline, gets score from FastAPI, and saves to database
async function processHeadlineSentiment(symbol, headline, source) {
  const { run } = require('../db/database');
  try {
    const cleanSymbol = symbol ? symbol.split('/')[0] : 'GLOBAL';
    
    // Call Python FastAPI sentiment endpoint
    const response = await axios.post(`${config.mlServiceUrl}/sentiment`, { text: headline });
    const score = parseFloat(response.data.score);
    
    await run(
      `INSERT INTO sentiment (symbol, title, source, score, timestamp) VALUES (?, ?, ?, ?, ?)`,
      [cleanSymbol, headline, source, score, Date.now()]
    );
    
    await logToDb('INFO', 'CONFIRM', `Headline: "${headline.substring(0, 40)}..." scored: ${score.toFixed(2)} (${cleanSymbol})`);
    return score;
  } catch (err) {
    // If Python service is down, fall back to writing a dummy 0.0 sentiment score
    const cleanSymbol = symbol ? symbol.split('/')[0] : 'GLOBAL';
    try {
      await run(
        `INSERT INTO sentiment (symbol, title, source, score, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [cleanSymbol, headline, source, 0.0, Date.now()]
      );
    } catch (e) {
      // Ignored
    }
    await logToDb('WARNING', 'CONFIRM', `Failed to score sentiment, using fallback 0.0: ${err.message}`);
    return 0.0;
  }
}

// Fee-aware minimum profit check (tier-aware: uses tpMultiplier from stratConfig)
function isTradeViable(signal, features, stratConfig) {
  if (signal !== 'BUY') return { viable: true };

  const { atr, price } = features;
  const { posSize, minProfitTarget, FEE_RATE, tpMultiplier = 3.0 } = stratConfig;

  if (!atr || atr <= 0 || !price || price <= 0) return { viable: true };

  // ATR-based expected move using tier-specific TP multiplier
  const tpDist = atr * tpMultiplier;        // tier-aware: bootstrap=2.0, others=3.0
  const grossProfit = (tpDist / price) * posSize;
  const roundTrip = posSize * FEE_RATE * 2;
  const netProfit = grossProfit - roundTrip;

  if (netProfit < minProfitTarget) {
    return {
      viable: false,
      reason: `Net profit $${netProfit.toFixed(4)} < min $${minProfitTarget.toFixed(4)} (ATR too tight for fees) [TP=${tpMultiplier}x]`
    };
  }
  return { viable: true };
}

// The core confirmation engine
async function evaluateConfirmation(symbol, techCandle, mlPredictions, fearAndGreed = 50, stratConfig) {
  // 1. Check Cooldown
  const lastTradeTime = cooldownTimers[symbol] || 0;
  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  const timeElapsed = Date.now() - lastTradeTime;
  
  if (timeElapsed < cooldownMs) {
    const minutesLeft = ((cooldownMs - timeElapsed) / 60000).toFixed(1);
    await logToDb('INFO', 'CONFIRM', `Trade signal throttled. Cooldown active for ${symbol}. ${minutesLeft}m remaining.`);
    return { decision: 'HOLD', reason: 'COOLDOWN_ACTIVE', votes: {} };
  }

  // 2. Fetch rolling sentiment gate
  const rollingSentiment = await getRollingSentimentScore(symbol);
  
  // Combine news sentiment and normalized Fear & Greed (-1 to +1)
  const normalizedFnG = (fearAndGreed - 50) / 50;
  const combinedSentiment = (rollingSentiment * 0.7) + (normalizedFnG * 0.3);

  // 3. Extract individual votes and apply weights
  const votes = {};
  let weightedScore = 0.0;
  
  // A. Technical strategies filtered by Market Regime
  const regime = techCandle.regime || 'NEUTRAL';
  const rawTechVotes = techCandle.votes || {};
  const filteredVotes = {};

  for (const [strategy, vote] of Object.entries(rawTechVotes)) {
    let activeVote = vote;

    // Apply Regime filter
    if (regime === 'RANGING') {
      // Mean reversion active. Trend / breakout inactive
      if (['macd', 'ema', 'vwap'].includes(strategy)) {
        activeVote = 0;
      }
    } else if (regime === 'TRENDING') {
      // Trend followers active. Mean reversion inactive
      if (['rsi', 'bb'].includes(strategy)) {
        activeVote = 0;
      }
    } else if (regime === 'VOLATILE') {
      // Breakout active. Lagging/Reversion inactive
      if (['rsi', 'macd', 'ema'].includes(strategy)) {
        activeVote = 0;
      }
    }

    filteredVotes[strategy] = activeVote;
    votes[strategy] = activeVote;

    const weight = config.weights[strategy] || 1.0;
    weightedScore += activeVote * weight;
  }

  await logToDb(
    'INFO',
    'CONFIRM',
    `Evaluating confirmation for ${symbol}. Regime: ${regime}. Raw: ${JSON.stringify(rawTechVotes)}, Filtered: ${JSON.stringify(filteredVotes)}`
  );

  // B. Random Forest (2.0 weight)
  const rfVote = mlPredictions.rf_vote || 0; // -1, 0, 1
  const rfWeight = config.weights.randomForest || 2.0;
  votes['randomForest'] = rfVote;
  weightedScore += rfVote * rfWeight;

  // C. LSTM (1.5 weight)
  const lstmVote = mlPredictions.lstm_vote || 0; // -1, 1
  const lstmWeight = config.weights.lstm || 1.5;
  votes['lstm'] = lstmVote;
  weightedScore += lstmVote * lstmWeight;

  // D. Combined Sentiment Vote (1.0 weight) - Continuous Vote Score
  const sentimentWeight = config.weights.sentiment || 1.0;
  votes['sentimentVote'] = combinedSentiment;
  weightedScore += combinedSentiment * sentimentWeight;

  // 4. Evaluate Thresholds
  let decision = 'HOLD';
  let reason = `Weighted score = ${weightedScore.toFixed(2)}`;

  if (weightedScore >= config.votingThreshold) {
    // Determine effective anomaly filter state
    // PAPER WARMUP BYPASS: skip Isolation Forest for first 10 paper trades.
    // The model has no valid SOL baseline yet; it will retrain after 10 closed trades.
    const closedTradeCount = await get(`SELECT COUNT(*) as cnt FROM trades WHERE status = 'CLOSED'`);
    const totalClosed = closedTradeCount?.cnt || 0;
    const isPaperWarmup = config.tradingMode === 'paper' && totalClosed < 10;

    if (isPaperWarmup) {
      await logToDb('INFO', 'CONFIRM', `[PAPER WARMUP] Isolation Forest bypassed (${totalClosed}/10 paper trades). Running open-loop until baseline is established.`);
    }

    // Gate: accounts under $100 or with fewer than 50 closed trades CANNOT disable the anomaly filter
    let effectiveAnomalyFilter = config.enableAnomalyFilter !== false;
    if (!isPaperWarmup && !effectiveAnomalyFilter && stratConfig) {
      if (stratConfig.tier === 'bootstrap' || stratConfig.tier === 'seedling' || totalClosed < 50) {
        effectiveAnomalyFilter = true;
        await logToDb('WARNING', 'CONFIRM', `Anomaly filter override: forced ON (tier=${stratConfig.tier}, closedTrades=${totalClosed}). Requires $100+ balance and 50+ trades to disable.`);
      }
    }

    if (!isPaperWarmup && mlPredictions.anomaly === 1 && effectiveAnomalyFilter) {
      decision = 'HOLD';
      reason = `BUY Blocked by Isolation Forest Anomaly Safety Net`;
      await logToDb('WARNING', 'CONFIRM', `BUY signal blocked for ${symbol} due to anomalous market conditions.`);
    } else {
      if (mlPredictions.anomaly === 1) {
        await logToDb('WARNING', 'CONFIRM', `BUY signal generated for ${symbol} during anomaly (Anomaly Safety Net is DISABLED).`);
      }
      
      // Perform fee-aware trade viability check if stratConfig is provided
      if (stratConfig) {
        const viability = isTradeViable('BUY', { atr: techCandle.atr, price: techCandle.close }, stratConfig);
        if (!viability.viable) {
          decision = 'HOLD';
          reason = viability.reason;
          await logToDb('WARNING', 'CONFIRM', `[REJECT] ${symbol} signal rejected: ${viability.reason}`);
        } else {
          decision = 'BUY';
          reason = `Weighted BUY votes: ${weightedScore.toFixed(2)} (Threshold: ${config.votingThreshold}, Regime: ${regime})`;
        }
      } else {
        decision = 'BUY';
        reason = `Weighted BUY votes: ${weightedScore.toFixed(2)} (Threshold: ${config.votingThreshold}, Regime: ${regime})`;
      }
    }
  } else if (weightedScore <= -config.votingThreshold) {
    decision = 'SELL';
    reason = `Weighted SELL votes: ${weightedScore.toFixed(2)} (Threshold: -${config.votingThreshold}, Regime: ${regime})`;
  }

  return {
    decision,
    reason,
    votes,
    rollingSentiment,
    combinedSentiment,
    weightedScore,
    anomaly: mlPredictions.anomaly,
    regime
  };
}

// Reset cooldown timer after order placement
function triggerCooldown(symbol) {
  cooldownTimers[symbol] = Date.now();
  logToDb('INFO', 'CONFIRM', `Cooldown activated for ${symbol}. Next trade available in ${config.cooldownMinutes} minutes.`);
}

module.exports = {
  evaluateConfirmation,
  processHeadlineSentiment,
  getRollingSentimentScore,
  triggerCooldown
};
