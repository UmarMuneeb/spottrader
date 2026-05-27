const path = require('path');

const configPath = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.join(__dirname, '..', 'config.json');
const config = require(configPath);
const { get, all, logToDb } = require('../db/database');
const { exchange } = require('./binanceWs');

// ATR Stop-Loss & Take-Profit calculation
function calculateStops(entryPrice, atrValue, direction = 'BUY', slMultiplier = 1.5, tpMultiplier = 3.0) {
  if (!atrValue || atrValue <= 0) {
    // Fallback stops if ATR is not ready (e.g. 2% SL, 4% TP)
    const sl = direction === 'BUY' ? entryPrice * 0.98 : entryPrice * 1.02;
    const tp = direction === 'BUY' ? entryPrice * 1.04 : entryPrice * 0.96;
    return { stopLoss: sl, takeProfit: tp, atrUsed: 0 };
  }

  const slDistance = slMultiplier * atrValue;
  const tpDistance = tpMultiplier * atrValue;

  const stopLoss = direction === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance;
  const takeProfit = direction === 'BUY' ? entryPrice + tpDistance : entryPrice - tpDistance;

  return {
    stopLoss: parseFloat(stopLoss.toFixed(4)),
    takeProfit: parseFloat(takeProfit.toFixed(4)),
    atrUsed: atrValue
  };
}

// Kelly Criterion Position Sizer
// p = win rate (0 to 1)
// b = win/loss ratio (avg profit / avg loss)
// Helper to calculate raw Kelly Size from trades history
async function getKellySize(balance) {
  try {
    const completedTrades = await all(
      `SELECT pnl, usdt_amount FROM trades 
       WHERE status = 'CLOSED' 
       ORDER BY exit_timestamp DESC LIMIT 50`
    );

    if (completedTrades.length < 15) {
      return config.positionSizing?.minUsdt || 10;
    }

    const wins = completedTrades.filter(t => t.pnl > 0);
    const losses = completedTrades.filter(t => t.pnl <= 0);

    const p = wins.length / completedTrades.length; // Win rate
    
    const avgWin = wins.length > 0 
      ? wins.reduce((acc, t) => acc + t.pnl, 0) / wins.length 
      : 0;
      
    const avgLoss = losses.length > 0 
      ? Math.abs(losses.reduce((acc, t) => acc + t.pnl, 0)) / losses.length 
      : 0;

    if (avgLoss === 0) {
      return config.positionSizing?.minUsdt || 10;
    }

    const b = avgWin / avgLoss; // Risk-reward ratio
    const kellyFraction = p - (1 - p) / b;
    
    const fractionalMultiplier = 0.25; 
    let safeFraction = kellyFraction * fractionalMultiplier;
    safeFraction = Math.max(0.0, Math.min(0.05, safeFraction));

    return balance * safeFraction;
  } catch (err) {
    return config.positionSizing?.minUsdt || 10;
  }
}

// Tier hysteresis state — prevents rapid flipping when balance oscillates around boundaries
let _cachedTier = null;
let _cachedTierTimestamp = 0;
const TIER_HYSTERESIS_MS = 30 * 60 * 1000; // 30 minutes

