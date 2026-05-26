const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'trading_bot.db');
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

// Helper function to run SQL queries in a promise wrapper
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Helper function to get a single row
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helper function to get all rows
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDatabase() {
  // Use TRUNCATE journal mode instead of WAL since WAL is not supported on network filesystems like Modal Volumes
  await run('PRAGMA journal_mode=TRUNCATE;');

  // Candles Table
  await run(`
    CREATE TABLE IF NOT EXISTS candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      UNIQUE(symbol, timestamp)
    )
  `);

  // Trades Table
  await run(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      price REAL NOT NULL,
      quantity REAL NOT NULL,
      usdt_amount REAL NOT NULL,
      stop_loss REAL,
      take_profit REAL,
      timestamp INTEGER NOT NULL,
      status TEXT NOT NULL, -- OPEN, CLOSED, CANCELLED
      pnl REAL DEFAULT 0.0,
      exit_price REAL,
      exit_timestamp INTEGER,
      execution_type TEXT NOT NULL, -- paper, live
      signals TEXT -- JSON representation of votes and ML scores
    )
  `);

  // Sentiment Table
  await run(`
    CREATE TABLE IF NOT EXISTS sentiment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  // Balance History Table (Tracks portfolio value for chart/drawdown circuit breaker)
  await run(`
    CREATE TABLE IF NOT EXISTS balance_history (
      timestamp INTEGER PRIMARY KEY,
      balance REAL NOT NULL,
      unrealized_pnl REAL NOT NULL DEFAULT 0.0
    )
  `);

  // System Logs / Audit Trail Table
  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      level TEXT NOT NULL, -- INFO, WARNING, ERROR
      category TEXT NOT NULL, -- DATA, ML, STRATEGY, CONFIRM, RISK, EXECUTION, SYSTEM
      message TEXT NOT NULL
    )
  `);

  // Index creation for speed
  await run(`CREATE INDEX IF NOT EXISTS idx_candles_sym_ts ON candles (symbol, timestamp DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_trades_sym_ts ON trades (symbol, timestamp DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sentiment_ts ON sentiment (timestamp DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON audit_logs (timestamp DESC)`);

  // Alter table if needed to add regime column
  try {
    await run(`ALTER TABLE trades ADD COLUMN regime TEXT DEFAULT 'NEUTRAL'`);
  } catch (err) {
    // Suppress error if column already exists (e.g. "duplicate column name")
  }

  // Alter table if needed to add oco_order_id column
  try {
    await run(`ALTER TABLE trades ADD COLUMN oco_order_id TEXT`);
  } catch (err) {
    // Suppress error if column already exists
  }

  console.log(`Database initialized successfully at: ${DB_PATH}`);
}

// Log message to database and console
async function logToDb(level, category, message) {
  const timestamp = Date.now();
  console.log(`[${new Date(timestamp).toISOString()}] [${level}] [${category}] ${message}`);
  try {
    await run(
      `INSERT INTO audit_logs (timestamp, level, category, message) VALUES (?, ?, ?, ?)`,
      [timestamp, level, category, message]
    );
  } catch (err) {
    console.error('Failed to log to database:', err);
  }
}

module.exports = {
  db,
  initDatabase,
  run,
  get,
  all,
  logToDb
};
