"""Configuration for the trading algorithm system."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


def _detect_cloud_mode() -> bool:
    env = os.environ.get("CLOUD_MODE", "").lower()
    if env == "true":
        return True
    if env == "false":
        return False
    # Auto-detect container/sandbox
    try:
        return os.getuid() == 0 and not os.environ.get("USER")
    except AttributeError:
        return False


@dataclass(frozen=True)
class Config:
    # Cloud
    cloud_mode: bool = field(default_factory=_detect_cloud_mode)

    # IC Markets / cTrader Open API
    ctrader_client_id: str = field(default_factory=lambda: os.environ.get("CTRADER_CLIENT_ID", ""))
    ctrader_client_secret: str = field(default_factory=lambda: os.environ.get("CTRADER_CLIENT_SECRET", ""))
    ctrader_access_token: str = field(default_factory=lambda: os.environ.get("CTRADER_ACCESS_TOKEN", ""))
    ctrader_account_id: str = field(default_factory=lambda: os.environ.get("CTRADER_ACCOUNT_ID", ""))
    ctrader_is_live: bool = field(default_factory=lambda: os.environ.get("CTRADER_IS_LIVE", "false").lower() == "true")

    # OANDA v20 API
    oanda_api_token: str = field(default_factory=lambda: os.environ.get("OANDA_API_TOKEN", ""))
    oanda_account_id: str = field(default_factory=lambda: os.environ.get("OANDA_ACCOUNT_ID", ""))
    oanda_is_live: bool = field(default_factory=lambda: os.environ.get("OANDA_IS_LIVE", "false").lower() == "true")

    # Legacy API Keys (for fallback data sources)
    alpha_vantage_key: str = field(default_factory=lambda: os.environ.get("ALPHA_VANTAGE_API_KEY", "demo"))
    binance_api_key: str = field(default_factory=lambda: os.environ.get("BINANCE_API_KEY", ""))
    binance_secret: str = field(default_factory=lambda: os.environ.get("BINANCE_SECRET", ""))

    # Trading
    trading_mode: str = field(default_factory=lambda: os.environ.get("TRADING_MODE", "live"))
    trading_broker: str = field(default_factory=lambda: os.environ.get("TRADING_BROKER", "oanda"))  # oanda, icmarkets, auto
    default_timeframe: str = field(default_factory=lambda: os.environ.get("DEFAULT_TIMEFRAME", "1h"))
    initial_capital: float = field(default_factory=lambda: float(os.environ.get("INITIAL_CAPITAL", "10000")))
    max_position_size_pct: float = field(default_factory=lambda: float(os.environ.get("MAX_POSITION_SIZE_PCT", "5")))
    max_drawdown_pct: float = field(default_factory=lambda: float(os.environ.get("MAX_DRAWDOWN_PCT", "20")))

    # Risk
    kelly_fraction: float = 0.5
    default_stop_loss_atr: float = 2.0
    default_take_profit_atr: float = 3.0
    max_correlation: float = 0.7
    max_sector_exposure: float = 0.3

    # Margin & Leverage
    default_leverage: float = field(default_factory=lambda: float(os.environ.get("DEFAULT_LEVERAGE", "30")))  # 1:30 for forex
    max_leverage: float = field(default_factory=lambda: float(os.environ.get("MAX_LEVERAGE", "50")))  # Hard cap
    margin_call_level: float = field(default_factory=lambda: float(os.environ.get("MARGIN_CALL_LEVEL", "50")))  # Margin call at 50%
    margin_stop_out_level: float = field(default_factory=lambda: float(os.environ.get("MARGIN_STOP_OUT_LEVEL", "30")))  # Force close at 30%
    max_margin_usage_pct: float = field(default_factory=lambda: float(os.environ.get("MAX_MARGIN_USAGE_PCT", "80")))  # Don't open new trades above 80% margin used
    per_pair_leverage: str = field(default_factory=lambda: os.environ.get("PER_PAIR_LEVERAGE", ""))  # e.g. "EUR/USD:50,GBP/JPY:20"

    # Evolution
    population_size: int = 15
    mutation_rate: float = 0.15
    elitism_count: int = 2
    evolution_interval_s: int = field(default_factory=lambda: int(os.environ.get("EVOLUTION_INTERVAL_S", "3600")))  # 1 hour

    # Trading activity
    max_trades_per_cycle: int = field(default_factory=lambda: int(os.environ.get("MAX_TRADES_PER_CYCLE", "40")))
    max_hold_hours: float = field(default_factory=lambda: float(os.environ.get("MAX_HOLD_HOURS", "24")))  # Max position hold time

    # Data
    data_dir: str = field(default_factory=lambda: os.path.join(os.path.dirname(os.path.dirname(__file__)), "data"))
    cache_enabled: bool = True

    # FRED API (macro economist)
    fred_api_key: str = field(default_factory=lambda: os.environ.get("FRED_API_KEY", ""))

    # Ollama (agent brain)
    ollama_url: str = field(default_factory=lambda: os.environ.get("OLLAMA_URL", "http://localhost:11434"))
    ollama_model: str = field(default_factory=lambda: os.environ.get("OLLAMA_MODEL", "llama3"))

    # Per-team AI model selection (provider:model format, e.g. "kimiclaw:moonshot-v1-8k", "claude:claude-sonnet-4-20250514", "ollama:llama3")
    # If not set, falls back to auto_detect_provider()
    ceo_ai_model: str = field(default_factory=lambda: os.environ.get("CEO_AI_MODEL", ""))
    trading_ai_model: str = field(default_factory=lambda: os.environ.get("TRADING_AI_MODEL", ""))
    research_ai_model: str = field(default_factory=lambda: os.environ.get("RESEARCH_AI_MODEL", ""))
    risk_ai_model: str = field(default_factory=lambda: os.environ.get("RISK_AI_MODEL", ""))
    evolution_ai_model: str = field(default_factory=lambda: os.environ.get("EVOLUTION_AI_MODEL", ""))
    ops_ai_model: str = field(default_factory=lambda: os.environ.get("OPS_AI_MODEL", ""))

    # Agent network
    network_message_timeout_ms: int = 5000
    max_agents: int = 30

    # Telegram Bot
    telegram_bot_token: str = field(default_factory=lambda: os.environ.get("TELEGRAM_BOT_TOKEN", ""))
    telegram_chat_id: str = field(default_factory=lambda: os.environ.get("TELEGRAM_CHAT_ID", ""))

    # System
    log_level: str = field(default_factory=lambda: os.environ.get("LOG_LEVEL", "INFO"))

    @property
    def cache_ttl_ms(self) -> int:
        return 24 * 3600 * 1000 if self.cloud_mode else 3600 * 1000

    @property
    def network_timeout_s(self) -> float:
        return 2.0 if self.cloud_mode else 10.0

    @property
    def has_ctrader_credentials(self) -> bool:
        return bool(self.ctrader_client_id and self.ctrader_client_secret and self.ctrader_access_token and self.ctrader_account_id)

    @property
    def has_oanda_credentials(self) -> bool:
        return bool(self.oanda_api_token and self.oanda_account_id)

    @property
    def has_telegram_credentials(self) -> bool:
        return bool(self.telegram_bot_token)


config = Config()
