const WebSocket = require('ws');
const ccxt = require('ccxt');
const axios = require('axios');
const config = require('../config_1h.json');
const { run, get, all, logToDb } = require('../db/database');

let ws = null;
const orderBooks = {}; // Store latest orderbook depth per symbol
const candleBuffers = {}; // Store in-memory rolling buffer of last 500 closed 1h candles
let macroSignals = { fearAndGreed: 50 }; // Default neutral

// Setup CCXT exchange instance
const useBinanceUs = process.env.USE_BINANCE_US === 'YES';
const exchange = useBinanceUs
  ? new ccxt.binanceus({
      enableRateLimit: true,
      options: { defaultType: 'spot' }
    })
  : new ccxt.binance({
      enableRateLimit: true,
      options: { defaultType: 'spot' }
    });

// Format CCXT symbol (BTC/USDT) to Binance stream format (btcusdt)
function toBinanceStreamSymbol(symbol) {
  return symbol.replace('/', '').toLowerCase();
}

// Format Binance symbol (BTCUSDT) to CCXT symbol (BTC/USDT)
function toCcxtSymbol(binanceSymbol) {
  if (binanceSymbol.endsWith('USDT')) {
    return binanceSymbol.replace('USDT', '/USDT');
  }
  return binanceSymbol;
}

