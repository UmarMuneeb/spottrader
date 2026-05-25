import sys
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sentiment")

# Try loading transformers and torch for FinBERT, fallback to VADER if not installed/errors
HAS_FINBERT = False
tokenizer = None
model = None

try:
    import torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    
    logger.info("Attempting to load FinBERT (ProsusAI/finbert)...")
    tokenizer = AutoTokenizer.from_pretrained("ProsusAI/finbert", local_files_only=False)
    model = AutoModelForSequenceClassification.from_pretrained("ProsusAI/finbert", local_files_only=False)
    HAS_FINBERT = True
    logger.info("FinBERT loaded successfully.")
except Exception as e:
    logger.warning(f"Could not load FinBERT due to error: {e}. Falling back to VADER Sentiment.")
    HAS_FINBERT = False

# Try importing VADER
try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    vader_analyzer = SentimentIntensityAnalyzer()
    logger.info("VADER Sentiment Analyzer initialized.")
except Exception as e:
    logger.error(f"Could not load VADER: {e}")
    vader_analyzer = None

def get_sentiment_score(text: str) -> float:
    """
    Scores news sentiment from -1.0 (bearish) to +1.0 (bullish).
    """
    if not text or not isinstance(text, str):
        return 0.0

    if HAS_FINBERT and model is not None and tokenizer is not None:
        try:
            inputs = tokenizer(text, padding=True, truncation=True, return_tensors="pt", max_length=512)
            with torch.no_grad():
                outputs = model(**inputs)
            # FinBERT labels: 0 -> positive, 1 -> negative, 2 -> neutral
            probs = torch.nn.functional.softmax(outputs.logits, dim=-1).squeeze().tolist()
            
            # Score = Prob(Positive) - Prob(Negative)
            pos_prob = probs[0]
            neg_prob = probs[1]
            score = pos_prob - neg_prob
            return float(score)
        except Exception as e:
            logger.warning(f"FinBERT inference failed: {e}. Falling back to VADER.")
            # Fall through to VADER if FinBERT runtime fails

    if vader_analyzer is not None:
        try:
            # VADER compound score is already normalized between -1 and +1
            vs = vader_analyzer.polarity_scores(text)
            return float(vs['compound'])
        except Exception as e:
            logger.error(f"VADER inference failed: {e}")
            return 0.0

    # Ultimate fallback if no analyzers are active
    return 0.0

if __name__ == "__main__":
    test_headline = "Binance announces new zero-fee trading pairs for Bitcoin and Ethereum, sparking market rally"
    test_bearish = "Crypto market drops 5% as regulatory concerns increase and whales dump assets"
    
    print(f"Test Bullish FinBERT/VADER score: {get_sentiment_score(test_headline):.4f}")
    print(f"Test Bearish FinBERT/VADER score: {get_sentiment_score(test_bearish):.4f}")
