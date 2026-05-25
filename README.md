# ⚡ SpotTrader — Autonomous ML Spot Trading Engine

SpotTrader is a state-of-the-art, 6-layer autonomous cryptocurrency trading bot that leverages a hybrid **Node.js Core Coordinator** and a **Python FastAPI Machine Learning Engine**. 

Designed for high-reliability 24/7 execution, the system processes multi-source data (Binance WebSockets, RSS news sentiment, and macro signals) to execute intelligent spot trades under active risk management constraints.

---

## 🏗️ 6-Layer Architecture

```
 ┌────────────────────────────────────────────────────────┐
 │ 1. DATA INGESTION (Node.js & Python)                   │
 │    - Real-Time Binance WS (OHLCV & Depth-5 Order Books)│
 │    - RSS News Aggregation (CoinDesk, Cointelegraph)     │
 │    - Macro Indicators (Crypto Fear & Greed Index)       │
 └───────────────────────────┬────────────────────────────┘
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │ 2. MACHINE LEARNING ENGINE (Python FastAPI)            │
 │    - Random Forest Classifier (Directional prediction) │
 │    - PyTorch LSTM RNN (Short-term sequence mapping)    │
 │    - NLP Sentiment Analyzer (FinBERT & VADER)          │
 │    - Isolation Forest (Anomaly detection safety net)   │
 └───────────────────────────┬────────────────────────────┘
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │ 3. TECHNICAL STRATEGY (Node.js TA Engine)              │
 │    - Multi-indicator Math (RSI, MACD, BB, EMAs, VWAP)  │
 └───────────────────────────┬────────────────────────────┘
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │ 4. SIGNAL CONFIRMATION (Node.js)                       │
 │    - Weighted Voting Engine (ML votes count double)    │
 │    - Sentiment Filter Gate (Avg rolling sentiment > -0.3)│
 │    - Cooldown & Signal Deduplication Safeguards        │
 └───────────────────────────┬────────────────────────────┘
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │ 5. RISK MANAGEMENT (Node.js)                           │
 │    - Stop Loss (SL) & Take Profit (TP) via ATR multipliers│
 │    - Position sizing via Kelly Criterion                  │
 │    - Daily 3% Equity Drawdown Circuit Breaker           │
 │    - Max Portfolio Exposure Cap (e.g. 30% of total)    │
 └───────────────────────────┬────────────────────────────┘
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │ 6. POSITION EXECUTION & MONITORING (Node.js)           │
 │    - Simulated Paper Trading / Live Binance OCO orders │
 │    - Weekly Auto-retraining Pipeline for ML models     │
 │    - Real-time Glassmorphism Web Dashboard             │
 └────────────────────────────────────────────────────────┘
```

---

## 📂 Project Directory Structure