// Backfill historical candles on startup
async function backfillCandles(symbol, timeframe = '1h', limit = 500) {
  try {
    await logToDb('INFO', 'DATA', `Backfilling ${limit} candles (${timeframe}) for ${symbol}...`);
    const since = exchange.milliseconds() - limit * 60 * 60 * 1000;
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, since, limit);

    let inserted = 0;
    for (const candle of ohlcv) {
      const [timestamp, open, high, low, close, volume] = candle;
      try {
        await run(
          `INSERT OR IGNORE INTO candles (symbol, timestamp, open, high, low, close, volume)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [symbol, timestamp, open, high, low, close, volume]
        );
        inserted++;
      } catch (err) {
        // Suppress duplicate errors
      }
    }

    // Seed in-memory buffer
    const dbCandles = await all(
      `SELECT timestamp, open, high, low, close, volume FROM candles
       WHERE symbol = ? ORDER BY timestamp ASC LIMIT ?`,
      [symbol, limit]
    );
    candleBuffers[symbol] = dbCandles;

    await logToDb('INFO', 'DATA', `Backfilled ${inserted} candles. Local buffer has ${candleBuffers[symbol].length} candles for ${symbol}.`);
  } catch (err) {
    await logToDb('ERROR', 'DATA', `Failed to backfill ${symbol}: ${err.message}`);
  }
}

// Fetch Fear & Greed Index
async function fetchFearAndGreed() {
  try {
    const res = await axios.get('https://api.alternative.me/fng/');
    if (res.data && res.data.data && res.data.data[0]) {
      const value = parseInt(res.data.data[0].value, 10);
      macroSignals.fearAndGreed = value;
      await logToDb('INFO', 'DATA', `Fetched Crypto Fear & Greed Index: ${value}`);
    }
  } catch (err) {
    await logToDb('WARNING', 'DATA', `Failed to fetch Fear & Greed Index: ${err.message}`);
  }
}

// Setup WebSocket connection to Binance
async function initWebSocket(onCandleCloseCallback) {
  const streams = [];
  config.symbols.forEach(symbol => {
    const streamSymbol = toBinanceStreamSymbol(symbol);
    streams.push(`${streamSymbol}@kline_1h`);
    streams.push(`${streamSymbol}@depth5`);
  });

  const wsHost = useBinanceUs ? 'stream.binance.us:9443' : 'stream.binance.com:9443';
  const wsUrl = `wss://${wsHost}/stream?streams=${streams.join('/')}`;
  await logToDb('INFO', 'DATA', `Connecting to Binance WebSocket: ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.on('open', async () => {
    await logToDb('INFO', 'DATA', 'Binance WebSocket connected.');
  });

  ws.on('message', async (data) => {
    try {
      const payload = JSON.parse(data);
      const stream = payload.stream;
      const msg = payload.data;

      if (stream.includes('@kline_1h')) {
        const symbol = toCcxtSymbol(msg.s);
        const kline = msg.k;
        const isClosed = kline.x;
        const timestamp = kline.t;
        const open = parseFloat(kline.o);
        const high = parseFloat(kline.h);
        const low = parseFloat(kline.l);
        const close = parseFloat(kline.c);
        const volume = parseFloat(kline.v);

        if (!candleBuffers[symbol]) {
          candleBuffers[symbol] = [];
        }

        if (isClosed) {
          await run(
            `INSERT OR IGNORE INTO candles (symbol, timestamp, open, high, low, close, volume)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [symbol, timestamp, open, high, low, close, volume]
          );

          const newCandle = { timestamp, open, high, low, close, volume };
          const idx = candleBuffers[symbol].findIndex(c => c.timestamp === timestamp);
          if (idx !== -1) {
            candleBuffers[symbol][idx] = newCandle;
          } else {
            candleBuffers[symbol].push(newCandle);
            if (candleBuffers[symbol].length > 500) {
              candleBuffers[symbol].shift();
            }
          }

          await logToDb('INFO', 'DATA', `Candle CLOSED for ${symbol}: Close = ${close}, Vol = ${volume}`);

          if (onCandleCloseCallback) {
            onCandleCloseCallback(symbol, newCandle);
          }
        }
      } else if (stream.includes('@depth5')) {
        const symbol = toCcxtSymbol(msg.s || stream.split('@')[0].toUpperCase());
        const bids = msg.bids.map(b => [parseFloat(b[0]), parseFloat(b[1])]);
        const asks = msg.asks.map(a => [parseFloat(a[0]), parseFloat(a[1])]);

        const bestBid = bids[0] ? bids[0][0] : 0;
        const bestAsk = asks[0] ? asks[0][0] : 0;
        const spread = bestAsk - bestBid;

        const totalBidVol = bids.reduce((acc, curr) => acc + curr[1], 0);
        const totalAskVol = asks.reduce((acc, curr) => acc + curr[1], 0);
        const imbalance = (totalBidVol - totalAskVol) / (totalBidVol + totalAskVol || 1);

        orderBooks[symbol] = {
          bids,
          asks,
          bestBid,
          bestAsk,
          spread,
          imbalance,
          timestamp: Date.now()
        };
      }
    } catch (err) {
      await logToDb('ERROR', 'DATA', `Error parsing WebSocket message: ${err.message}`);
    }
  });

  ws.on('close', async (code, reason) => {
    await logToDb('WARNING', 'DATA', `Binance WebSocket closed (code: ${code}, reason: ${reason}). Reconnecting in 5 seconds...`);
    ws = null;
    setTimeout(() => initWebSocket(onCandleCloseCallback), 5000);
  });

  ws.on('error', async (err) => {
    await logToDb('ERROR', 'DATA', `Binance WebSocket error: ${err.message}`);
  });
}

async function startDataIngestion(onCandleCloseCallback) {
  try {
    await exchange.loadMarkets();
    await logToDb('INFO', 'DATA', 'Loaded exchange markets successfully for dynamic limits.');
  } catch (err) {
    await logToDb('WARNING', 'DATA', `Failed to load exchange markets: ${err.message}. Falling back to default limits.`);
  }

  await fetchFearAndGreed();
  setInterval(fetchFearAndGreed, 3600 * 1000);

  for (const symbol of config.symbols) {
    await backfillCandles(symbol, '1h', 1000);
  }

  initWebSocket(onCandleCloseCallback);
}

module.exports = {
  startDataIngestion,
  candleBuffers,
  orderBooks,
  macroSignals,
  exchange
};
