const ALPACA_API_KEY = process.env.ALPACA_API_KEY ?? "";
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET ?? "";
const ALPACA_BASE_URL =
  process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
const ALPACA_DATA_URL = "https://data.alpaca.markets";

const headers = {
  "APCA-API-KEY-ID": ALPACA_API_KEY,
  "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
  "Content-Type": "application/json",
};

async function alpacaFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers, next: { revalidate: 30 } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface Account {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  buying_power: string;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  daytrade_count: number;
  pattern_day_trader: boolean;
}

export interface Position {
  asset_id: string;
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  side: string;
}

export interface Order {
  id: string;
  symbol: string;
  qty: string;
  filled_qty: string;
  side: string;
  type: string;
  status: string;
  submitted_at: string;
  filled_at: string | null;
  filled_avg_price: string | null;
  limit_price: string | null;
}

export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Quote {
  symbol: string;
  last: { price: number; size: number; timestamp: string };
}

export async function getAccount(): Promise<Account> {
  return alpacaFetch<Account>(`${ALPACA_BASE_URL}/v2/account`);
}

export async function getPositions(): Promise<Position[]> {
  return alpacaFetch<Position[]>(`${ALPACA_BASE_URL}/v2/positions`);
}

export async function getOrders(
  status: string = "all",
  limit: number = 50
): Promise<Order[]> {
  return alpacaFetch<Order[]>(
    `${ALPACA_BASE_URL}/v2/orders?status=${status}&limit=${limit}&direction=desc`
  );
}

export async function getBars(
  symbol: string,
  timeframe: string = "1Day",
  limit: number = 30
): Promise<Bar[]> {
  const end = new Date().toISOString();
  const res = await alpacaFetch<{ bars: Bar[] }>(
    `${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&end=${end}&feed=iex`
  );
  return res.bars ?? [];
}

export async function getLatestQuotes(
  symbols: string[]
): Promise<Record<string, { ap: number; bp: number; as: number; bs: number }>> {
  const res = await alpacaFetch<{
    quotes: Record<string, { ap: number; bp: number; as: number; bs: number }>;
  }>(
    `${ALPACA_DATA_URL}/v2/stocks/quotes/latest?symbols=${symbols.join(",")}&feed=iex`
  );
  return res.quotes ?? {};
}
