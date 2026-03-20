"""Core types for the trading algorithm system."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


# ============================================================
# Enums
# ============================================================

class AssetClass(str, Enum):
    CRYPTO = "crypto"
    FOREX = "forex"


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"


class SignalAction(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"


class OrderType(str, Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


class OrderStatus(str, Enum):
    PENDING = "pending"
    FILLED = "filled"
    PARTIALLY_FILLED = "partially_filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"


class PositionStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"


Timeframe = Literal["1m", "5m", "15m", "1h", "4h", "1d", "1w"]


# ============================================================
# Market Data
# ============================================================

@dataclass
class Candle:
    timestamp: int  # milliseconds
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class AssetInfo:
    symbol: str            # e.g., "BTC/USDT", "EUR/USD"
    asset_class: AssetClass
    exchange: str = ""     # e.g., "binance", "icmarkets"
    base_currency: str = ""
    quote_currency: str = ""


@dataclass
class MarketData:
    asset: AssetInfo
    timeframe: str
    candles: list[Candle]
    last_updated: int  # milliseconds


# ============================================================
# Signals & Strategies
# ============================================================

@dataclass
class Signal:
    asset: AssetInfo
    action: SignalAction
    confidence: float       # 0.0 to 1.0
    price: float
    timestamp: int
    strategy: str
    timeframe: str
    indicators: dict[str, float] = field(default_factory=dict)
    reason: str = ""


@dataclass
class StrategyConfig:
    name: str
    enabled: bool = True
    params: dict[str, float] = field(default_factory=dict)
    asset_classes: list[AssetClass] = field(default_factory=lambda: [AssetClass.CRYPTO, AssetClass.FOREX])
    timeframes: list[str] = field(default_factory=lambda: ["1h"])


@dataclass
class StrategyDNA:
    id: str
    name: str
    generation: int = 0
    parent_id: str | None = None
    params: dict[str, float] = field(default_factory=dict)
    fitness: float = 0.0
    created_at: int = 0
    mutations: list[str] = field(default_factory=list)


# ============================================================
# Orders & Positions
# ============================================================

@dataclass
class Order:
    id: str
    asset: AssetInfo
    side: Side
    type: OrderType
    quantity: float
    strategy: str
    price: float | None = None
    stop_price: float | None = None
    status: OrderStatus = OrderStatus.PENDING
    filled_price: float | None = None
    filled_quantity: float | None = None
    created_at: int = 0
    filled_at: int | None = None
    signal_id: str | None = None
    broker_order_id: str | None = None  # IC Markets / cTrader order ID


@dataclass
class Position:
    id: str
    asset: AssetInfo
    side: Side
    entry_price: float
    current_price: float
    quantity: float
    strategy: str
    stop_loss: float | None = None
    take_profit: float | None = None
    unrealized_pnl: float = 0.0
    realized_pnl: float = 0.0
    status: PositionStatus = PositionStatus.OPEN
    opened_at: int = 0
    closed_at: int | None = None
    broker_position_id: str | None = None  # IC Markets / cTrader position ID


# ============================================================
# Portfolio
# ============================================================

@dataclass
class Portfolio:
    capital: float
    available_capital: float
    positions: list[Position] = field(default_factory=list)
    total_pnl: float = 0.0
    total_pnl_pct: float = 0.0
    max_drawdown: float = 0.0
    last_updated: int = 0


# ============================================================
# Risk
# ============================================================

@dataclass
class RiskAssessment:
    max_position_size: float
    recommended_size: float
    stop_loss_price: float
    take_profit_price: float
    risk_reward_ratio: float
    kelly_fraction: float
    approved: bool
    reason: str


# ============================================================
# Performance
# ============================================================

@dataclass
class PerformanceMetrics:
    total_return: float = 0.0
    total_return_pct: float = 0.0
    sharpe_ratio: float = 0.0
    sortino_ratio: float = 0.0
    max_drawdown: float = 0.0
    max_drawdown_pct: float = 0.0
    win_rate: float = 0.0
    profit_factor: float = 0.0
    total_trades: int = 0
    winning_trades: int = 0
    losing_trades: int = 0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    avg_holding_period: float = 0.0
    calmar_ratio: float = 0.0


@dataclass
class BacktestResult:
    strategy: str
    metrics: PerformanceMetrics
    trades: list[Order] = field(default_factory=list)
    equity_curve: list[dict] = field(default_factory=list)
    dna: StrategyDNA | None = None


# ============================================================
# Macro
# ============================================================

class MacroImpact(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


@dataclass
class MacroIndicator:
    name: str
    value: float
    previous_value: float
    date: str
    source: str
    impact: Literal["high", "medium", "low"] = "low"


@dataclass
class SentimentScore:
    asset: str
    score: float        # -1.0 (bearish) to 1.0 (bullish)
    volume: int         # number of data points
    source: str
    timestamp: int = 0


@dataclass
class MacroEnvironment:
    indicators: list[MacroIndicator]
    sentiment: list[SentimentScore]
    risk_level: Literal["low", "medium", "high", "extreme"]
    bias: Literal["bullish", "bearish", "neutral"]
    timestamp: int = 0


# ============================================================
# Macro Economist — Local Types
# ============================================================

class GeopoliticalCategory(str, Enum):
    CONFLICT = "conflict"
    SANCTIONS = "sanctions"
    TRADE_WAR = "trade-war"
    ELECTION = "election"
    POLICY = "policy"
    REGULATORY = "regulatory"
    ENERGY = "energy"
    PANDEMIC = "pandemic"
    DEBT_CRISIS = "debt-crisis"


@dataclass
class GeopoliticalFactor:
    category: str  # GeopoliticalCategory value
    region: str
    description: str
    severity: Literal["low", "medium", "high", "critical"]
    affected_assets: list[str] = field(default_factory=list)
    market_impact: Literal["bullish", "bearish", "volatile", "neutral"] = "neutral"


@dataclass
class GeopoliticalRisk:
    score: int              # 0-100
    level: Literal["low", "medium", "high", "extreme"]
    vix_level: float
    factors: list[GeopoliticalFactor] = field(default_factory=list)
    timestamp: int = 0


@dataclass
class PolicyChange:
    country: str
    institution: str
    type: Literal["monetary", "fiscal", "regulatory", "trade"]
    description: str
    impact: Literal["hawkish", "dovish", "neutral", "restrictive", "expansionary"]
    affected_markets: list[str] = field(default_factory=list)
    effective_date: str = ""
    severity: Literal["low", "medium", "high"] = "low"


@dataclass
class GlobalMacroSnapshot:
    region: str
    indicators: dict[str, float] = field(default_factory=dict)
    policy_stance: Literal["hawkish", "dovish", "neutral"] = "neutral"
    growth_outlook: Literal["expanding", "slowing", "contracting", "recovering"] = "slowing"
    inflation_trend: Literal["rising", "falling", "stable", "sticky"] = "stable"
    timestamp: int = 0


@dataclass
class EconomicEvent:
    name: str
    description: str
    impact: Literal["high", "medium", "low"]
    schedule: str
    next_date: str
    source: str
