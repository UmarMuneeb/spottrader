import os
import joblib
import logging
from fastapi import FastAPI, HTTPException, Depends
from fastapi.security.api_key import APIKeyHeader
from starlette.status import HTTP_403_FORBIDDEN
from pydantic import BaseModel
from typing import List, Dict
from sentiment import get_sentiment_score
from models import PyTorchLSTMWrapper
from train_1h import train_pipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ml_server_1h")

API_KEY_HEADER = APIKeyHeader(name="X-API-Token", auto_error=False)


def verify_token(api_key: str = Depends(API_KEY_HEADER)):
    expected_token = os.getenv("ML_API_TOKEN", "super_secret_trading_token_change_me")
    if api_key != expected_token:
        raise HTTPException(
            status_code=HTTP_403_FORBIDDEN,
            detail="Access Forbidden: Invalid ML API Token"
        )


app = FastAPI(
    title="Binance Spot Trading Bot ML Engine (1h)",
    version="1.0",
    dependencies=[Depends(verify_token)]
)

MODELS = {}
MODEL_DIR = os.path.join(os.path.dirname(__file__), "models_1h")


def get_model_paths(symbol: str):
    sym_safe = symbol.replace("/", "_")
    return {
        "rf": os.path.join(MODEL_DIR, f"rf_{sym_safe}.joblib"),
        "iso": os.path.join(MODEL_DIR, f"iso_{sym_safe}.joblib"),
        "lstm": os.path.join(MODEL_DIR, f"lstm_{sym_safe}.model"),
        "features": os.path.join(MODEL_DIR, f"features_{sym_safe}.joblib")
    }


def load_models_for_symbol(symbol: str) -> bool:
    paths = get_model_paths(symbol)

    if not (os.path.exists(paths["rf"]) and os.path.exists(paths["iso"]) and os.path.exists(paths["lstm"]) and os.path.exists(paths["features"])):
        logger.warning(f"Models for {symbol} not found. Attempting to train on-the-fly...")
        success = train_pipeline(symbol)
        if not success:
            logger.error(f"On-the-fly training failed for {symbol}. Will use fallback predictors.")
            return False

    try:
        features = joblib.load(paths["features"])
        rf = joblib.load(paths["rf"])
        iso = joblib.load(paths["iso"])

        lstm_wrapper = PyTorchLSTMWrapper(input_dim=len(features))
        lstm_wrapper.load(paths["lstm"])

        MODELS[symbol] = {
            "rf": rf,
            "iso": iso,
            "lstm": lstm_wrapper,
            "features": features
        }
        logger.info(f"Loaded ML models for {symbol} successfully.")
        return True
    except Exception as e:
        logger.error(f"Error loading models for {symbol}: {e}")
        return False


class PredictRequest(BaseModel):
    symbol: str
    features: Dict[str, float]
    sequence: List[Dict[str, float]]


class SentimentRequest(BaseModel):
    text: str


class TrainRequest(BaseModel):
    symbol: str


@app.on_event("startup")
def startup_event():
    logger.info("FastAPI ML Server (1h) starting...")
    for sym in ["SOL/USDT", "ETH/USDT", "BNB/USDT", "BTC/USDT"]:
        load_models_for_symbol(sym)


@app.get("/status")
def get_status():
    status = {}
    for sym in ["SOL/USDT", "ETH/USDT", "BNB/USDT", "BTC/USDT"]:
        status[sym] = sym in MODELS
    return {"status": "ok", "models_loaded": status}


@app.post("/sentiment")
def analyze_sentiment(request: SentimentRequest):
    score = get_sentiment_score(request.text)
    return {"text": request.text, "score": score}


@app.post("/train")
def train_model(request: TrainRequest):
    logger.info(f"Received manual training request for {request.symbol}")
    success = train_pipeline(request.symbol)
    if success:
        loaded = load_models_for_symbol(request.symbol)
        return {"success": True, "message": f"Successfully trained and loaded models for {request.symbol}."}
    return {"success": False, "message": f"Training failed for {request.symbol}. Seed more historical candles."}


@app.post("/predict")
def predict(request: PredictRequest):
    symbol = request.symbol

    if symbol not in MODELS:
        loaded = load_models_for_symbol(symbol)
        if not loaded:
            logger.warning(f"Using fallback prediction (HOLD) for {symbol} due to missing models.")
            return {
                "rf_vote": 0,
                "rf_confidence": 0.5,
                "lstm_vote": 0,
                "lstm_confidence": 0.5,
                "anomaly": 0,
                "is_fallback": True
            }

    try:
        model_group = MODELS[symbol]
        feature_cols = model_group["features"]

        features_dict = request.features
        x_vector = []
        for col in feature_cols:
            x_vector.append(features_dict.get(col, 0.0))

        x_array = [x_vector]

        iso_pred = model_group["iso"].predict(x_array)[0]
        anomaly = 1 if iso_pred == -1 else 0

        rf_classes = model_group["rf"].classes_
        rf_probs = model_group["rf"].predict_proba(x_array)[0]

        max_idx = rf_probs.argmax()
        rf_vote = int(rf_classes[max_idx])
        rf_confidence = float(rf_probs[max_idx])

        sequence_data = request.sequence
        if len(sequence_data) < 30:
            padding_len = 30 - len(sequence_data)
            sequence_data = [sequence_data[0]] * padding_len + sequence_data

        seq_matrix = []
        for step in sequence_data[-30:]:
            step_vector = [step.get(col, 0.0) for col in feature_cols]
            seq_matrix.append(step_vector)

        import numpy as np
        seq_array = np.array(seq_matrix)

        lstm_direction, lstm_confidence = model_group["lstm"].predict(seq_array)
        lstm_vote = int(lstm_direction)

        return {
            "rf_vote": rf_vote,
            "rf_confidence": rf_confidence,
            "lstm_vote": lstm_vote,
            "lstm_confidence": lstm_confidence,
            "anomaly": anomaly,
            "is_fallback": False
        }
    except Exception as e:
        logger.error(f"Prediction failed for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PYTHON_PORT", 5001))
    uvicorn.run("server_1h:app", host="127.0.0.1", port=port, reload=False)
