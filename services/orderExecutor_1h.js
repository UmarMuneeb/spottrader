const crypto = require('crypto');
const path = require('path');

const configPath = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.join(__dirname, '..', 'config.json');
const config = require(configPath);
const { run, get, all, logToDb } = require('../db/database');
const { exchange, candleBuffers, latestPrices } = require('./binanceWs_1h');
const { triggerCooldown } = require('./confirmEngine_1h');
const { sendTelegramAlert } = require('./telegram');

function generateTradeId() {
  return crypto.randomUUID();
}

function getCurrentPrice(symbol) {
  if (latestPrices && latestPrices[symbol]) {
    return latestPrices[symbol];
  }
  if (candleBuffers[symbol] && candleBuffers[symbol].length > 0) {
    return candleBuffers[symbol][candleBuffers[symbol].length - 1].close;
  }
  return 0.0;
}

async function getPortfolioBalance() {
  const initialBalance = config.paperInitialBalance;

  if (config.tradingMode === 'paper') {
    try {
      const closedRow = await get(`SELECT SUM(pnl) as total_pnl FROM trades WHERE status = 'CLOSED'`);
      const closedPnl = parseFloat(closedRow.total_pnl || 0.0);

      const openRow = await get(`SELECT SUM(usdt_amount) as total_cost FROM trades WHERE status = 'OPEN'`);
      const openCost = parseFloat(openRow.total_cost || 0.0);

      const cash = initialBalance + closedPnl - openCost;

      const openTrades = await all(`SELECT symbol, quantity FROM trades WHERE status = 'OPEN'`);
      let openValue = 0.0;
      for (const trade of openTrades) {
        const price = getCurrentPrice(trade.symbol);
        openValue += trade.quantity * price;
      }

      const totalBalance = cash + openValue;

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
  }

  try {
    if (!exchange.apiKey) {
      throw new Error('Binance API keys not set in environment.');
    }
    const balance = await exchange.fetchBalance();
    const usdtFree = balance.free['USDT'] || 0.0;
    const usdtUsed = balance.used['USDT'] || 0.0;

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
      unrealizedPnl: 0.0
    };
  } catch (err) {
    await logToDb('ERROR', 'EXECUTION', `Failed to fetch live balance: ${err.message}. Falling back to paper metrics.`);
    config.tradingMode = 'paper';
    return getPortfolioBalance();
  }
}

