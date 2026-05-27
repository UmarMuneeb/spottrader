require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

process.env.CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config_1h.json');

axios.defaults.headers.common['X-API-Token'] = process.env.ML_API_TOKEN || 'super_secret_trading_token_change_me';

const config = require('./config_1h.json');

const configPath = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), 'config_1h.json')
  : path.join(__dirname, 'config_1h.json');

if (process.env.DB_PATH && !fs.existsSync(configPath)) {
  try {
    fs.copyFileSync(path.join(__dirname, 'config_1h.json'), configPath);
  } catch (err) {
    console.error('Failed to copy config_1h.json to persistent volume:', err);
  }
}

try {
  const persistentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  Object.assign(config, persistentConfig);
} catch (err) {
  console.error('Failed to load persistent config:', err);
}

const { initDatabase, logToDb, all, get, run } = require('./db/database');
const { startDataIngestion, candleBuffers, orderBooks, macroSignals } = require('./services/binanceWs_1h');
const { computeTechnicalData, extractFeatureVector } = require('./services/taEngine');
const { evaluateConfirmation, processHeadlineSentiment } = require('./services/confirmEngine_1h');
const { calculateStops, calculateKellyPositionSize, validateExposureLimit, validateCircuitBreaker } = require('./services/riskEngine');
const { getPortfolioBalance, monitorOpenPositions, executeEntry, executeExit, liquidateAllPositions, getCurrentPrice } = require('./services/orderExecutor_1h');
const { sendTelegramAlert } = require('./services/telegram');

const app = express();
const server = http.createServer(app);

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

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3001;
let isTradingEnabled = true;

let dailyTrendCache = {}; // Cache of daily macro trend details per symbol

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForMlReady() {
  const maxWaitMs = 10 * 60 * 1000;
  const pollIntervalMs = 3000;
  const deadline = Date.now() + maxWaitMs;

  await logToDb('INFO', 'ML', 'Waiting for ML service to become ready...');

  while (Date.now() < deadline) {
    try {
      const res = await axios.get(`${config.mlServiceUrl}/status`, { timeout: 2000 });
      if (res.data?.status === 'ok') {
        const models = res.data.models_loaded || {};
        const allLoaded = config.symbols.every(sym => models[sym] === true);
        if (allLoaded) {
          await logToDb('INFO', 'ML', 'ML service ready. All models loaded.');
          return true;
        }
      }
    } catch (err) {
      // Keep waiting until ML is up
    }

    await sleep(pollIntervalMs);
  }

  await logToDb('WARNING', 'ML', 'ML service not ready after 10 minutes. Continuing with fallback behavior.');
  return false;
}

async function fetchDailyTrend() {
  try {
    const { exchange } = require('./services/binanceWs_1h');
    const config = require('./config_1h.json');
    const fetchSymbols = Array.from(new Set([...config.symbols, 'BTC/USDT']));

    for (const symbol of fetchSymbols) {
      try {
        await logToDb('INFO', 'DATA', `Fetching daily candles for ${symbol} macro bear shield check...`);
        const candles = await exchange.fetchOHLCV(symbol, '1d', undefined, 220);
        if (!candles || candles.length < 200) {
          throw new Error(`Insufficient daily candles returned (got ${candles ? candles.length : 0})`);
        }
        const closes = candles.map(c => c[4]);
        const k = 2 / (200 + 1);
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) {
          ema = closes[i] * k + ema * (1 - k);
        }
        const latestClose = closes[closes.length - 1];
        dailyTrendCache[symbol] = {
          aboveDailyEma200: latestClose > ema,
          dailyClose: latestClose,
          dailyEma200: ema
        };
        await logToDb(
          'INFO',
          'DATA',
          `${symbol} Daily Trend Updated. Close: $${latestClose.toFixed(2)}, Daily EMA-200: $${ema.toFixed(2)}. Bullish = ${latestClose > ema}`
        );
      } catch (symErr) {
        await logToDb('WARNING', 'DATA', `Failed to fetch daily trend for ${symbol}: ${symErr.message}`);
        if (!dailyTrendCache[symbol]) {
          dailyTrendCache[symbol] = {
            aboveDailyEma200: true,
            dailyClose: symbol === 'BTC/USDT' ? 60000 : 100,
            dailyEma200: symbol === 'BTC/USDT' ? 50000 : 80
          };
        }
      }
    }
  } catch (err) {
    await logToDb('WARNING', 'DATA', `Failed daily trend fetch routine: ${err.message}`);
  }
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

