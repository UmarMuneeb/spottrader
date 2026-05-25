const crypto = require('crypto');
const path = require('path');

const configPath = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.join(__dirname, '..', 'config.json');
const config = require(configPath);
const { run, get, all, logToDb } = require('../db/database');
const { exchange, candleBuffers } = require('./binanceWs');
const { triggerCooldown } = require('./confirmEngine');
const { sendTelegramAlert } = require('./telegram');

// Helper to generate unique transaction IDs
function generateTradeId() {
  return crypto.randomUUID();
}

// Get the latest price for a symbol from in-memory buffers
function getCurrentPrice(symbol) {
  if (candleBuffers[symbol] && candleBuffers[symbol].length > 0) {
    return candleBuffers[symbol][candleBuffers[symbol].length - 1].close;
  }
  return 0.0;
}

// Calculate the current portfolio state (cash, open position values, total balance)
async function getPortfolioBalance() {
  const initialBalance = config.paperInitialBalance;

  if (config.tradingMode === 'paper') {
    try {
      // 1. Sum PnL of CLOSED trades
      const closedRow = await get(`SELECT SUM(pnl) as total_pnl FROM trades WHERE status = 'CLOSED'`);
      const closedPnl = parseFloat(closedRow.total_pnl || 0.0);

      // 2. Sum cost of OPEN trades
      const openRow = await get(`SELECT SUM(usdt_amount) as total_cost FROM trades WHERE status = 'OPEN'`);
      const openCost = parseFloat(openRow.total_cost || 0.0);

      // Current cash = initial + closed_pnl - open_cost
      const cash = initialBalance + closedPnl - openCost;

      // 3. Current value of open positions
      const openTrades = await all(`SELECT symbol, quantity FROM trades WHERE status = 'OPEN'`);
      let openValue = 0.0;
      for (const trade of openTrades) {
        const price = getCurrentPrice(trade.symbol);
        openValue += trade.quantity * price;
      }

      const totalBalance = cash + openValue;

      // Record in balance history (limit to once a minute/tick for logging)
      await run(
        `INSERT OR REPLACE INTO balance_history (timestamp, balance, unrealized_pnl) VALUES (?, ?, ?)`,
        [Date.now(), totalBalance, openValue - openCost]
      );

      return {
        cash: parseFloat(cash.toFixed(2)),
        openValue: parseFloat(openValue.toFixed(2)),
        totalBalance: parseFloat(totalBalance.toFixed(2)),
        unrealizedPnl: parseFloat((openValue - openCost).toFixed(2))
      };
    } catch (err) {
      console.error('Error calculating paper balance:', err);
      return { cash: initialBalance, openValue: 0.0, totalBalance: initialBalance, unrealizedPnl: 0.0 };
    }
  } else {
    // Live / Testnet Balance from Binance
    try {
      if (!exchange.apiKey) {
        throw new Error('Binance API keys not set in environment.');
      }
      const balance = await exchange.fetchBalance();
      const usdtFree = balance.free['USDT'] || 0.0;
      const usdtUsed = balance.used['USDT'] || 0.0;
      
      // Calculate total portfolio including value of monitored symbols
      let totalBalance = usdtFree + usdtUsed;
      for (const symbol of config.symbols) {
        const base = symbol.split('/')[0];
        const qty = balance.total[base] || 0.0;
        const price = getCurrentPrice(symbol);
        if (qty > 0 && price > 0) {
          totalBalance += qty * price;
        }
      }
      return {
        cash: usdtFree,
        openValue: totalBalance - usdtFree,
        totalBalance: totalBalance,
        unrealizedPnl: 0.0 // Hard to track live unrealized without entry ledger
      };
    } catch (err) {
      await logToDb('ERROR', 'EXECUTION', `Failed to fetch live balance: ${err.message}. Falling back to paper metrics.`);
      // Fallback to paper calculation
      config.tradingMode = 'paper';
      return getPortfolioBalance();
    }
  }
}

// Scans open positions and checks if stop-loss or take-profit targets are hit
async function monitorOpenPositions(symbol, currentCandle) {
  try {
    const openTrades = await all(`SELECT * FROM trades WHERE symbol = ? AND status = 'OPEN'`, [symbol]);
    if (openTrades.length === 0) return;

    const { high, low, close } = currentCandle;

    for (const trade of openTrades) {
      let exitTriggered = false;
      let exitPrice = 0.0;
      let exitReason = '';

      // Check Stop-Loss
      if (trade.stop_loss && low <= trade.stop_loss) {
        exitTriggered = true;
        exitPrice = trade.stop_loss; // Execute exit at SL limit price
        exitReason = 'STOP_LOSS_TRIGGERED';
      }
      // Check Take-Profit
      else if (trade.take_profit && high >= trade.take_profit) {
        exitTriggered = true;
        exitPrice = trade.take_profit; // Execute exit at TP limit price
        exitReason = 'TAKE_PROFIT_TRIGGERED';
      }

      if (exitTriggered) {
        await executeExit(trade.id, symbol, exitPrice, exitReason);
      }
    }
  } catch (err) {
    await logToDb('ERROR', 'EXECUTION', `Error monitoring positions for ${symbol}: ${err.message}`);
  }
}

