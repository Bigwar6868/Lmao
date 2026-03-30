"""ML Signal Enhancement module.

Provides gradient-boosting-based signal enhancement using technical features
extracted from candle data. Pure Python implementation — no external ML libraries.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

from shared.types import Candle, Signal, SignalAction
from shared.indicators import rsi, macd, bollinger_bands, atr, sma

log = logging.getLogger(__name__)


# ============================================================
# Feature Extraction
# ============================================================


class FeatureExtractor:
    """Extract normalized technical features from candle data."""

    def extract(self, candles: list[Candle]) -> list[dict[str, float]]:
        """Extract features per candle, normalized to 0-1 range.

        Features: RSI, MACD histogram, BB %b, ATR ratio, volume ratio,
        momentum (5,10,20), returns (1,3,5), hour_of_day, day_of_week.
        """
        n = len(candles)
        if n < 30:
            return [{} for _ in candles]

        # Pre-compute indicators
        rsi_vals = rsi(candles, 14)
        _, _, macd_hist = macd(candles, 12, 26, 9)
        bb_upper, bb_mid, bb_lower = bollinger_bands(candles, 20, 2.0)
        atr_vals = atr(candles, 14)
        sma_20 = sma(candles, 20)

        # Volume stats for normalization
        volumes = [c.volume for c in candles]
        vol_sma_20 = self._rolling_mean(volumes, 20)

        # MACD histogram range for normalization
        valid_hist = [v for v in macd_hist if v is not None]
        hist_max = max(abs(v) for v in valid_hist) if valid_hist else 1.0
        if hist_max == 0:
            hist_max = 1.0

        features: list[dict[str, float]] = []

        for i in range(n):
            feat: dict[str, float] = {}

            # RSI (already 0-100, normalize to 0-1)
            feat["rsi"] = self._safe_norm(rsi_vals[i], 0.0, 100.0)

            # MACD histogram (normalize by max absolute value -> -1 to 1 -> 0 to 1)
            if macd_hist[i] is not None:
                feat["macd_hist"] = self._clamp((macd_hist[i] / hist_max + 1.0) / 2.0)
            else:
                feat["macd_hist"] = 0.5

            # Bollinger Band %b = (close - lower) / (upper - lower)
            if bb_upper[i] is not None and bb_lower[i] is not None:
                band_width = bb_upper[i] - bb_lower[i]
                if band_width > 0:
                    feat["bb_pct_b"] = self._clamp(
                        (candles[i].close - bb_lower[i]) / band_width
                    )
                else:
                    feat["bb_pct_b"] = 0.5
            else:
                feat["bb_pct_b"] = 0.5

            # ATR ratio (ATR / close, normalized)
            if atr_vals[i] is not None and candles[i].close > 0:
                atr_ratio = atr_vals[i] / candles[i].close
                # Typical ATR ratio 0-5%, map to 0-1
                feat["atr_ratio"] = self._clamp(atr_ratio / 0.05)
            else:
                feat["atr_ratio"] = 0.5

            # Volume ratio (volume / 20-period avg volume)
            if i < len(vol_sma_20) and vol_sma_20[i] is not None and vol_sma_20[i] > 0:
                vol_ratio = candles[i].volume / vol_sma_20[i]
                # Normalize: ratio of 0-3 mapped to 0-1
                feat["volume_ratio"] = self._clamp(vol_ratio / 3.0)
            else:
                feat["volume_ratio"] = 0.5

            # Momentum (5, 10, 20 period)
            for period in (5, 10, 20):
                if i >= period and candles[i - period].close > 0:
                    mom = (candles[i].close - candles[i - period].close) / candles[i - period].close
                    # Normalize: -10% to +10% -> 0 to 1
                    feat[f"momentum_{period}"] = self._clamp((mom / 0.10 + 1.0) / 2.0)
                else:
                    feat[f"momentum_{period}"] = 0.5

            # Returns (1, 3, 5 candle)
            for period in (1, 3, 5):
                if i >= period and candles[i - period].close > 0:
                    ret = (candles[i].close - candles[i - period].close) / candles[i - period].close
                    # Normalize: -5% to +5% -> 0 to 1
                    feat[f"return_{period}"] = self._clamp((ret / 0.05 + 1.0) / 2.0)
                else:
                    feat[f"return_{period}"] = 0.5

            # Hour of day (0-23 -> 0-1)
            hour = (candles[i].timestamp // 3_600_000) % 24
            feat["hour_of_day"] = hour / 23.0

            # Day of week (0-6 -> 0-1)
            # Approximate: days since epoch mod 7 (epoch was Thursday = 3)
            day_since_epoch = candles[i].timestamp // 86_400_000
            day_of_week = (day_since_epoch + 3) % 7  # 0=Monday
            feat["day_of_week"] = day_of_week / 6.0

            features.append(feat)

        return features

    # ----------------------------------------------------------
    # Helpers
    # ----------------------------------------------------------

    @staticmethod
    def _safe_norm(value: float | None, lo: float, hi: float) -> float:
        if value is None:
            return 0.5
        if hi == lo:
            return 0.5
        return max(0.0, min(1.0, (value - lo) / (hi - lo)))

    @staticmethod
    def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
        return max(lo, min(hi, value))

    @staticmethod
    def _rolling_mean(values: list[float], period: int) -> list[float | None]:
        result: list[float | None] = [None] * len(values)
        for i in range(period - 1, len(values)):
            result[i] = sum(values[i - period + 1 : i + 1]) / period
        return result


# ============================================================
# Gradient Boosting (simplified, pure-Python)
# ============================================================


@dataclass
class _DecisionStump:
    """A single-split decision tree (stump)."""
    feature: str = ""
    threshold: float = 0.0
    left_value: float = 0.0   # prediction when feature <= threshold
    right_value: float = 0.0  # prediction when feature > threshold


@dataclass
class GradientBoostingSignal:
    """Simplified gradient boosting with decision stumps.

    Pure Python implementation — no sklearn or numpy required.
    Uses an ensemble of single-split decision stumps fit on residuals.
    """

    n_rounds: int = 50
    learning_rate: float = 0.1
    _stumps: list[_DecisionStump] = field(default_factory=list)
    _initial_prediction: float = 0.0
    _feature_names: list[str] = field(default_factory=list)

    def fit(self, features: list[dict[str, float]], labels: list[float]) -> None:
        """Fit the gradient boosting model.

        Args:
            features: list of feature dicts per sample.
            labels: target values (e.g., sign of future return).
        """
        if not features or not labels:
            log.warning("GradientBoostingSignal.fit called with empty data")
            return

        n = len(features)
        if n != len(labels):
            raise ValueError("features and labels must have the same length")

        self._feature_names = sorted(features[0].keys()) if features[0] else []
        if not self._feature_names:
            log.warning("No features available for fitting")
            return

        # Initial prediction = mean of labels
        self._initial_prediction = sum(labels) / n
        predictions = [self._initial_prediction] * n
        self._stumps = []

        for round_idx in range(self.n_rounds):
            # Compute residuals
            residuals = [labels[i] - predictions[i] for i in range(n)]

            # Fit a stump to the residuals
            stump = self._fit_stump(features, residuals)
            if stump is None:
                break

            self._stumps.append(stump)

            # Update predictions
            for i in range(n):
                val = features[i].get(stump.feature, 0.0)
                pred = stump.left_value if val <= stump.threshold else stump.right_value
                predictions[i] += self.learning_rate * pred

        log.info(
            "GradientBoostingSignal fitted: %d rounds, %d samples, %d features",
            len(self._stumps), n, len(self._feature_names),
        )

    def predict(self, features: list[dict[str, float]]) -> list[float]:
        """Predict values for each feature set.

        Returns raw predictions (not clipped).
        """
        if not self._stumps:
            return [0.0] * len(features)

        results: list[float] = []
        for feat in features:
            pred = self._initial_prediction
            for stump in self._stumps:
                val = feat.get(stump.feature, 0.0)
                stump_pred = stump.left_value if val <= stump.threshold else stump.right_value
                pred += self.learning_rate * stump_pred
            results.append(pred)

        return results

    # ----------------------------------------------------------
    # Internal: fit a single decision stump
    # ----------------------------------------------------------

    def _fit_stump(
        self,
        features: list[dict[str, float]],
        residuals: list[float],
    ) -> _DecisionStump | None:
        """Find the best single-split stump to minimize squared error on residuals."""
        n = len(features)
        best_stump: _DecisionStump | None = None
        best_loss = math.inf

        for feat_name in self._feature_names:
            # Gather (value, residual) pairs
            vals = [(features[i].get(feat_name, 0.0), residuals[i]) for i in range(n)]
            vals.sort(key=lambda x: x[0])

            # Try up to 10 candidate thresholds (quantile-based for efficiency)
            n_candidates = min(10, n - 1)
            if n_candidates <= 0:
                continue

            step = max(1, n // (n_candidates + 1))
            candidates: list[float] = []
            for k in range(step, n, step):
                if vals[k][0] != vals[k - 1][0]:
                    candidates.append((vals[k - 1][0] + vals[k][0]) / 2.0)
                if len(candidates) >= n_candidates:
                    break

            if not candidates:
                continue

            # Precompute cumulative sums for fast split evaluation
            cum_sum = [0.0] * (n + 1)
            cum_count = [0] * (n + 1)
            for k in range(n):
                cum_sum[k + 1] = cum_sum[k] + vals[k][1]
                cum_count[k + 1] = cum_count[k] + 1

            total_sum = cum_sum[n]

            for threshold in candidates:
                # Binary search for split point
                lo, hi = 0, n
                while lo < hi:
                    mid = (lo + hi) // 2
                    if vals[mid][0] <= threshold:
                        lo = mid + 1
                    else:
                        hi = mid
                split = lo

                if split == 0 or split == n:
                    continue

                left_sum = cum_sum[split]
                left_count = split
                right_sum = total_sum - left_sum
                right_count = n - left_count

                left_mean = left_sum / left_count
                right_mean = right_sum / right_count

                # Compute squared error loss
                loss = 0.0
                for k in range(split):
                    loss += (vals[k][1] - left_mean) ** 2
                for k in range(split, n):
                    loss += (vals[k][1] - right_mean) ** 2

                if loss < best_loss:
                    best_loss = loss
                    best_stump = _DecisionStump(
                        feature=feat_name,
                        threshold=threshold,
                        left_value=left_mean,
                        right_value=right_mean,
                    )

        return best_stump


# ============================================================
# ML Signal Enhancer
# ============================================================


class MLSignalEnhancer:
    """Enhance trading signals using ML-predicted direction confidence.

    Trains a simplified gradient boosting model on historical candle data
    and uses its predictions to adjust signal confidence.
    """

    FUTURE_CANDLES = 5
    BOOST_MAX = 0.20    # max confidence boost when ML agrees
    REDUCE_MAX = 0.15   # max confidence reduction when ML disagrees
    MIN_TRAIN_SAMPLES = 50

    def __init__(self, n_rounds: int = 50, learning_rate: float = 0.1) -> None:
        self._extractor = FeatureExtractor()
        self._model = GradientBoostingSignal(n_rounds=n_rounds, learning_rate=learning_rate)
        self._is_trained = False

    def enhance(self, signals: list[Signal], candles: list[Candle]) -> list[Signal]:
        """Enhance signal confidence using ML predictions.

        Trains on historical candles (label = sign of future 5-candle return),
        then adjusts each signal's confidence based on ML agreement/disagreement.

        Args:
            signals: list of trading signals to enhance.
            candles: historical candle data (must include enough for training).

        Returns:
            Enhanced signals with adjusted confidence values.
        """
        if not signals or not candles:
            return signals

        # Train model on historical data
        self._train(candles)

        if not self._is_trained:
            log.warning("ML model not trained — returning signals unchanged")
            return signals

        # Extract features for the latest candles
        all_features = self._extractor.extract(candles)

        # Get ML predictions for all candles
        predictions = self._model.predict(all_features)

        # Use the prediction at the last candle as the current ML view
        latest_pred = predictions[-1] if predictions else 0.0

        enhanced: list[Signal] = []
        for sig in signals:
            new_sig = Signal(
                asset=sig.asset,
                action=sig.action,
                confidence=sig.confidence,
                price=sig.price,
                timestamp=sig.timestamp,
                strategy=sig.strategy,
                timeframe=sig.timeframe,
                indicators=dict(sig.indicators),
                reason=sig.reason,
            )

            # Determine ML direction: positive prediction = bullish, negative = bearish
            ml_bullish = latest_pred > 0
            signal_bullish = sig.action == SignalAction.BUY

            # Magnitude of ML conviction (0 to 1)
            ml_confidence = min(abs(latest_pred), 1.0)

            if sig.action == SignalAction.HOLD:
                # Don't modify HOLD signals
                enhanced.append(new_sig)
                continue

            if ml_bullish == signal_bullish:
                # ML agrees with signal direction — boost confidence
                boost = self.BOOST_MAX * ml_confidence
                new_sig.confidence = min(1.0, sig.confidence + boost)
                new_sig.indicators["ml_prediction"] = latest_pred
                new_sig.indicators["ml_boost"] = boost
                log.debug(
                    "ML agrees with %s signal: confidence %.3f -> %.3f (boost +%.3f)",
                    sig.action.value, sig.confidence, new_sig.confidence, boost,
                )
            else:
                # ML disagrees — reduce confidence
                reduction = self.REDUCE_MAX * ml_confidence
                new_sig.confidence = max(0.0, sig.confidence - reduction)
                new_sig.indicators["ml_prediction"] = latest_pred
                new_sig.indicators["ml_reduction"] = -reduction
                log.debug(
                    "ML disagrees with %s signal: confidence %.3f -> %.3f (reduce -%.3f)",
                    sig.action.value, sig.confidence, new_sig.confidence, reduction,
                )

            enhanced.append(new_sig)

        log.info(
            "Enhanced %d signals (ML prediction=%.4f, trained=%s)",
            len(enhanced), latest_pred, self._is_trained,
        )
        return enhanced

    # ----------------------------------------------------------
    # Training
    # ----------------------------------------------------------

    def _train(self, candles: list[Candle]) -> None:
        """Train the model on historical candles.

        Label: sign of future 5-candle return (+1 for up, -1 for down).
        Only uses candles where we can compute both features and forward labels.
        """
        n = len(candles)
        if n < self.MIN_TRAIN_SAMPLES + self.FUTURE_CANDLES:
            log.info(
                "Not enough candles for ML training: %d < %d",
                n, self.MIN_TRAIN_SAMPLES + self.FUTURE_CANDLES,
            )
            self._is_trained = False
            return

        all_features = self._extractor.extract(candles)

        # Build training set: features from candle[i], label from candle[i + FUTURE_CANDLES]
        train_features: list[dict[str, float]] = []
        train_labels: list[float] = []

        for i in range(n - self.FUTURE_CANDLES):
            feat = all_features[i]
            if not feat:
                continue

            future_close = candles[i + self.FUTURE_CANDLES].close
            current_close = candles[i].close

            if current_close <= 0:
                continue

            future_return = (future_close - current_close) / current_close
            label = 1.0 if future_return > 0 else -1.0

            train_features.append(feat)
            train_labels.append(label)

        if len(train_features) < self.MIN_TRAIN_SAMPLES:
            log.info(
                "Not enough valid training samples: %d < %d",
                len(train_features), self.MIN_TRAIN_SAMPLES,
            )
            self._is_trained = False
            return

        self._model.fit(train_features, train_labels)
        self._is_trained = True
        log.info("ML model trained on %d samples", len(train_features))
