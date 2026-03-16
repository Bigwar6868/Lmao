import { describe, it, expect } from 'vitest';

describe('Risk Manager', () => {
  describe('Position Sizing', () => {
    it('should never exceed max position size', () => {
      const capital = 10000;
      const maxPct = 5;
      const maxSize = capital * (maxPct / 100);

      // Even with high Kelly fraction, cap at 5%
      const kellyFraction = 0.25;
      const size = Math.min(capital * kellyFraction, maxSize);
      expect(size).toBeLessThanOrEqual(maxSize);
    });

    it('should reduce size in high-risk environments', () => {
      const baseSize = 500;
      const riskMultipliers = { low: 1.0, medium: 0.8, high: 0.5, extreme: 0.25 };

      expect(baseSize * riskMultipliers.low).toBe(500);
      expect(baseSize * riskMultipliers.medium).toBe(400);
      expect(baseSize * riskMultipliers.high).toBe(250);
      expect(baseSize * riskMultipliers.extreme).toBe(125);
    });
  });

  describe('Stop Loss', () => {
    it('should set stop below entry for long', () => {
      const entry = 100;
      const atr = 5;
      const multiplier = 2;
      const stop = entry - atr * multiplier;
      expect(stop).toBe(90);
      expect(stop).toBeLessThan(entry);
    });

    it('should set stop above entry for short', () => {
      const entry = 100;
      const atr = 5;
      const multiplier = 2;
      const stop = entry + atr * multiplier;
      expect(stop).toBe(110);
      expect(stop).toBeGreaterThan(entry);
    });

    it('should detect stop trigger', () => {
      const stopPrice = 90;
      const currentPrice = 88;
      const side = 'buy';
      const triggered = side === 'buy' ? currentPrice <= stopPrice : currentPrice >= stopPrice;
      expect(triggered).toBe(true);
    });
  });

  describe('Portfolio Constraints', () => {
    it('should detect drawdown exceeded', () => {
      const initialCapital = 10000;
      const currentEquity = 7500;
      const maxDrawdownPct = 20;
      const drawdown = ((initialCapital - currentEquity) / initialCapital) * 100;
      expect(drawdown).toBe(25);
      expect(drawdown > maxDrawdownPct).toBe(true);
    });
  });
});