*   [`server.js`](file:///c:/Users/umarm/Desktop/umar/spottrader/server.js): Main Node.js entry point for the **1-minute** interval trading bot.
*   [`server_1h.js`](file:///c:/Users/umarm/Desktop/umar/spottrader/server_1h.js): Node.js entry point for the **1-hour** interval trading bot.
*   [`ecosystem.config.js`](file:///c:/Users/umarm/Desktop/umar/spottrader/ecosystem.config.js): PM2 process configuration for VPS/Droplet deployments.
*   [`ml/`](file:///c:/Users/umarm/Desktop/umar/spottrader/ml): Python Machine Learning service files:
    *   [`ml/server.py`](file:///c:/Users/umarm/Desktop/umar/spottrader/ml/server.py): FastAPI backend serving 1-minute ML model inferences.
    *   [`ml/server_1h.py`](file:///c:/Users/umarm/Desktop/umar/spottrader/ml/server_1h.py): FastAPI backend serving 1-hour ML model inferences.
    *   [`ml/models.py`](file:///c:/Users/umarm/Desktop/umar/spottrader/ml/models.py): PyTorch LSTM wrappers, Random Forest setups, and Isolation Forest models.
    *   [`ml/sentiment.py`](file:///c:/Users/umarm/Desktop/umar/spottrader/ml/sentiment.py): FinBERT & VADER natural language sentiment processors.
*   [`services/`](file:///c:/Users/umarm/Desktop/umar/spottrader/services): Modular business logic for technical indicators, confirmation rules, risk calculations, and orders.
*   [`db/`](file:///c:/Users/umarm/Desktop/umar/spottrader/db): Seeding script, SQLite database schemas (`db/database.js`), and isolated configuration files.
*   [`public/`](file:///c:/Users/umarm/Desktop/umar/spottrader/public): Glassmorphism HTML/CSS/JS frontend dashboard.
*   [`modal_app.py`](file:///c:/Users/umarm/Desktop/umar/spottrader/modal_app.py) & [`modal_app_1h.py`](file:///c:/Users/umarm/Desktop/umar/spottrader/modal_app_1h.py): Python Modal cloud deployment configurations.

---

## 🛠️ Installation & Setup

### Prerequisites
*   Node.js (v18+)
*   Python (3.10+)

### 1. Clone Repository & Install Node Packages
```bash
git clone https://github.com/UmarMuneeb/spottrader.git
cd spottrader
npm install
```

### 2. Configure Python Virtual Environment & Install Dependencies
```bash
# Create environment
python -m venv venv

# Activate on Windows
venv\Scripts\activate
# Activate on Mac/Linux
source venv/bin/activate

# Install requirements
pip install -r ml/requirements.txt
```

### 3. Environment Variables (`.env`)
Create a `.env` file in the root directory:
```env
# Binance API Credentials
BINANCE_API_KEY=your_binance_api_key
BINANCE_SECRET_KEY=your_binance_api_secret

# Security Token (For Node -> Python API authentication)
ML_API_TOKEN=super_secret_trading_token_change_me

# Live Execution Switch
CONFIRM_LIVE_TRADING=NO   # Set to YES for real money trading on Binance

# Regional / Geo Routing (Set to YES to bypass US restrictions)
USE_BINANCE_US=YES

# Notification Settings
TELEGRAM_BOT_TOKEN=optional_telegram_token
TELEGRAM_CHAT_ID=optional_chat_id
```

---

## 💻 Running Locally

### Step 1: Run the ML Engine
Make sure your virtual environment is active:
```bash
# For 1-Minute Interval ML
python ml/server.py

# For 1-Hour Interval ML
python ml/server_1h.py
```
*   The 1m ML server binds to `http://127.0.0.1:5000`.
*   The 1h ML server binds to `http://127.0.0.1:5001`.

### Step 2: Run the Bot Coordinator
In a separate terminal, launch the Node.js process:
```bash
# For 1-Minute Bot (serves UI at http://localhost:3000)
node server.js

# For 1-Hour Bot (serves UI at http://localhost:3001)
node server_1h.js
```

---

## 🚀 Deployment Options

### 1. DigitalOcean / VPS Deployment (Using PM2)
PM2 ensures both Node.js and FastAPI run continuously in the background and survive system reboots.

```bash
# Install PM2 globally
npm install -g pm2

# Start both 1h servers (Node + Python ML) defined in ecosystem.config.js
pm2 start ecosystem.config.js --only spottrader-node-1h,spottrader-ml-1h

# Save PM2 state to restart on boot
pm2 save
pm2 startup

# Monitor live logs
pm2 logs
```

### 2. Modal Cloud Deployment (Serverless GPU/CPU)
Deploy the trading bot as a containerized app on [Modal](https://modal.com):
```bash
# Deploy the 1-hour interval bot
modal deploy modal_app_1h.py

# Deploy the 1-minute interval bot
modal deploy modal_app.py
```

### 3. Vercel Frontend Deployment
To deploy the Glassmorphic UI dashboard independently on Vercel:
1. Import the repository into Vercel.
2. Select **Other** as the Framework Preset and set the root directory to the repository root.
3. Deploy! (Vercel automatically serves the static assets in `/public`).
4. Append `?backend=http://<droplet_ip>:3001` in your browser URL to target your active API server.

*Note: Browsers block insecure HTTP calls from HTTPS domains (Mixed Content). Direct direct browser access to your VPS server (`http://<ip>:3001`) is recommended unless you bind an SSL domain certificate to the droplet IP.*

---

## 📊 Database Schema (SQLite)

The system automatically initializes an SQLite database inside `db/` (e.g. `db/trading_bot_1h.db`) to audit performance and safety:
*   `candles`: High-speed local OHLCV buffers.
*   `trades`: Position ledgers containing entries, SL, TP, final PnL, strategy votes, and regime tags.
*   `sentiment`: Cached RSS headlines and calculated natural language scores.
*   `balance_history`: Equity balance logs mapping the portfolio growth curve.
*   `audit_logs`: Engine diagnostics logs categorized by modules (`ML`, `RISK`, `EXECUTION`, etc.).

---

## 🔒 Safety & Risk Features

*   **ATR Volatility Bands**: Stop Loss (SL) is set to `1.5x ATR` and Take Profit (TP) to `3.0x ATR` dynamically relative to current volatility.
*   **Exposure Cap**: Blocks entries if the total active capital allocated exceeds the `exposureLimitPct` threshold (default: 30%).
*   **Daily Drawdown Circuit Breaker**: If realized equity falls by more than `3%` in a 24-hour window, all open positions are immediately liquidated on the exchange, and trading freezes.
*   **Hysteresis Guard**: Dynamic tier evaluation includes a 30-minute hysteresis buffer to prevent flip-flopping configurations in noisy market states.
*   **Isolation Forest Anomaly Filter**: Evaluates indicators against historically standard trades. Out-of-bounds metrics flag the trade as an anomaly and trigger automatic rejection.