// Executes entry BUY order (simulated or live)
async function executeEntry(symbol, usdtSize, stops, regime = 'NEUTRAL') {
  const price = getCurrentPrice(symbol);
  if (price <= 0) {
    await logToDb('WARNING', 'EXECUTION', `Aborted entry for ${symbol}: invalid ticker price.`);
    return;
  }

  const { stopLoss, takeProfit } = stops;
  const quantity = usdtSize / price;
  const tradeId = generateTradeId();

  await logToDb('INFO', 'EXECUTION', `Attempting entry on ${symbol}: Amount = $${usdtSize} USDT, Qty = ${quantity.toFixed(6)}, SL = ${stopLoss}, TP = ${takeProfit}, Regime = ${regime}`);

  if (config.tradingMode === 'paper') {
    try {
      await run(
        `INSERT INTO trades (id, symbol, direction, price, quantity, usdt_amount, stop_loss, take_profit, timestamp, status, execution_type, signals, regime) 
         VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, ?, 'OPEN', 'paper', ?, ?)`,
        [tradeId, symbol, price, quantity, usdtSize, stopLoss, takeProfit, Date.now(), JSON.stringify(stops.votes || {}), regime]
      );
      
      await logToDb('INFO', 'EXECUTION', `SUCCESS (Paper): Bought ${quantity.toFixed(6)} ${symbol} at $${price.toFixed(2)}`);
      await sendTelegramAlert(
        `⚡ *SpotTrader BUY Entry (PAPER)*\n` +
        `• *Symbol:* ${symbol}\n` +
        `• *Regime:* ${regime}\n` +
        `• *Price:* $${price.toFixed(4)}\n` +
        `• *Qty:* ${quantity.toFixed(6)}\n` +
        `• *Total:* $${usdtSize.toFixed(2)} USDT\n` +
        `• *Stops:* SL $${stopLoss.toFixed(4)} / TP $${takeProfit.toFixed(4)}`
      );
      triggerCooldown(symbol);
    } catch (err) {
      await logToDb('ERROR', 'EXECUTION', `Failed to log paper trade: ${err.message}`);
    }
  } else {
    // Live / Testnet Binance Execution
    try {
      // 1. Place Market BUY
      const order = await exchange.createMarketOrder(symbol, 'buy', quantity);
      const fillPrice = order.price || price; // Fallback to websocket ticker if CCXT doesn't return fill price
      const fillQty = order.filled || quantity;
      const fillUsdt = fillQty * fillPrice;

      // Recalculate stops based on actual fill price
      const actualSl = fillPrice - (price - stopLoss);
      const actualTp = fillPrice + (takeProfit - price);

      // 2. Save trade to database
      await run(
        `INSERT INTO trades (id, symbol, direction, price, quantity, usdt_amount, stop_loss, take_profit, timestamp, status, execution_type, signals, regime) 
         VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, ?, 'OPEN', 'live', ?, ?)`,
        [order.id || tradeId, symbol, fillPrice, fillQty, fillUsdt, actualSl, actualTp, Date.now(), JSON.stringify(stops.votes || {}), regime]
      );

      await logToDb('INFO', 'EXECUTION', `SUCCESS (Binance Live): Bought ${fillQty.toFixed(6)} ${symbol} at $${fillPrice.toFixed(4)}`);
      await sendTelegramAlert(
        `⚡ *SpotTrader BUY Entry (LIVE)*\n` +
        `• *Symbol:* ${symbol}\n` +
        `• *Regime:* ${regime}\n` +
        `• *Price:* $${fillPrice.toFixed(4)}\n` +
        `• *Qty:* ${fillQty.toFixed(6)}\n` +
        `• *Total:* $${fillUsdt.toFixed(2)} USDT\n` +
        `• *Stops:* SL $${actualSl.toFixed(4)} / TP $${actualTp.toFixed(4)}`
      );
      
      // 3. Attempt to place OCO Order for SL & TP
      try {
        await logToDb('INFO', 'EXECUTION', `Placing Binance OCO Sell Order for ${symbol}...`);
        await exchange.createOrder(symbol, 'limit', 'sell', fillQty, actualTp, {
          stopPrice: actualSl,
          stopLimitPrice: actualSl, // Trigger stop market or stop limit
          type: 'OCO'
        });
      } catch (ocoErr) {
        // Log OCO failure but keep the position open since the local system will monitor and exit it on ticks!
        await logToDb('WARNING', 'EXECUTION', `Failed to place OCO on Binance: ${ocoErr.message}. Local stop monitoring will handle exit.`);
      }

      triggerCooldown(symbol);
    } catch (err) {
      await logToDb('ERROR', 'EXECUTION', `Binance live order failed: ${err.message}`);
    }
  }
}