function getSymbolFromRequest(req) {
  const raw = req.params.symbol || req.query.symbol;
  if (!raw || typeof raw !== 'string') return null;
  return decodeURIComponent(raw);
}

app.get('/api/status', async (req, res) => {
  try {
    const portfolio = await getPortfolioBalance();

    let mlConnected = false;
    try {
      const mlStatus = await axios.get(`${config.mlServiceUrl}/status`, { timeout: 1000 });
      mlConnected = mlStatus.data.status === 'ok';
    } catch (e) {
      mlConnected = false;
    }

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

async function handleCandlesRequest(req, res) {
  try {
    const symbol = getSymbolFromRequest(req);
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required.' });
    }
    const candles = await all(
      `SELECT timestamp, open, high, low, close, volume FROM candles
       WHERE symbol = ? ORDER BY timestamp DESC LIMIT 100`,
      [symbol]
    );
    res.json(candles.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/candles/:symbol', handleCandlesRequest);
app.get('/api/candles', handleCandlesRequest);

async function handleInspectRequest(req, res) {
  try {
    const symbol = getSymbolFromRequest(req);
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required.' });
    }
    const candles = candleBuffers[symbol];
    if (!candles || candles.length < 200) {
      return res.status(400).json({ error: 'Not enough candle history yet.' });
    }

    const computedData = computeTechnicalData(candles);
    if (!computedData || computedData.length === 0) {
      return res.status(400).json({ error: 'Indicator computation not ready.' });
    }

    const latestTechCandle = computedData[computedData.length - 1];

    const rollingSentiment = await get(
      `SELECT AVG(score) as avg_score FROM sentiment WHERE timestamp >= ?`,
      [Date.now() - 1 * 60 * 60 * 1000]
    );
    const sentimentScore = parseFloat(rollingSentiment.avg_score || 0.0);

    const featureVector = extractFeatureVector(
      computedData,
      computedData.length - 1,
      sentimentScore,
      macroSignals.fearAndGreed
    );

    if (!featureVector) {
      return res.status(400).json({ error: 'Feature vector not ready.' });
    }

    const sequence = [];
    for (let i = computedData.length - 30; i < computedData.length; i++) {
      sequence.push(extractFeatureVector(computedData, i, sentimentScore, macroSignals.fearAndGreed));
    }

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

    const portfolio = await getPortfolioBalance();
    const { getStrategyConfig } = require('./services/riskEngine');
    const stratConfig = await getStrategyConfig(portfolio.totalBalance, symbol);
    
    const assetTrend = dailyTrendCache[symbol] || { aboveDailyEma200: true, dailyClose: latestTechCandle.close, dailyEma200: latestTechCandle.close };
    const btcTrend = dailyTrendCache['BTC/USDT'] || { aboveDailyEma200: true, dailyClose: 60000, dailyEma200: 50000 };

    const confirmation = await evaluateConfirmation(
      symbol,
      latestTechCandle,
      mlPredictions,
      fearAndGreed = macroSignals.fearAndGreed,
      stratConfig,
      assetTrend.aboveDailyEma200,
      assetTrend.dailyClose,
      assetTrend.dailyEma200,
      btcTrend.aboveDailyEma200,
      btcTrend.dailyClose,
      btcTrend.dailyEma200
    );

    const trades = await all(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT 20`);
    const logs = await all(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 20`);

    return res.json({
      symbol,
      price: latestTechCandle.close,
      indicators: {
        rsi: latestTechCandle.rsi,
        macd: latestTechCandle.macd,
        macdHist: latestTechCandle.macdHist,
        bbUpper: latestTechCandle.bbUpper,
        bbLower: latestTechCandle.bbLower,
        vwap: latestTechCandle.vwap,
        ema20: latestTechCandle.ema20,
        ema50: latestTechCandle.ema50,
        sma50: latestTechCandle.sma50
      },
      confirmation,
      mlPredictions,
      portfolio,
      trades,
      logs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/inspect/:symbol', handleInspectRequest);
app.get('/api/inspect', handleInspectRequest);

app.post('/api/settings', async (req, res) => {
  try {
    const { tradingMode, exposureLimitPct, votingThreshold, cooldownMinutes, enableAnomalyFilter } = req.body;

    if (tradingMode !== undefined) config.tradingMode = tradingMode;
    if (exposureLimitPct !== undefined) config.exposureLimitPct = parseFloat(exposureLimitPct);
    if (votingThreshold !== undefined) config.votingThreshold = parseFloat(votingThreshold);
    if (cooldownMinutes !== undefined) config.cooldownMinutes = parseInt(cooldownMinutes);
    if (enableAnomalyFilter !== undefined) config.enableAnomalyFilter = enableAnomalyFilter;

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
      const stops = calculateStops(price, price * 0.01);
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

      const matches = xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g);
      let count = 0;
      for (const match of matches) {
        let headline = match[1] || match[2];
        if (!headline) continue;
        headline = headline.replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();

        if (
          headline.includes('Cointelegraph') ||
          headline.includes('CoinDesk') ||
          headline.toLowerCase().includes('rss feed') ||
          headline.length < 15
        ) {
          continue;
        }

        const exists = await get(`SELECT id FROM sentiment WHERE title = ?`, [headline]);
        if (!exists) {
          await processHeadlineSentiment(null, headline, 'RSS');
          count++;
          if (count >= 5) break;
        }
      }
    } catch (err) {
      await logToDb('WARNING', 'DATA', `Failed reading RSS feed ${url}: ${err.message}`);
    }
  }
}

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

io.on('connection', (socket) => {
  console.log('Dashboard Client connected via Socket.io');
  socket.emit('init', { symbols: config.symbols });
});

async function onCandleClose(symbol, closedCandle) {
  if (!isTradingEnabled) return;

  try {
    const portfolio = await getPortfolioBalance();
    const { getStrategyConfig } = require('./services/riskEngine');
    const stratConfig = await getStrategyConfig(portfolio.totalBalance, symbol);

    if (!stratConfig.pairs.includes(symbol)) {
      return;
    }

    const candles = candleBuffers[symbol];
    if (!candles || candles.length < 200) {
      await logToDb('WARNING', 'SYSTEM', `Waiting for more historical candle buffers for ${symbol} (${candles ? candles.length : 0}/200)`);
      return;
    }

    const computedData = computeTechnicalData(candles);
    const latestTechCandle = computedData[computedData.length - 1];

    const rollingSentiment = await get(`SELECT AVG(score) as avg_score FROM sentiment WHERE timestamp >= ?`, [Date.now() - 1 * 60 * 60 * 1000]);
    const sentimentScore = parseFloat(rollingSentiment.avg_score || 0.0);

    const featureVector = extractFeatureVector(computedData, computedData.length - 1, sentimentScore, macroSignals.fearAndGreed);

    const sequence = [];
    for (let i = computedData.length - 30; i < computedData.length; i++) {
      sequence.push(extractFeatureVector(computedData, i, sentimentScore, macroSignals.fearAndGreed));
    }

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

    const assetTrend = dailyTrendCache[symbol] || { aboveDailyEma200: true, dailyClose: latestTechCandle.close, dailyEma200: latestTechCandle.close };
    const btcTrend = dailyTrendCache['BTC/USDT'] || { aboveDailyEma200: true, dailyClose: 60000, dailyEma200: 50000 };

    const confirmation = await evaluateConfirmation(
      symbol,
      latestTechCandle,
      mlPredictions,
      fearAndGreed = macroSignals.fearAndGreed,
      stratConfig,
      assetTrend.aboveDailyEma200,
      assetTrend.dailyClose,
      assetTrend.dailyEma200,
      btcTrend.aboveDailyEma200,
      btcTrend.dailyClose,
      btcTrend.dailyEma200
    );

    const isCircuitBreakerSafe = await validateCircuitBreaker(portfolio.totalBalance);
    if (!isCircuitBreakerSafe) {
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

    if (confirmation.decision === 'BUY') {
      const kellySize = await calculateKellyPositionSize(portfolio.totalBalance, symbol);

      const isExposureAllowed = await validateExposureLimit(portfolio.totalBalance, kellySize, symbol);

      if (isExposureAllowed) {
        const stops = calculateStops(closedCandle.close, latestTechCandle.atr, 'BUY', stratConfig.slMultiplier, stratConfig.tpMultiplier);
        stops.votes = confirmation.votes;

        await executeEntry(symbol, kellySize, stops, confirmation.regime);
      }
    } else if (confirmation.decision === 'SELL') {
      const openPosition = await get(`SELECT id FROM trades WHERE symbol = ? AND status = 'OPEN'`, [symbol]);
      if (openPosition) {
        await executeExit(openPosition.id, symbol, closedCandle.close, `VOTING_ENGINE_SELL_SIGNAL (${confirmation.reason})`);
      }
    }

    await monitorOpenPositions(symbol, closedCandle);

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
        vwap: latestTechCandle.vwap,
        ema20: latestTechCandle.ema20,
        ema50: latestTechCandle.ema50,
        sma50: latestTechCandle.sma50
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

async function startBot() {
  if (config.tradingMode === 'live' || config.tradingMode === 'testnet') {
    if (process.env.CONFIRM_LIVE_TRADING !== 'YES') {
      await initDatabase();
      await logToDb('ERROR', 'SYSTEM', 'CRITICAL HALT: Live trading selected but CONFIRM_LIVE_TRADING is not set to YES in .env file.');
      console.error('\n\x1b[41m\x1b[37m%s\x1b[0m\n', 'CRITICAL SAFETY HALT: Please set CONFIRM_LIVE_TRADING=YES in .env file to enable live execution. Exiting.');
      process.exit(1);
    }
  }

  await initDatabase();

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

  await logToDb('INFO', 'SYSTEM', 'Initializing Spot Trader Bot Core (1h)...');

  await sendTelegramAlert(
    `🤖 *SpotTrader Bot Core Initialized (1h)*\n` +
    `• *Mode:* ${config.tradingMode.toUpperCase()}\n` +
    `• *Active Pairs:* ${config.symbols.join(', ')}\n` +
    `• *Initial Balance:* $${config.paperInitialBalance} USDT\n` +
    `• *System is online and running...*`
  );

  waitForMlReady();

  await fetchNewsHeadlines();
  setInterval(fetchNewsHeadlines, 5 * 60 * 1000);

  setInterval(triggerWeeklyMLRetraining, 7 * 24 * 60 * 60 * 1000);

  await getPortfolioBalance();

  async function onRealtimeTick(symbol, price, high, low) {
    if (!isTradingEnabled) return;
    try {
      const { monitorOpenPositionsRealtime } = require('./services/orderExecutor_1h');
      await monitorOpenPositionsRealtime(symbol, price, high, low);
    } catch (err) {
      // Silent error fallback
    }
  }

  server.listen(PORT, async () => {
    await logToDb('INFO', 'SYSTEM', `Core backend server running on port ${PORT}`);
    
    // Launch data ingestion and macro bear scans in background so the port is active instantly
    startDataIngestion(onCandleClose, onRealtimeTick)
      .then(async () => {
        await fetchDailyTrend();
        setInterval(fetchDailyTrend, 4 * 60 * 60 * 1000);
      })
      .catch(async (err) => {
        await logToDb('ERROR', 'SYSTEM', `Failed starting background data ingestion: ${err.message}`);
      });
  });
}

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
