require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

// Set global axios API header token for local python ML service auth
axios.defaults.headers.common['X-API-Token'] = process.env.ML_API_TOKEN || 'super_secret_trading_token_change_me';

const config = require('./config.json');

// Setup persistent configuration path (survives Modal container recycles)
const configPath = process.env.DB_PATH 
  ? path.join(path.dirname(process.env.DB_PATH), 'config.json')
  : path.join(__dirname, 'config.json');

if (process.env.DB_PATH && !fs.existsSync(configPath)) {
  try {
    fs.copyFileSync(path.join(__dirname, 'config.json'), configPath);
  } catch (err) {
    console.error('Failed to copy config.json to persistent volume:', err);
  }
}

try {
  const persistentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  Object.assign(config, persistentConfig);
} catch (err) {
  console.error('Failed to load persistent config:', err);
}
const { initDatabase, logToDb, all, get, run } = require('./db/database');
const { startDataIngestion, candleBuffers, orderBooks, macroSignals } = require('./services/binanceWs');
const { computeTechnicalData, extractFeatureVector } = require('./services/taEngine');
const { evaluateConfirmation, processHeadlineSentiment } = require('./services/confirmEngine');
const { calculateStops, calculateKellyPositionSize, validateExposureLimit, validateCircuitBreaker } = require('./services/riskEngine');
const { getPortfolioBalance, monitorOpenPositions, executeEntry, executeExit, liquidateAllPositions, getCurrentPrice } = require('./services/orderExecutor');
const { sendTelegramAlert } = require('./services/telegram');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
let isTradingEnabled = true;

