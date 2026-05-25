import os
import sqlite3
import pandas as pd
import numpy as np
import joblib
import logging
from sklearn.ensemble import RandomForestClassifier, IsolationForest
from sklearn.metrics import accuracy_score
from models import PyTorchLSTMWrapper

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("train_1h")

DEFAULT_DB = os.path.join(os.path.dirname(__file__), "..", "db", "trading_bot_1h.db")
DB_PATH = os.getenv("DB_PATH", DEFAULT_DB)
MODEL_DIR = os.path.join(os.path.dirname(__file__), "models_1h")


def load_candles_from_db(symbol: str) -> pd.DataFrame:
    """Loads all candles for a symbol from SQLite database."""
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found at {DB_PATH}. Backfill candles first.")

    conn = sqlite3.connect(DB_PATH)
    query = "SELECT timestamp, open, high, low, close, volume FROM candles WHERE symbol = ? ORDER BY timestamp ASC"
    df = pd.read_sql_query(query, conn, params=(symbol,))
    conn.close()
    return df


def calculate_pandas_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Calculates 40+ indicators matching taEngine.js."""
    df = df.copy()
    close = df['close']
    high = df['high']
    low = df['low']
    volume = df['volume']
    open_p = df['open']

    df['ema20'] = close.ewm(span=20, adjust=False).mean()
    df['ema50'] = close.ewm(span=50, adjust=False).mean()
    df['ema200'] = close.ewm(span=200, adjust=False).mean()

    for p in [7, 14, 21]:
        delta = close.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=p).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=p).mean()
        rs = gain / (loss + 1e-10)
        df[f'rsi{p}'] = 100 - (100 / (1 + rs))
    df['rsi'] = df['rsi14']

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    df['macd'] = ema12 - ema26
    df['macdSignal'] = df['macd'].ewm(span=9, adjust=False).mean()
    df['macdHist'] = df['macd'] - df['macdSignal']

    bb_middle = close.rolling(20).mean()
    bb_std = close.rolling(20).std()
    df['bbUpper'] = bb_middle + 2 * bb_std
    df['bbLower'] = bb_middle - 2 * bb_std
    df['bbWidth'] = (df['bbUpper'] - df['bbLower']) / (bb_middle + 1e-10)
    df['bbPctB'] = (close - df['bbLower']) / (df['bbUpper'] - df['bbLower'] + 1e-10)

    typical_price = (high + low + close) / 3
    df['vwap'] = (typical_price * volume).rolling(window=100).sum() / (volume.rolling(window=100).sum() + 1e-10)
    df['vwapRatio'] = close / (df['vwap'] + 1e-10)

    df['emaSpread20_50'] = (df['ema20'] - df['ema50']) / (close + 1e-10)
    df['emaSpread50_200'] = (df['ema50'] - df['ema200']) / (close + 1e-10)

    df['bodySize'] = (close - open_p).abs() / (open_p + 1e-10)
    df['upperWick'] = (high - df[['open', 'close']].max(axis=1)) / (open_p + 1e-10)
    df['lowerWick'] = (df[['open', 'close']].min(axis=1) - low) / (open_p + 1e-10)

    vol_sma20 = volume.rolling(20).mean()
    df['volumeRatio'] = volume / (vol_sma20 + 1e-10)

    df['sentiment'] = 0.0
    df['fearGreed'] = 50.0

    for lag in range(1, 6):
        df[f'return_lag_{lag}'] = close.pct_change(periods=lag)
        df[f'rsi_lag_{lag}'] = df['rsi'].shift(lag)
        df[f'macd_hist_lag_{lag}'] = df['macdHist'].shift(lag)
        df[f'vol_ratio_lag_{lag}'] = df['volumeRatio'].shift(lag)
        df[f'body_size_lag_{lag}'] = df['bodySize'].shift(lag)

    return df.dropna()


def generate_rf_labels(df: pd.DataFrame, future_window=15, profit_target=0.015, stop_loss=0.0075) -> pd.Series:
    """
    Labels candles based on profitable trade replay:
    - BUY (1): Close rises by profit_target % in future_window without dropping to stop_loss % first.
    - SELL (-1): Close drops by profit_target % without rising to stop_loss % first.
    - HOLD (0): Neither target is hit.
    """
    close = df['close'].values
    labels = np.zeros(len(df))

    for i in range(len(df) - future_window):
        current_price = close[i]
        future_prices = close[i + 1: i + 1 + future_window]

        pct_changes = (future_prices - current_price) / current_price

        buy_triggered = False
        sell_triggered = False

        for pct in pct_changes:
            if pct <= -stop_loss:
                sell_triggered = True
                break
            if pct >= profit_target:
                buy_triggered = True
                break

        for pct in pct_changes:
            if pct >= stop_loss:
                buy_triggered = True
                break
            if pct <= -profit_target:
                sell_triggered = True
                break

        if buy_triggered and not sell_triggered:
            labels[i] = 1
        elif sell_triggered and not buy_triggered:
            labels[i] = -1
        else:
            labels[i] = 0

    return pd.Series(labels, index=df.index)


def generate_lstm_labels(df: pd.DataFrame, future_window=5) -> pd.Series:
    """1 if price goes UP in future_window, else 0."""
    close = df['close'].values
    labels = np.zeros(len(df))
    for i in range(len(df) - future_window):
        if close[i + future_window] > close[i]:
            labels[i] = 1
    return pd.Series(labels, index=df.index)


def build_lstm_sequences(X_data, y_data, seq_len=30):
    """Reshapes flat vectors into sequences: (samples, seq_len, num_features)."""
    X_seq, y_seq = [], []
    for i in range(len(X_data) - seq_len):
        X_seq.append(X_data[i: i + seq_len])
        y_seq.append(y_data[i + seq_len])
    return np.array(X_seq), np.array(y_seq)


def train_pipeline(symbol: str):
    logger.info(f"--- Starting 1h training pipeline for {symbol} ---")
    try:
        df = load_candles_from_db(symbol)
    except Exception as e:
        logger.error(f"Cannot load database: {e}")
        return False

    if len(df) < 500:
        logger.warning(f"Insufficient candles for {symbol} ({len(df)} candles). Seed at least 500 candles.")
        return False

    df_features = calculate_pandas_indicators(df)

    feature_cols = [c for c in df_features.columns if c not in ['timestamp', 'open', 'high', 'low', 'close', 'volume']]

    X = df_features[feature_cols].values

    y_rf = generate_rf_labels(df_features).values
    y_lstm = generate_lstm_labels(df_features).values

    split_idx = int(len(X) * 0.8)

    X_train, X_test = X[:split_idx], X[split_idx:]
    y_rf_train, y_rf_test = y_rf[:split_idx], y_rf[split_idx:]

    logger.info("Training Random Forest Classifier...")
    rf = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, class_weight='balanced')
    rf.fit(X_train, y_rf_train)
    y_rf_pred = rf.predict(X_test)
    rf_acc = accuracy_score(y_rf_test, y_rf_pred)
    logger.info(f"Random Forest Test Accuracy: {rf_acc:.4f}")

    logger.info("Training Isolation Forest Anomaly Detector...")
    iso = IsolationForest(contamination=0.05, random_state=42)
    iso.fit(X_train)

    logger.info("Training LSTM Price Predictor...")
    seq_len = 30
    X_seq, y_seq = build_lstm_sequences(X, y_lstm, seq_len=seq_len)

    seq_split = int(len(X_seq) * 0.8)
    X_seq_train, X_seq_test = X_seq[:seq_split], X_seq[seq_split:]
    y_seq_train, y_seq_test = y_seq[:seq_split], y_seq[seq_split:]

    lstm_wrapper = PyTorchLSTMWrapper(input_dim=len(feature_cols), seq_len=seq_len)
    lstm_wrapper.train(X_seq_train, y_seq_train)

    correct = 0
    for i in range(len(X_seq_test)):
        direction, _ = lstm_wrapper.predict(X_seq_test[i])
        expected = 1 if y_seq_test[i] == 1 else -1
        if direction == expected:
            correct += 1
    lstm_acc = correct / len(X_seq_test) if len(X_seq_test) > 0 else 0
    logger.info(f"LSTM Test Directional Accuracy: {lstm_acc:.4f}")

    os.makedirs(MODEL_DIR, exist_ok=True)
    sym_safe = symbol.replace("/", "_")

    rf_path = os.path.join(MODEL_DIR, f"rf_{sym_safe}.joblib")
    iso_path = os.path.join(MODEL_DIR, f"iso_{sym_safe}.joblib")
    lstm_path = os.path.join(MODEL_DIR, f"lstm_{sym_safe}.model")

    joblib.dump(rf, rf_path)
    joblib.dump(iso, iso_path)
    lstm_wrapper.save(lstm_path)

    feature_names_path = os.path.join(MODEL_DIR, f"features_{sym_safe}.joblib")
    joblib.dump(feature_cols, feature_names_path)

    logger.info(f"Models successfully saved to {MODEL_DIR}")
    return True


if __name__ == "__main__":
    import sys
    symbol = "BTC/USDT"
    if len(sys.argv) > 1:
        symbol = sys.argv[1]

    success = train_pipeline(symbol)
    if success:
        print("Training successful!")
    else:
        print("Training failed or not enough candles.")
