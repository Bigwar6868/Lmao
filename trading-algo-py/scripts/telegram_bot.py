"""Telegram bot for the trading algo — monitor and control via Telegram.

Commands:
    /start      — Welcome + status
    /scan       — Scan all pairs, show top signals
    /trade      — Run auto-trade cycle (with confirmation)
    /positions  — Show open positions with P&L
    /pnl        — Account summary (NAV, P&L, margin)
    /close <id> — Close a specific trade by ID
    /closeall   — Close all open trades (with confirmation)
    /status     — System health check
    /help       — Show all commands

Setup:
    1. Create a bot via @BotFather on Telegram
    2. Set TELEGRAM_BOT_TOKEN=<token>
    3. Optionally set TELEGRAM_CHAT_ID=<your_chat_id> to restrict access
    4. Run: python -m scripts.telegram_bot

Usage with KimiClaw/OpenClaw:
    KimiClaw can interact with this bot via Telegram to monitor
    and control the trading system through natural language.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from typing import Any

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    CallbackQueryHandler,
)
from telegram import InlineKeyboardButton, InlineKeyboardMarkup

from config.settings import config
from config.assets import FOREX_ASSETS
from shared.types import MarketData, SignalAction
from team.market_analyst.oanda import OandaDataFetcher
from team.technical_strategist.strategies import get_all_strategies
from team.risk_manager.risk import RiskManager
from team.executor.oanda import OandaExecutor

logging.basicConfig(
    level=config.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger("telegram-bot")


def _authorised(update: Update) -> bool:
    """Check if the user is authorised (if TELEGRAM_CHAT_ID is set)."""
    if not config.telegram_chat_id:
        return True  # No restriction
    return str(update.effective_chat.id) == config.telegram_chat_id


def _executor() -> OandaExecutor:
    return OandaExecutor()


def _fetcher() -> OandaDataFetcher:
    return OandaDataFetcher()


# ── Command Handlers ────────────────────────────────────────────


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _authorised(update):
        await update.message.reply_text("Unauthorised.")
        return

    executor = _executor()
    acct = executor.get_account_balance()
    nav = acct.get("nav", 0)
    currency = acct.get("currency", "GBP")
    open_count = acct.get("open_trade_count", 0)

    text = (
        f"Trading Algo Bot\n\n"
        f"Account: {currency} {nav:.2f} NAV\n"
        f"Open trades: {open_count}\n"
        f"Broker: OANDA ({'live' if config.oanda_is_live else 'practice'})\n\n"
        f"Commands:\n"
        f"/scan — Scan for signals\n"
        f"/trade — Auto-trade cycle\n"
        f"/positions — Open positions\n"
        f"/pnl — Account P&L\n"
        f"/close <id> — Close trade\n"
        f"/closeall — Close all trades\n"
        f"/status — System health\n"
    )
    await update.message.reply_text(text)


async def cmd_scan(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _authorised(update):
        return

    await update.message.reply_text("Scanning 20 forex pairs across 4 strategies...")

    fetcher = _fetcher()
    strategies = get_all_strategies()
    signals = []

    for asset in FOREX_ASSETS:
        try:
            candles = fetcher.fetch_candles(asset.symbol, "1h", count=100)
            if not candles or len(candles) < 30:
                continue

            market_data = MarketData(
                asset=asset, timeframe="1h", candles=candles,
                last_updated=int(time.time() * 1000),
            )

            for strategy in strategies:
                try:
                    result = strategy.analyze(market_data)
                    for sig in result:
                        if sig.action == SignalAction.HOLD:
                            continue
                        if sig.confidence < 0.5:
                            continue
                        signals.append(sig)
                except Exception:
                    pass
        except Exception:
            pass

    signals.sort(key=lambda s: s.confidence, reverse=True)

    if not signals:
        await update.message.reply_text("No actionable signals found.")
        return

    lines = [f"Found {len(signals)} signals:\n"]
    for s in signals[:15]:  # Top 15
        emoji = "🟢" if s.action == SignalAction.BUY else "🔴"
        lines.append(
            f"{emoji} {s.action.value} {s.asset.symbol} | "
            f"{s.confidence*100:.0f}% | {s.strategy}\n"
            f"   {s.reason}"
        )

    await update.message.reply_text("\n\n".join(lines))


async def cmd_trade(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _authorised(update):
        return

    keyboard = [
        [
            InlineKeyboardButton("Execute trades", callback_data="trade_confirm"),
            InlineKeyboardButton("Dry run only", callback_data="trade_dry"),
        ],
        [InlineKeyboardButton("Cancel", callback_data="trade_cancel")],
    ]
    await update.message.reply_text(
        "Run auto-trade cycle?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


async def trade_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    if not _authorised(update):
        return

    if query.data == "trade_cancel":
        await query.edit_message_text("Trade cycle cancelled.")
        return

    dry_run = query.data == "trade_dry"
    mode = "DRY RUN" if dry_run else "LIVE"
    await query.edit_message_text(f"Running auto-trade cycle ({mode})...")

    # Import here to avoid circular dependency
    from scripts.auto_trade import run
    summary = run(dry_run=dry_run)

    text = (
        f"Auto-trade complete ({mode}):\n\n"
        f"Signals found: {summary['signals_found']}\n"
        f"Trades placed: {summary['trades_placed']}\n"
        f"Trades skipped: {summary['trades_skipped']}\n"
        f"Errors: {len(summary['errors'])}"
    )

    if summary["errors"]:
        text += "\n\nErrors:\n" + "\n".join(summary["errors"][:5])

    await query.edit_message_text(text)


async def cmd_positions(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _authorised(update):
        return

    executor = _executor()
    trades = executor.get_open_trades()

    if not trades:
        await update.message.reply_text("No open positions.")
        return

    lines = [f"Open positions ({len(trades)}):\n"]
    total_pl = 0.0

    for t in trades:
        side_emoji = "🟢" if t["side"] == "buy" else "🔴"
        pl = t["unrealized_pl"]
        total_pl += pl
        pl_emoji = "+" if pl >= 0 else ""

        sl_str = f"SL={t['stop_loss']:.5f}" if t.get("stop_loss") else "NO SL"
        tp_str = f"TP={t['take_profit']:.5f}" if t.get("take_profit") else "NO TP"

        lines.append(
            f"{side_emoji} {t['instrument']} | {abs(t['units']):,} units\n"
            f"   Entry: {t['entry_price']:.5f} | P&L: {pl_emoji}{pl:.2f}\n"
            f"   {sl_str} | {tp_str}\n"
            f"   ID: {t['trade_id']}"
        )

    total_emoji = "+" if total_pl >= 0 else ""
    lines.append(f"\nTotal unrealised P&L: {total_emoji}{total_pl:.2f}")

    await update.message.reply_text("\n\n".join(lines))


async def cmd_pnl(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _authorised(update):
        return

    executor = _executor()
    summary = executor.get_summary()
    await update.message.reply_text(summary)


async def cmd_close(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _authorised(update):
        return

    if not ctx.args:
        await update.message.reply_text("Usage: /close <trade_id>")
        return

    trade_id = ctx.args[0]
    executor = _executor()
    ok = executor.close_trade(trade_id)

    if ok:
        await update.message.reply_text(f"Trade {trade_id} closed.")
    else:
        await update.message.reply_text(f"Failed to close trade {trade_id}.")


async def cmd_closeall(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _authorised(update):
        return

    keyboard = [
        [
            InlineKeyboardButton("Yes, close all", callback_data="closeall_confirm"),
            InlineKeyboardButton("Cancel", callback_data="closeall_cancel"),
        ],
    ]
    executor = _executor()
    trades = executor.get_open_trades()
    await update.message.reply_text(
        f"Close all {len(trades)} open trades?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


async def closeall_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    if not _authorised(update):
        return

    if query.data == "closeall_cancel":
        await query.edit_message_text("Close all cancelled.")
        return

    executor = _executor()
    trades = executor.get_open_trades()
    closed = 0
    failed = 0

    for t in trades:
        if executor.close_trade(t["trade_id"]):
            closed += 1
        else:
            failed += 1

    await query.edit_message_text(
        f"Closed {closed} trades. Failed: {failed}."
    )


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not _authorised(update):
        return

    checks: list[str] = []

    # OANDA connection
    executor = _executor()
    acct = executor.get_account_balance()
    if acct:
        checks.append(f"OANDA: connected ({'live' if config.oanda_is_live else 'practice'})")
    else:
        checks.append("OANDA: DISCONNECTED")

    # Open trades
    trades = executor.get_open_trades()
    checks.append(f"Open trades: {len(trades)}")

    # Trades missing SL/TP
    no_sl = sum(1 for t in trades if not t.get("stop_loss"))
    no_tp = sum(1 for t in trades if not t.get("take_profit"))
    if no_sl:
        checks.append(f"WARNING: {no_sl} trades missing stop loss")
    if no_tp:
        checks.append(f"WARNING: {no_tp} trades missing take profit")

    # Chat ID (useful for setup)
    checks.append(f"Chat ID: {update.effective_chat.id}")

    await update.message.reply_text("System Status:\n\n" + "\n".join(checks))


async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    text = (
        "Trading Algo Bot Commands:\n\n"
        "/scan — Scan all forex pairs for signals\n"
        "/trade — Run auto-trade cycle\n"
        "/positions — Show open positions + P&L\n"
        "/pnl — Account summary\n"
        "/close <id> — Close a specific trade\n"
        "/closeall — Close all trades\n"
        "/status — System health + SL/TP check\n"
        "/help — This message\n\n"
        "Environment:\n"
        "TELEGRAM_BOT_TOKEN — Bot token from @BotFather\n"
        "TELEGRAM_CHAT_ID — Restrict to your chat (get from /status)\n"
    )
    await update.message.reply_text(text)


# ── Main ────────────────────────────────────────────────────────


def main() -> None:
    if not config.has_telegram_credentials:
        print("Set TELEGRAM_BOT_TOKEN to start the bot.")
        print("Get one from @BotFather on Telegram.")
        sys.exit(1)

    if not config.has_oanda_credentials:
        print("Set OANDA_API_TOKEN and OANDA_ACCOUNT_ID.")
        sys.exit(1)

    log.info("Starting Telegram bot...")

    app = Application.builder().token(config.telegram_bot_token).build()

    # Commands
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("scan", cmd_scan))
    app.add_handler(CommandHandler("trade", cmd_trade))
    app.add_handler(CommandHandler("positions", cmd_positions))
    app.add_handler(CommandHandler("pnl", cmd_pnl))
    app.add_handler(CommandHandler("close", cmd_close))
    app.add_handler(CommandHandler("closeall", cmd_closeall))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("help", cmd_help))

    # Callbacks (confirmation buttons)
    app.add_handler(CallbackQueryHandler(trade_callback, pattern="^trade_"))
    app.add_handler(CallbackQueryHandler(closeall_callback, pattern="^closeall_"))

    log.info("Bot running — press Ctrl+C to stop")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
