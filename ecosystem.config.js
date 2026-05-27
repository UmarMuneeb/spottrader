module.exports = {
  apps: [
    // ------------------ 1-Hour Interval Bot ------------------
    {
      name: 'spottrader-node-1h',
      script: 'server_1h.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        PYTHON_PORT: 5001,
        DB_PATH: 'db/trading_bot_1h.db',
        ML_API_TOKEN: 'super_secret_trading_token_change_me',
        CONFIRM_LIVE_TRADING: 'NO',
        FEE_RATE: '0.001'
      }
    },
    {
      name: 'spottrader-ml-1h',
      script: 'ml/server_1h.py',
      cwd: __dirname,
      interpreter: 'venv/bin/python',
      env: {
        PYTHONIOENCODING: 'utf-8',
        PORT: 5001
      }
    },

    // ------------------ 1-Minute Interval Bot ------------------
    {
      name: 'spottrader-node-1m',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        PYTHON_PORT: 5000,
        DB_PATH: 'db/trading_bot.db',
        ML_API_TOKEN: 'super_secret_trading_token_change_me',
        CONFIRM_LIVE_TRADING: 'NO',
        FEE_RATE: '0.001'
      }
    },
    {
      name: 'spottrader-ml-1m',
      script: 'ml/server.py',
      cwd: __dirname,
      interpreter: 'venv/bin/python',
      env: {
        PYTHONIOENCODING: 'utf-8',
        PORT: 5000
      }
    }
  ]
};