const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'https://spotui-f16qpash7-umars-projects-6404707b.vercel.app, https://spotui-chi.vercel.app')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const vercelPreviewPattern = /^https:\/\/spotui-[a-z0-9-]+-umars-projects-6404707b\.vercel\.app$/i;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  return vercelPreviewPattern.test(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// REST API Endpoints
app.get('/api/status', async (req, res) => {
  try {
    const portfolio = await getPortfolioBalance();
    
    // Check if python server is alive
    let mlConnected = false;
    try {
      const mlStatus = await axios.get(`${config.mlServiceUrl}/status`, { timeout: 1000 });
      mlConnected = mlStatus.data.status === 'ok';
    } catch (e) {
      mlConnected = false;
    }

    // Fetch win rates per regime type
    const regimeStats = await all(`
      SELECT 
        regime, 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winningTrades
      FROM trades 
      WHERE status = 'CLOSED' 
      GROUP BY regime
    `);

    res.json({
      tradingMode: config.tradingMode,
      isTradingEnabled,
      portfolio,
      macroSignals,
      mlConnected,
      symbols: config.symbols,
      cooldownMinutes: config.cooldownMinutes,
      votingThreshold: config.votingThreshold,
      exposureLimitPct: config.exposureLimitPct,
      paperInitialBalance: config.paperInitialBalance,
      enableAnomalyFilter: config.enableAnomalyFilter !== false,
      regimeStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    const trades = await all(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT 100`);
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const logs = await all(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100`);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/candles/:symbol', async (req, res) => {
  try {
    const symbol = decodeURIComponent(req.params.symbol);
    const candles = await all(
      `SELECT timestamp, open, high, low, close, volume FROM candles 
       WHERE symbol = ? ORDER BY timestamp DESC LIMIT 100`,
      [symbol]
    );
    res.json(candles.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { tradingMode, exposureLimitPct, votingThreshold, cooldownMinutes, enableAnomalyFilter } = req.body;
    
    if (tradingMode !== undefined) config.tradingMode = tradingMode;
    if (exposureLimitPct !== undefined) config.exposureLimitPct = parseFloat(exposureLimitPct);
    if (votingThreshold !== undefined) config.votingThreshold = parseFloat(votingThreshold);
    if (cooldownMinutes !== undefined) config.cooldownMinutes = parseInt(cooldownMinutes);
    if (enableAnomalyFilter !== undefined) config.enableAnomalyFilter = enableAnomalyFilter;

    // Save configuration updates to the persistent volume path (survives Modal redeployments)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    await logToDb('INFO', 'SYSTEM', `Trading configurations updated at runtime.`);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/manual-trade', async (req, res) => {
  try {
    const { symbol, direction } = req.body;
    const price = getCurrentPrice(symbol);
    
    if (price <= 0) {
      return res.status(400).json({ success: false, message: 'Ticker price not available yet.' });
    }

    if (direction === 'BUY') {
      const portfolio = await getPortfolioBalance();
      const stops = calculateStops(price, price * 0.01); // default 1% ATR fallback
      stops.votes = { manual: 1 };
      await executeEntry(symbol, config.positionSizing.minUsdt, stops, 'MANUAL');
    } else {
      const openTrade = await get(`SELECT id FROM trades WHERE symbol = ? AND status = 'OPEN'`, [symbol]);
      if (!openTrade) {
        return res.status(400).json({ success: false, message: 'No open position found to exit.' });
      }
      await executeExit(openTrade.id, symbol, price, 'MANUAL_EXIT_DASHBOARD');
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RSS News Headline Ingestor
async function fetchNewsHeadlines() {
  await logToDb('INFO', 'DATA', 'Fetching RSS news feeds for sentiment analysis...');
  const feeds = [
    'https://cointelegraph.com/rss',
    'https://www.coindesk.com/arc/outboundfeeds/rss/'
  ];

  for (const url of feeds) {
    try {
      const res = await axios.get(url, { timeout: 8000 });
      const xml = res.data;
      
      // Simple regex to parse titles from XML feed
      const matches = xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g);
      let count = 0;
      for (const match of matches) {
        let headline = match[1] || match[2];
        if (!headline) continue;
        headline = headline.replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
        
        // Filter out site headers
        if (
          headline.includes('Cointelegraph') || 
          headline.includes('CoinDesk') || 
          headline.toLowerCase().includes('rss feed') || 
          headline.length < 15
        ) {
          continue;
        }

        // Avoid analyzing duplicates (check DB first)
        const exists = await get(`SELECT id FROM sentiment WHERE title = ?`, [headline]);
        if (!exists) {
          // Send to Python FastAPI for FinBERT / VADER scoring and save in DB
          await processHeadlineSentiment(null, headline, 'RSS');
          count++;
          // Limit to 5 new articles per feed to avoid overloading HuggingFace/VADER
          if (count >= 5) break;
        }
      }
    } catch (err) {
      await logToDb('WARNING', 'DATA', `Failed reading RSS feed ${url}: ${err.message}`);
    }
  }
}

// Scheduled Retrainer Job (Simulating Weekly auto-ML trigger)
async function triggerWeeklyMLRetraining() {
  await logToDb('INFO', 'ML', 'Starting weekly auto-retraining pipeline...');
  for (const symbol of config.symbols) {
    try {
      await logToDb('INFO', 'ML', `Posting retraining request to FastAPI for ${symbol}...`);
      const response = await axios.post(`${config.mlServiceUrl}/train`, { symbol }, { timeout: 60000 });
      if (response.data.success) {
        await logToDb('INFO', 'ML', `SUCCESS: Models successfully retrained and reloaded for ${symbol}.`);
      } else {
        await logToDb('WARNING', 'ML', `FAILED: Retraining rejected: ${response.data.message}`);
      }
    } catch (err) {
      await logToDb('ERROR', 'ML', `Failed to retrain models for ${symbol}: ${err.message}`);
    }
  }
}

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('Dashboard Client connected via Socket.io');
  socket.emit('init', { symbols: config.symbols });
});

// The core 6-layer execution logic (triggered when a candle closes)
async function onCandleClose(symbol, closedCandle) {
  if (!isTradingEnabled) return;

  try {
    // 0. Fetch current portfolio balance and strategy tier config
    const portfolio = await getPortfolioBalance();
    const { getStrategyConfig } = require('./services/riskEngine');
    const stratConfig = await getStrategyConfig(portfolio.totalBalance, symbol);

    // Filter by allowed pairs for the current balance tier
    if (!stratConfig.pairs.includes(symbol)) {
      return; // Ignore symbols not supported in the active tier
    }

    const candles = candleBuffers[symbol];
    if (!candles || candles.length < 200) {
      await logToDb('WARNING', 'SYSTEM', `Waiting for more historical candle buffers for ${symbol} (${candles ? candles.length : 0}/200)`);
      return;
    }

    // 1. Calculate Technical indicators (Layer 3)
    const computedData = computeTechnicalData(candles);
    const latestTechCandle = computedData[computedData.length - 1];

    // 2. Fetch rolling news sentiment
    const rollingSentiment = await get(`SELECT AVG(score) as avg_score FROM sentiment WHERE timestamp >= ?`, [Date.now() - 4*60*60*1000]);
    const sentimentScore = parseFloat(rollingSentiment.avg_score || 0.0);

    // 3. Extract 40+ Feature vector for Python ML inference (Layer 2)
    const featureVector = extractFeatureVector(computedData, computedData.length - 1, sentimentScore, macroSignals.fearAndGreed);
    
    // Extract sequence (past 30 candles) for LSTM
    const sequence = [];
    for (let i = computedData.length - 30; i < computedData.length; i++) {
      sequence.push(extractFeatureVector(computedData, i, sentimentScore, macroSignals.fearAndGreed));
    }

    // 4. Request Predictions from FastAPI ML server
    let mlPredictions = { rf_vote: 0, rf_confidence: 0.5, lstm_vote: 0, lstm_confidence: 0.5, anomaly: 0, is_fallback: true };
    try {
      const response = await axios.post(`${config.mlServiceUrl}/predict`, {
        symbol,
        features: featureVector,
        sequence
      });
      mlPredictions = response.data;
    } catch (err) {
      await logToDb('WARNING', 'ML', `Python ML inference failed. Using fallback defaults: ${err.message}`);
    }

    // 5. Evaluate Signal Confirmation voting (Layer 4) with dynamic stratConfig
    const confirmation = await evaluateConfirmation(symbol, latestTechCandle, mlPredictions, fearAndGreed = macroSignals.fearAndGreed, stratConfig);

    // 7. Validate Risk circuit breaker & limits (Layer 5)
    const isCircuitBreakerSafe = await validateCircuitBreaker(portfolio.totalBalance);
    if (!isCircuitBreakerSafe) {
      // Drawdown limit crossed, kill open positions and freeze bot
      isTradingEnabled = false;
      await sendTelegramAlert(
        `🚨 *SpotTrader EMERGENCY CIRCUIT BREAKER TRIGGERED!*\n` +
        `• Realized drawdown limit exceeded today.\n` +
        `• *Action:* Closing all open positions immediately and freezing trading.`
      );
      await liquidateAllPositions();
      io.emit('status_update', { isTradingEnabled: false });
      return;
    }

    // 8. Place order if confirmed (Layer 6)
    if (confirmation.decision === 'BUY') {
      const kellySize = await calculateKellyPositionSize(portfolio.totalBalance, symbol);
      
      // Validate Exposure limits
      const isExposureAllowed = await validateExposureLimit(portfolio.totalBalance, kellySize, symbol);
      
      if (isExposureAllowed) {
        const stops = calculateStops(closedCandle.close, latestTechCandle.atr, 'BUY', stratConfig.slMultiplier, stratConfig.tpMultiplier);
        stops.votes = confirmation.votes; // Record what strategies voted
        
        await executeEntry(symbol, kellySize, stops, confirmation.regime);
      }
    } else if (confirmation.decision === 'SELL') {
      // Exit open positions if we hold any
      const openPosition = await get(`SELECT id FROM trades WHERE symbol = ? AND status = 'OPEN'`, [symbol]);
      if (openPosition) {
        await executeExit(openPosition.id, symbol, closedCandle.close, `VOTING_ENGINE_SELL_SIGNAL (${confirmation.reason})`);
      }
    }

    // 9. Monitor stops for SL/TP hits
    await monitorOpenPositions(symbol, closedCandle);

    // 10. Push updates to Dashboard
    const trades = await all(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT 20`);
    const logs = await all(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 20`);
    const updatedPortfolio = await getPortfolioBalance();

    io.emit('tick', {
      symbol,
      price: closedCandle.close,
      indicators: {
        rsi: latestTechCandle.rsi,
        macd: latestTechCandle.macd,
        macdHist: latestTechCandle.macdHist,
        bbUpper: latestTechCandle.bbUpper,
        bbLower: latestTechCandle.bbLower,
        vwap: latestTechCandle.vwap
      },
      confirmation,
      mlPredictions,
      portfolio: updatedPortfolio,
      trades,
      logs
    });

  } catch (err) {
    await logToDb('ERROR', 'SYSTEM', `Error in candle close process for ${symbol}: ${err.message}`);
  }
}

// Start the entire system
async function startBot() {
  // Live Trading Safety Failsafe Guard
  if (config.tradingMode === 'live' || config.tradingMode === 'testnet') {
    if (process.env.CONFIRM_LIVE_TRADING !== 'YES') {
      await initDatabase();
      await logToDb('ERROR', 'SYSTEM', 'CRITICAL HALT: Live trading selected but CONFIRM_LIVE_TRADING is not set to YES in .env file.');
      console.error('\n\x1b[41m\x1b[37m%s\x1b[0m\n', 'CRITICAL SAFETY HALT: Please set CONFIRM_LIVE_TRADING=YES in .env file to enable live execution. Exiting.');
      process.exit(1);
    }
  }

  await initDatabase();

  // Smart database reset check if initial balance configuration changed
  try {
    const lastBalanceEntry = await get(`SELECT balance FROM balance_history ORDER BY timestamp DESC LIMIT 1`);
    if (lastBalanceEntry && Math.abs(lastBalanceEntry.balance - config.paperInitialBalance) > 5.0) {
      await logToDb('WARNING', 'SYSTEM', `Initial balance change detected (Last DB: $${lastBalanceEntry.balance.toFixed(2)}, Config: $${config.paperInitialBalance.toFixed(2)}). Resetting paper trading history...`);
      await run(`DELETE FROM trades`);
      await run(`DELETE FROM balance_history`);
    }
  } catch (dbErr) {
    // Ignore if table is not seeded or query fails
  }

  await logToDb('INFO', 'SYSTEM', 'Initializing Spot Trader Bot Core...');

  await sendTelegramAlert(
    `🤖 *SpotTrader Bot Core Initialized*\n` +
    `• *Mode:* ${config.tradingMode.toUpperCase()}\n` +
    `• *Active Pairs:* ${config.symbols.join(', ')}\n` +
    `• *Initial Balance:* $${config.paperInitialBalance} USDT\n` +
    `• *System is online and running...*`
  );

  // Start RSS News feeds fetching
  await fetchNewsHeadlines();
  setInterval(fetchNewsHeadlines, 5 * 60 * 1000); // Check news every 5 minutes

  // Schedule weekly ML retrainer (every 7 days)
  setInterval(triggerWeeklyMLRetraining, 7 * 24 * 60 * 60 * 1000);

  // Seed portfolio balance history log
  await getPortfolioBalance();

  // Start ingestion & link the callback to our 6-layer pipeline
  await startDataIngestion(onCandleClose);

  server.listen(PORT, () => {
    logToDb('INFO', 'SYSTEM', `Core backend server running on port ${PORT}`);
  });
}

// Global Failsafe Exception Handlers to prevent bot shutdown while holding positions
process.on('uncaughtException', async (err) => {
  console.error('UNCAUGHT EXCEPTION CRASH PROTECTION:', err);
  try {
    const { logToDb } = require('./db/database');
    await logToDb('ERROR', 'SYSTEM', `CRITICAL UNCAUGHT EXCEPTION: ${err.message}. Engine loop active.`);
  } catch (e) {
    // Ignored
  }
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('UNHANDLED REJECTION CRASH PROTECTION:', reason);
  try {
    const { logToDb } = require('./db/database');
    await logToDb('ERROR', 'SYSTEM', `CRITICAL UNHANDLED REJECTION: ${reason?.message || reason}. Engine loop active.`);
  } catch (e) {
    // Ignored
  }
});

startBot();