// Executes exit SELL order (simulated or live)
async function executeExit(tradeId, symbol, exitPrice, reason) {
  try {
    const trade = await get(`SELECT * FROM trades WHERE id = ?`, [tradeId]);
    if (!trade || trade.status !== 'OPEN') return;

    const pnl = (exitPrice - trade.price) * trade.quantity;
    const returnPct = (pnl / trade.usdt_amount) * 100;

    await logToDb('INFO', 'EXECUTION', `Exiting trade ${tradeId} (${symbol}): Price = ${exitPrice}, PnL = $${pnl.toFixed(2)} (${returnPct.toFixed(2)}%), Reason = ${reason}`);

    if (trade.execution_type === 'paper') {
      await run(
        `UPDATE trades SET status = 'CLOSED', pnl = ?, exit_price = ?, exit_timestamp = ? WHERE id = ?`,
        [pnl, exitPrice, Date.now(), tradeId]
      );
      await logToDb('INFO', 'EXECUTION', `SUCCESS (Paper Exit): Position Closed.`);
      await sendTelegramAlert(
        `🔔 *SpotTrader Exit (PAPER)*\n` +
        `• *Symbol:* ${symbol}\n` +
        `• *Exit Price:* $${exitPrice.toFixed(4)} (Entry: $${trade.price.toFixed(4)})\n` +
        `• *PnL:* ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)} (${returnPct.toFixed(2)}%)\n` +
        `• *Reason:* ${reason}`
      );
    } else {
      // Live Exit
      try {
        // Cancel all pending orders (e.g. OCO order) for this symbol first to free up balances
        try {
          await exchange.cancelAllOrders(symbol);
        } catch (cErr) {
          // Ignored if no orders exist
        }

        // Market Sell
        const order = await exchange.createMarketOrder(symbol, 'sell', trade.quantity);
        const actualExitPrice = order.price || exitPrice;
        const actualPnl = (actualExitPrice - trade.price) * trade.quantity;

        await run(
          `UPDATE trades SET status = 'CLOSED', pnl = ?, exit_price = ?, exit_timestamp = ? WHERE id = ?`,
          [actualPnl, actualExitPrice, Date.now(), tradeId]
        );
        await logToDb('INFO', 'EXECUTION', `SUCCESS (Binance Live Exit): Position Closed at $${actualExitPrice.toFixed(4)}.`);
        await sendTelegramAlert(
          `🔔 *SpotTrader Exit (LIVE)*\n` +
          `• *Symbol:* ${symbol}\n` +
          `• *Exit Price:* $${actualExitPrice.toFixed(4)} (Entry: $${trade.price.toFixed(4)})\n` +
          `• *PnL:* ${actualPnl >= 0 ? '🟢' : '🔴'} $${actualPnl.toFixed(2)} (${(actualPnl / trade.usdt_amount * 100).toFixed(2)}%)\n` +
          `• *Reason:* ${reason}`
        );
      } catch (err) {
        await logToDb('ERROR', 'EXECUTION', `Failed to execute live Binance exit: ${err.message}. Converting to manual tracker.`);
        // Fallback: save local record closed anyways to avoid infinity loops
        await run(
          `UPDATE trades SET status = 'CLOSED', pnl = ?, exit_price = ?, exit_timestamp = ? WHERE id = ?`,
          [pnl, exitPrice, Date.now(), tradeId]
        );
      }
    }
  } catch (err) {
    await logToDb('ERROR', 'EXECUTION', `Exit failed for trade ${tradeId}: ${err.message}`);
  }
}

// Emergency Liquidation: Closes all open positions immediately (circuit breaker)
async function liquidateAllPositions() {
  await logToDb('CAUTION', 'EXECUTION', `EMERGENCY LIQUIDATION INITIATED: Closing all positions.`);
  try {
    const openTrades = await all(`SELECT * FROM trades WHERE status = 'OPEN'`);
    for (const trade of openTrades) {
      const price = getCurrentPrice(trade.symbol);
      const exitPrice = price > 0 ? price : trade.price; // fallback to entry if ticker down
      await executeExit(trade.id, trade.symbol, exitPrice, 'EMERGENCY_LIQUIDATION');
    }
  } catch (err) {
    await logToDb('ERROR', 'EXECUTION', `Failed during emergency liquidation: ${err.message}`);
  }
}

module.exports = {
  getPortfolioBalance,
  monitorOpenPositions,
  executeEntry,
  executeExit,
  liquidateAllPositions,
  getCurrentPrice
};
