"use client";

import { useEffect, useState } from "react";
import { Card, Stat } from "@/components/Card";

interface Account {
  portfolio_value: string;
  equity: string;
  last_equity: string;
  cash: string;
  buying_power: string;
  long_market_value: string;
  daytrade_count: number;
}

interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  side: string;
}

interface Order {
  id: string;
  symbol: string;
  qty: string;
  filled_qty: string;
  side: string;
  type: string;
  status: string;
  submitted_at: string;
  filled_avg_price: string | null;
  limit_price: string | null;
}

interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function fmt(n: number | string, decimals = 2): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function pct(n: number | string): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  return `${(num * 100).toFixed(2)}%`;
}

export default function Dashboard() {
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [bars, setBars] = useState<Bar[]>([]);
  const [barSymbol, setBarSymbol] = useState("AAPL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [acc, pos, ord] = await Promise.all([
          fetch("/api/account").then((r) => r.json()),
          fetch("/api/positions").then((r) => r.json()),
          fetch("/api/orders").then((r) => r.json()),
        ]);
        if (acc.error) throw new Error(acc.error);
        setAccount(acc);
        setPositions(Array.isArray(pos) ? pos : []);
        setOrders(Array.isArray(ord) ? ord : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  useEffect(() => {
    fetch(`/api/bars?symbol=${barSymbol}`)
      .then((r) => r.json())
      .then((data) => setBars(Array.isArray(data) ? data : []))
      .catch(() => setBars([]));
  }, [barSymbol]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-[var(--muted)]">Loading dashboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="text-[var(--red)] text-lg">Error</div>
        <div className="text-[var(--muted)] max-w-md text-center text-sm">
          {error}
        </div>
        <p className="text-xs text-[var(--muted)]">
          Make sure your .env.local has valid Alpaca API keys.
        </p>
      </div>
    );
  }

  const dailyPl = account
    ? parseFloat(account.equity) - parseFloat(account.last_equity)
    : 0;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold">Alpaca Paper Trading Dashboard</h1>

      {/* Account Overview */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
        <Card title="Portfolio Value">
          <Stat label="" value={`$${fmt(account?.portfolio_value ?? 0)}`} />
        </Card>
        <Card title="Equity">
          <Stat label="" value={`$${fmt(account?.equity ?? 0)}`} />
        </Card>
        <Card title="Daily P&L">
          <Stat label="" value={`$${fmt(dailyPl)}`} delta={dailyPl} />
        </Card>
        <Card title="Cash">
          <Stat label="" value={`$${fmt(account?.cash ?? 0)}`} />
        </Card>
        <Card title="Buying Power">
          <Stat label="" value={`$${fmt(account?.buying_power ?? 0)}`} />
        </Card>
        <Card title="Day Trades">
          <Stat label="" value={String(account?.daytrade_count ?? 0)} />
        </Card>
      </div>

      {/* Positions */}
      <Card title="Positions" className="mb-6">
        {positions.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No open positions</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                  <th className="pb-2">Symbol</th>
                  <th className="pb-2">Side</th>
                  <th className="pb-2 text-right">Qty</th>
                  <th className="pb-2 text-right">Avg Entry</th>
                  <th className="pb-2 text-right">Current</th>
                  <th className="pb-2 text-right">Mkt Value</th>
                  <th className="pb-2 text-right">P&L</th>
                  <th className="pb-2 text-right">P&L %</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pl = parseFloat(p.unrealized_pl);
                  const plColor = pl >= 0 ? "text-[var(--green)]" : "text-[var(--red)]";
                  return (
                    <tr key={p.symbol} className="border-b border-[var(--border)]">
                      <td className="py-2 font-medium">{p.symbol}</td>
                      <td className="py-2 capitalize">{p.side}</td>
                      <td className="py-2 text-right">{p.qty}</td>
                      <td className="py-2 text-right">${fmt(p.avg_entry_price)}</td>
                      <td className="py-2 text-right">${fmt(p.current_price)}</td>
                      <td className="py-2 text-right">${fmt(p.market_value)}</td>
                      <td className={`py-2 text-right ${plColor}`}>
                        ${fmt(p.unrealized_pl)}
                      </td>
                      <td className={`py-2 text-right ${plColor}`}>
                        {pct(p.unrealized_plpc)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Market Data */}
      <Card title={`Market Data — ${barSymbol} (30d)`} className="mb-6">
        <div className="mb-3 flex gap-2">
          {["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "SPY"].map((s) => (
            <button
              key={s}
              onClick={() => setBarSymbol(s)}
              className={`rounded px-3 py-1 text-xs ${
                barSymbol === s
                  ? "bg-white text-black"
                  : "bg-[var(--border)] text-[var(--muted)] hover:text-white"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        {bars.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No bar data available</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                  <th className="pb-2">Date</th>
                  <th className="pb-2 text-right">Open</th>
                  <th className="pb-2 text-right">High</th>
                  <th className="pb-2 text-right">Low</th>
                  <th className="pb-2 text-right">Close</th>
                  <th className="pb-2 text-right">Volume</th>
                </tr>
              </thead>
              <tbody>
                {bars.slice(-10).map((b) => (
                  <tr key={b.t} className="border-b border-[var(--border)]">
                    <td className="py-1.5">{new Date(b.t).toLocaleDateString()}</td>
                    <td className="py-1.5 text-right">${fmt(b.o)}</td>
                    <td className="py-1.5 text-right">${fmt(b.h)}</td>
                    <td className="py-1.5 text-right">${fmt(b.l)}</td>
                    <td className="py-1.5 text-right">${fmt(b.c)}</td>
                    <td className="py-1.5 text-right">{b.v.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Orders */}
      <Card title="Recent Orders">
        {orders.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No orders</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                  <th className="pb-2">Symbol</th>
                  <th className="pb-2">Side</th>
                  <th className="pb-2">Type</th>
                  <th className="pb-2 text-right">Qty</th>
                  <th className="pb-2 text-right">Filled</th>
                  <th className="pb-2 text-right">Price</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 20).map((o) => (
                  <tr key={o.id} className="border-b border-[var(--border)]">
                    <td className="py-2 font-medium">{o.symbol}</td>
                    <td
                      className={`py-2 capitalize ${
                        o.side === "buy" ? "text-[var(--green)]" : "text-[var(--red)]"
                      }`}
                    >
                      {o.side}
                    </td>
                    <td className="py-2">{o.type}</td>
                    <td className="py-2 text-right">{o.qty}</td>
                    <td className="py-2 text-right">{o.filled_qty}</td>
                    <td className="py-2 text-right">
                      {o.filled_avg_price
                        ? `$${fmt(o.filled_avg_price)}`
                        : o.limit_price
                          ? `$${fmt(o.limit_price)}`
                          : "—"}
                    </td>
                    <td className="py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          o.status === "filled"
                            ? "bg-green-900/30 text-[var(--green)]"
                            : o.status === "canceled"
                              ? "bg-red-900/30 text-[var(--red)]"
                              : "bg-yellow-900/30 text-yellow-400"
                        }`}
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="py-2 text-xs text-[var(--muted)]">
                      {new Date(o.submitted_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <footer className="mt-8 text-center text-xs text-[var(--muted)]">
        Paper Trading — Data refreshes on page load
      </footer>
    </main>
  );
}
