import { NextResponse } from "next/server";
import { getBars } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") ?? "AAPL";
    const timeframe = searchParams.get("timeframe") ?? "1Day";
    const bars = await getBars(symbol, timeframe);
    return NextResponse.json(bars);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
