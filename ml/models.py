import numpy as np
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("models")

# Check PyTorch availability
HAS_TORCH = False
try:
    import torch
    import torch.nn as nn
    import torch.optim as optim
    HAS_TORCH = True
    logger.info("PyTorch LSTM available.")
except ImportError:
    logger.warning("PyTorch not found. LSTM will fall back to Scikit-learn MLP Classifier.")
    HAS_TORCH = False

# -----------------
# 1. LSTM Network (PyTorch)
# -----------------
if HAS_TORCH:
    class LSTMModel(nn.Module):
        def __init__(self, input_dim=22, hidden_dim=64, num_layers=2, output_dim=1):
            super(LSTMModel, self).__init__()
            self.hidden_dim = hidden_dim
            self.num_layers = num_layers
            self.lstm = nn.LSTM(input_dim, hidden_dim, num_layers, batch_first=True, dropout=0.2)
            self.fc = nn.Linear(hidden_dim, output_dim)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            # x shape: (batch_size, seq_len, input_dim)
            h0 = torch.zeros(self.num_layers, x.size(0), self.hidden_dim).to(x.device)
            c0 = torch.zeros(self.num_layers, x.size(0), self.hidden_dim).to(x.device)
            
            out, _ = self.lstm(x, (h0, c0))
            # Take the output of the last sequence step
            out = self.fc(out[:, -1, :])
            return self.sigmoid(out)

    class PyTorchLSTMWrapper:
        def __init__(self, input_dim=22, seq_len=30):
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            self.model = LSTMModel(input_dim=input_dim).to(self.device)
            self.seq_len = seq_len
            self.input_dim = input_dim

        def train(self, X_train, y_train, epochs=20, batch_size=32, lr=0.001):
            self.model.train()
            criterion = nn.BCELoss()
            optimizer = optim.Adam(self.model.parameters(), lr=lr)

            # Convert numpy arrays to PyTorch tensors
            # X_train shape should be (num_samples, seq_len, input_dim)
            # y_train shape should be (num_samples,)
            X_t = torch.FloatTensor(X_train).to(self.device)
            y_t = torch.FloatTensor(y_train).unsqueeze(1).to(self.device)

            dataset = torch.utils.data.TensorDataset(X_t, y_t)
            loader = torch.utils.data.DataLoader(dataset, batch_size=batch_size, shuffle=True)

            for epoch in range(epochs):
                epoch_loss = 0
                for batch_x, batch_y in loader:
                    optimizer.zero_grad()
                    predictions = self.model(batch_x)
                    loss = criterion(predictions, batch_y)
                    loss.backward()
                    optimizer.step()
                    epoch_loss += loss.item() * batch_x.size(0)
                
                # logger.info(f"LSTM Epoch {epoch+1}/{epochs} Loss: {epoch_loss / len(X_train):.4f}")

        def predict(self, X_seq):
            self.model.eval()
            with torch.no_grad():
                # X_seq shape: (1, seq_len, input_dim) or (seq_len, input_dim)
                if len(X_seq.shape) == 2:
                    X_seq = np.expand_dims(X_seq, axis=0)
                X_t = torch.FloatTensor(X_seq).to(self.device)
                prob = self.model(X_t).item()
                
            # Direction: 1 (UP) if prob >= 0.5, else -1 (DOWN)
            direction = 1 if prob >= 0.5 else -1
            confidence = abs(prob - 0.5) * 2.0 # Scale confidence to [0.0, 1.0]
            return direction, confidence

        def save(self, filepath):
            torch.save(self.model.state_dict(), filepath)

        def load(self, filepath):
            self.model.load_state_dict(torch.load(filepath, map_location=self.device))
            self.model.eval()

else:
    # Fallback to Scikit-learn MLP Classifier
    from sklearn.neural_network import MLPClassifier
    import joblib

    class PyTorchLSTMWrapper:
        def __init__(self, input_dim=22, seq_len=30):
            self.seq_len = seq_len
            self.input_dim = input_dim
            # A standard multi-layer perceptron running on flattened sequences
            self.model = MLPClassifier(hidden_layer_sizes=(64, 32), max_iter=200, random_state=42)

        def train(self, X_train, y_train):
            # Flatten inputs for MLP: (samples, seq_len, input_dim) -> (samples, seq_len * input_dim)
            num_samples = X_train.shape[0]
            X_flat = X_train.reshape(num_samples, -1)
            self.model.fit(X_flat, y_train)

        def predict(self, X_seq):
            # X_seq: (seq_len, input_dim)
            if len(X_seq.shape) == 3:
                X_seq = X_seq[0]
            X_flat = X_seq.flatten().reshape(1, -1)
            
            try:
                probs = self.model.predict_proba(X_flat)[0]
                # Index 1 is UP (prob of 1)
                prob_up = probs[1]
            except Exception:
                prob_up = 0.5
                
            direction = 1 if prob_up >= 0.5 else -1
            confidence = abs(prob_up - 0.5) * 2.0
            return direction, confidence

        def save(self, filepath):
            joblib.dump(self.model, filepath)

        def load(self, filepath):
            self.model = joblib.load(filepath)
