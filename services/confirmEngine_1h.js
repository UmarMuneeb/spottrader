const axios = require('axios');
const config = require('../config_1h.json');
const { get, all, logToDb } = require('../db/database');

const cooldownTimers = {}; // Store last trade timestamp per symbol

// Fetch rolling 1h sentiment for a symbol (or GLOBAL if symbol news not available)
async function getRollingSentimentScore(symbol) {
  try {
    const baseSymbol = symbol.split('/')[0];
    const oneHourAgo = Date.now() - 1 * 60 * 60 * 1000;

    const row = await get(
      `SELECT AVG(score) as avg_score, COUNT(score) as cnt FROM sentiment
       WHERE (symbol = ? OR symbol = 'GLOBAL') AND timestamp >= ?`,
      [baseSymbol, oneHourAgo]
    );

    if (row && row.cnt > 0) {
      return parseFloat(row.avg_score);
    }
    return 0.0;
  } catch (err) {
    await logToDb('WARNING', 'CONFIRM', `Failed to calculate rolling sentiment: ${err.message}`);
    return 0.0;
  }
}

async function processHeadlineSentiment(symbol, headline, source) {
  const { run } = require('../db/database');
  try {
    const cleanSymbol = symbol ? symbol.split('/')[0] : 'GLOBAL';

    const response = await axios.post(`${config.mlServiceUrl}/sentiment`, { text: headline });
    const score = parseFloat(response.data.score);

    await run(
      `INSERT INTO sentiment (symbol, title, source, score, timestamp) VALUES (?, ?, ?, ?, ?)`,
      [cleanSymbol, headline, source, score, Date.now()]
    );

    await logToDb('INFO', 'CONFIRM', `Headline: "${headline.substring(0, 40)}..." scored: ${score.toFixed(2)} (${cleanSymbol})`);
    return score;
  } catch (err) {
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

function isTradeViable(signal, features, stratConfig) {
  if (signal !== 'BUY') return { viable: true };

  const { atr, price } = features;
  const { posSize, minProfitTarget, FEE_RATE, tpMultiplier = 3.0 } = stratConfig;

  if (!atr || atr <= 0 || !price || price <= 0) return { viable: true };

  const tpDist = atr * tpMultiplier;
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

async function evaluateConfirmation(
  symbol,
  techCandle,
  mlPredictions,
  fearAndGreed = 50,
  stratConfig,
  assetAboveDailyEma200 = true,
  assetDailyClose = 0,
  assetDailyEma200 = 0,
  btcAboveDailyEma200 = true,
  btcDailyClose = 0,
  btcDailyEma200 = 0
) {
  const lastTradeTime = cooldownTimers[symbol] || 0;
  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  const timeElapsed = Date.now() - lastTradeTime;

  if (timeElapsed < cooldownMs) {
    const minutesLeft = ((cooldownMs - timeElapsed) / 60000).toFixed(1);
    await logToDb('INFO', 'CONFIRM', `Trade signal throttled. Cooldown active for ${symbol}. ${minutesLeft}m remaining.`);
    return { decision: 'HOLD', reason: 'COOLDOWN_ACTIVE', votes: {} };
  }

  const rollingSentiment = await getRollingSentimentScore(symbol);

  const normalizedFnG = (fearAndGreed - 50) / 50;
  const combinedSentiment = (rollingSentiment * 0.7) + (normalizedFnG * 0.3);

  const votes = {};
  let weightedScore = 0.0;

  const regime = techCandle.regime || 'NEUTRAL';
  const rawTechVotes = techCandle.votes || {};
  const filteredVotes = {};

  for (const [strategy, vote] of Object.entries(rawTechVotes)) {
    let activeVote = vote;

    if (regime === 'RANGING') {
      if (['macd', 'ema', 'vwap'].includes(strategy)) {
        activeVote = 0;
      }
    } else if (regime === 'TRENDING') {
      if (['rsi', 'bb'].includes(strategy)) {
        activeVote = 0;
      }
    } else if (regime === 'VOLATILE') {
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

  const btcPenalty = btcAboveDailyEma200 ? 1.0 : 0.7;
  if (!btcAboveDailyEma200 && (mlPredictions.rf_vote !== 0 || mlPredictions.lstm_vote !== 0)) {
    await logToDb('INFO', 'CONFIRM', `[SOFT SHIELD] BTC daily trend is bearish. Penalizing ML vote weights by 30% (multiplier: 0.7).`);
  }

  const rfVote = mlPredictions.rf_vote || 0;
  const rfWeight = config.weights.randomForest || 2.0;
  votes['randomForest'] = rfVote;
  weightedScore += rfVote * rfWeight * btcPenalty;

  const lstmVote = mlPredictions.lstm_vote || 0;
  const lstmWeight = config.weights.lstm || 1.5;
  votes['lstm'] = lstmVote;
  weightedScore += lstmVote * lstmWeight * btcPenalty;

  const sentimentWeight = config.weights.sentiment || 1.0;
  votes['sentimentVote'] = combinedSentiment;
  weightedScore += combinedSentiment * sentimentWeight;

  let decision = 'HOLD';
  let reason = `Weighted score = ${weightedScore.toFixed(2)}`;

  const priceAboveSma50 = techCandle.close > techCandle.sma50;

  if (weightedScore >= config.votingThreshold) {
    if (!priceAboveSma50) {
      await logToDb('INFO', 'CONFIRM', `[SHIELD] ${symbol} price $${techCandle.close} below 1H SMA-50 $${techCandle.sma50.toFixed(2)} — skipping BUY signal.`);
      decision = 'HOLD';
      reason = 'sma50_1h_shield';
    } else {
      const closedTradeCount = await get(`SELECT COUNT(*) as cnt FROM trades WHERE status = 'CLOSED'`);
      const totalClosed = closedTradeCount?.cnt || 0;
      const isPaperWarmup = config.tradingMode === 'paper' && totalClosed < 10;

      if (isPaperWarmup) {
        await logToDb('INFO', 'CONFIRM', `[PAPER WARMUP] Isolation Forest bypassed (${totalClosed}/10 paper trades). Running open-loop until baseline is established.`);
      }

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
    regime,
    priceAboveSma50,
    sma50: techCandle.sma50,
    btcAboveDailyEma200,
    btcDailyClose,
    btcDailyEma200
  };
}

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