async function monitorOpenPositions(symbol, currentCandle) {
  try {
    const openTrades = await all(`SELECT * FROM trades WHERE symbol = ? AND status = 'OPEN'`, [symbol]);
    if (openTrades.length === 0) return;

    const { high, low } = currentCandle;

    for (const trade of openTrades) {
      let exitTriggered = false;
      let exitPrice = 0.0;
      let exitReason = '';

      if (trade.stop_loss && low <= trade.stop_loss) {
        exitTriggered = true;
        exitPrice = trade.stop_loss;
        exitReason = 'STOP_LOSS_TRIGGERED';
      } else if (trade.take_profit && high >= trade.take_profit) {
        exitTriggered = true;
        exitPrice = trade.take_profit;
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
    try {
      const order = await exchange.createMarketOrder(symbol, 'buy', quantity);
      const fillPrice = order.price || price;
      const fillQty = order.filled || quantity;
      const fillUsdt = fillQty * fillPrice;

      const actualSl = fillPrice - (price - stopLoss);
      const actualTp = fillPrice + (takeProfit - price);

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

      try {
        await logToDb('INFO', 'EXECUTION', `Placing Binance OCO Sell Order for ${symbol}...`);
        const oco = await exchange.createOrder(symbol, 'limit', 'sell', fillQty, actualTp, {
          stopPrice: actualSl,
          stopLimitPrice: actualSl * 0.995, // avoid slippage
          type: 'OCO'
        });
        if (oco && oco.id) {
          await run(`UPDATE trades SET oco_order_id = ? WHERE id = ?`, [oco.id, order.id || tradeId]);
          await logToDb('INFO', 'EXECUTION', `[OCO] Exchange-side stop placed: ${oco.id} | SL: ${actualSl} | TP: ${actualTp}`);
        }
      } catch (ocoErr) {
        await logToDb('WARNING', 'EXECUTION', `Failed to place OCO on Binance: ${ocoErr.message}. Local stop monitoring will handle exit.`);
      }

      triggerCooldown(symbol);
    } catch (err) {
      await logToDb('ERROR', 'EXECUTION', `Binance live order failed: ${err.message}`);
    }
  }
}

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
      try {
        // Cancel exchange-side OCO order if tracked, else fallback to cancelAllOrders
        if (trade.oco_order_id) {
          try {
            await exchange.cancelOrder(trade.oco_order_id, symbol);
            await logToDb('INFO', 'EXECUTION', `Cancelled OCO order: ${trade.oco_order_id}`);
          } catch (ocoCancelErr) {
            await logToDb('WARNING', 'EXECUTION', `Failed to cancel OCO order ${trade.oco_order_id}: ${ocoCancelErr.message}. Trying cancel all...`);
            try {
              await exchange.cancelAllOrders(symbol);
            } catch (cErr) {}
          }
        } else {
          try {
            await exchange.cancelAllOrders(symbol);
          } catch (cErr) {
            // Ignored
          }
        }

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

async function liquidateAllPositions() {
  await logToDb('CAUTION', 'EXECUTION', `EMERGENCY LIQUIDATION INITIATED: Closing all positions.`);
  try {
    const openTrades = await all(`SELECT * FROM trades WHERE status = 'OPEN'`);
    for (const trade of openTrades) {
      const price = getCurrentPrice(trade.symbol);
      const exitPrice = price > 0 ? price : trade.price;
      await executeExit(trade.id, trade.symbol, exitPrice, 'EMERGENCY_LIQUIDATION');
    }
  } catch (err) {
    await logToDb('ERROR', 'EXECUTION', `Failed during emergency liquidation: ${err.message}`);
  }
}

async function monitorOpenPositionsRealtime(symbol, currentPrice, highPrice, lowPrice) {
  try {
    const openTrades = await all(`SELECT * FROM trades WHERE symbol = ? AND status = 'OPEN'`, [symbol]);
    if (openTrades.length === 0) return;

    for (const trade of openTrades) {
      let exitTriggered = false;
      let exitPrice = 0.0;
      let exitReason = '';

      if (trade.execution_type === 'paper') {
        if (trade.stop_loss && currentPrice <= trade.stop_loss) {
          exitTriggered = true;
          exitPrice = trade.stop_loss;
          exitReason = 'STOP_LOSS_TRIGGERED';
        } else if (trade.take_profit && currentPrice >= trade.take_profit) {
          exitTriggered = true;
          exitPrice = trade.take_profit;
          exitReason = 'TAKE_PROFIT_TRIGGERED';
        }
      } else {
        // Fallback for live trades
        if (trade.stop_loss && currentPrice <= trade.stop_loss) {
          exitTriggered = true;
          exitPrice = trade.stop_loss;
          exitReason = 'STOP_LOSS_TRIGGERED_FALLBACK';
        } else if (trade.take_profit && currentPrice >= trade.take_profit) {
          exitTriggered = true;
          exitPrice = trade.take_profit;
          exitReason = 'TAKE_PROFIT_TRIGGERED_FALLBACK';
        }
      }

      if (exitTriggered) {
        await executeExit(trade.id, symbol, exitPrice, exitReason);
      }
    }
  } catch (err) {
    // Avoid spam
  }
}

module.exports = {
  getPortfolioBalance,
  monitorOpenPositions,
  monitorOpenPositionsRealtime,
  executeEntry,
  executeExit,
  liquidateAllPositions,
  getCurrentPrice
};