// Dynamic Strategy Configuration Tier auto-selector
async function getStrategyConfig(balance, symbol = 'SOL/USDT') {
  const FEE_RATE = parseFloat(process.env.FEE_RATE) || 0.001; // 0.1% default

  // Calculate what tier this balance maps to
  const candidateTier =
    balance >= 500 ? 'designed' :
    balance >= 100 ? 'growing' :
    balance >= 20  ? 'seedling' : 'bootstrap';

  // Apply hysteresis: only allow tier change if 30 minutes have passed since last change
  const now = Date.now();
  let tier;
  if (_cachedTier === null) {
    // First call ever — set the tier immediately
    tier = candidateTier;
    _cachedTier = tier;
    _cachedTierTimestamp = now;
  } else if (candidateTier !== _cachedTier) {
    if (now - _cachedTierTimestamp >= TIER_HYSTERESIS_MS) {
      // Enough time has passed — allow the tier transition
      const oldTier = _cachedTier;
      tier = candidateTier;
      _cachedTier = tier;
      _cachedTierTimestamp = now;
      await logToDb('INFO', 'RISK', `Strategy tier changed: ${oldTier} → ${tier} (balance: $${balance.toFixed(2)})`);
    } else {
      // Hysteresis hold — keep the old tier
      tier = _cachedTier;
    }
  } else {
    tier = _cachedTier;
  }

  const configs = {
    bootstrap: {
      pairs: ['SOL/USDT'],
      maxTrades: 1,
      posSize: async () => Math.min(balance - 0.10, 5.00),
      kelly: false,
      ddLimit: balance * 0.10,                         // 10% of balance
      exposureCap: 1.0,
      slMultiplier: 1.5,                     // ATR × 1.5 stop
      tpMultiplier: 2.0,                     // ATR × 2.0 take-profit (lower bar for tiny accounts)
      feeFloor: 1.0,                         // minProfitTarget = roundTripFee × 1.0 (just cover fees)
    },
    seedling: {
      pairs: ['SOL/USDT', 'ETH/USDT'],
      maxTrades: 2,
      posSize: async () => Math.max(5, balance * 0.01),
      kelly: false,
      ddLimit: balance * 0.05,
      exposureCap: 0.5,
      slMultiplier: 1.5,
      tpMultiplier: 2.5,
      feeFloor: 1.2,
    },
    growing: {
      pairs: ['SOL/USDT', 'ETH/USDT', 'BNB/USDT', 'BTC/USDT'],
      maxTrades: 3,
      posSize: async () => Math.max(5, Math.min((await getKellySize(balance)) * 0.5, balance * 0.02)),
      kelly: true,
      ddLimit: balance * 0.04,
      exposureCap: 0.35,
      slMultiplier: 1.5,
      tpMultiplier: 3.0,
      feeFloor: 1.5,
    },
    designed: {
      pairs: config.allPairs || ['SOL/USDT', 'ETH/USDT', 'BNB/USDT', 'BTC/USDT'],
      maxTrades: 4,
      posSize: async () => Math.max(5, Math.min((await getKellySize(balance)) * 0.5, balance * 0.03)),
      kelly: true,
      ddLimit: balance * 0.03,
      exposureCap: 0.30,
      slMultiplier: 1.5,
      tpMultiplier: 3.0,
      feeFloor: 1.5,
    }
  };

  const c = configs[tier];

  // Fee-aware minimum profit requirement
  let posSize = await c.posSize();
  
  // Live trading minimum exchange size safety check (fetch minNotional dynamically)
  if (config.tradingMode !== 'paper') {
    let minSize = config.positionSizing?.minUsdt || 10;
    try {
      if (exchange && exchange.markets && exchange.markets[symbol]) {
        minSize = exchange.markets[symbol].limits.cost.min || minSize;
      }
    } catch (err) {
      // Fallback to minSize
    }
    if (posSize < minSize) {
      posSize = minSize;
    }
  }

  // Round position size to 2 decimal places
  posSize = parseFloat(posSize.toFixed(2));

  const roundTripFee = posSize * FEE_RATE * 2;
  const breakEvenPct = FEE_RATE * 2;
  const feeFloor = c.feeFloor || 1.5;
  const minProfitTarget = roundTripFee * feeFloor;

  return { tier, ...c, posSize, roundTripFee, breakEvenPct, minProfitTarget, FEE_RATE };
}

// Kelly Criterion Position Sizer Wrapper (delegates to getStrategyConfig)
async function calculateKellyPositionSize(totalBalance, symbol = 'SOL/USDT') {
  const stratConfig = await getStrategyConfig(totalBalance, symbol);
  return stratConfig.posSize;
}

// Checks if we violate the total portfolio exposure limit
async function validateExposureLimit(totalBalance, newTradeUsdtAmount, symbol = 'SOL/USDT') {
  try {
    const stratConfig = await getStrategyConfig(totalBalance, symbol);
    // Sum current open positions value
    const openTrades = await all(`SELECT usdt_amount FROM trades WHERE status = 'OPEN'`);
    const currentExposure = openTrades.reduce((acc, t) => acc + t.usdt_amount, 0);
    const futureExposure = currentExposure + newTradeUsdtAmount;
    
    const exposurePct = futureExposure / totalBalance;
    
    const maxAllowedExposurePct = stratConfig.exposureCap;
    const isAllowed = exposurePct <= maxAllowedExposurePct;

    if (!isAllowed) {
      await logToDb('WARNING', 'RISK', `Exposure limit exceeded! Open value: $${currentExposure.toFixed(2)}, New trade: $${newTradeUsdtAmount.toFixed(2)} (${(exposurePct * 100).toFixed(1)}% of balance vs limit ${(maxAllowedExposurePct * 100).toFixed(0)}%)`);
    }

    return isAllowed;
  } catch (err) {
    await logToDb('ERROR', 'RISK', `Exposure validation error: ${err.message}`);
    return false;
  }
}

// Daily Drawdown Circuit Breaker Check
async function validateCircuitBreaker(totalBalance) {
  try {
    const stratConfig = await getStrategyConfig(totalBalance);
    // Get start of today (00:00 UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const startTimestamp = todayStart.getTime();

    // Query daily realized P&L from closed trades
    const closedToday = await all(
      `SELECT pnl FROM trades WHERE status = 'CLOSED' AND exit_timestamp >= ?`,
      [startTimestamp]
    );
    const dailyRealizedPnl = closedToday.reduce((acc, t) => acc + t.pnl, 0);
    
    // Drawdown check: realized loss today against ddLimit
    const isBreakerTriggered = dailyRealizedPnl < 0 && Math.abs(dailyRealizedPnl) >= stratConfig.ddLimit;

    if (isBreakerTriggered) {
      await logToDb('CAUTION', 'RISK', `CRITICAL: Daily Drawdown Circuit Breaker Triggered! Loss today: $${Math.abs(dailyRealizedPnl).toFixed(2)} >= Allowed Limit $${stratConfig.ddLimit.toFixed(2)}. ALL NEW TRADING BLOCKED FOR TODAY.`);
      return false; // Blocks trading
    }

    return true; // Safe to trade
  } catch (err) {
    await logToDb('ERROR', 'RISK', `Circuit breaker check error: ${err.message}`);
    return false; // Err on safety side, block trading
  }
}

module.exports = {
  calculateStops,
  calculateKellyPositionSize,
  validateExposureLimit,
  validateCircuitBreaker,
  getStrategyConfig
};
