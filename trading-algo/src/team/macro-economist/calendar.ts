// ============================================================
// Economic Calendar — Static schedule of recurring events
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';
import type { EconomicEvent } from './types.js';

const logger = createModuleLogger('economic-calendar');

/**
 * Known recurring economic events with their typical schedules.
 * Dates are approximations based on historical patterns.
 */
const RECURRING_EVENTS: Omit<EconomicEvent, 'nextDate'>[] = [
  {
    name: 'FOMC Interest Rate Decision',
    description: 'Federal Open Market Committee interest rate announcement',
    impact: 'high',
    schedule: '8 times per year (~every 6 weeks)',
    source: 'Federal Reserve',
  },
  {
    name: 'CPI Release',
    description: 'Consumer Price Index monthly report',
    impact: 'high',
    schedule: 'Monthly, around the 10th–13th',
    source: 'Bureau of Labor Statistics',
  },
  {
    name: 'Non-Farm Payrolls (NFP)',
    description: 'Employment situation report',
    impact: 'high',
    schedule: 'First Friday of each month',
    source: 'Bureau of Labor Statistics',
  },
  {
    name: 'GDP Report',
    description: 'Gross Domestic Product quarterly estimate',
    impact: 'high',
    schedule: 'Quarterly — advance, second, and third estimate',
    source: 'Bureau of Economic Analysis',
  },
  {
    name: 'PCE Price Index',
    description: "Personal Consumption Expenditures — Fed's preferred inflation gauge",
    impact: 'high',
    schedule: 'Monthly, last week of the month',
    source: 'Bureau of Economic Analysis',
  },
  {
    name: 'ISM Manufacturing PMI',
    description: 'Institute for Supply Management manufacturing index',
    impact: 'medium',
    schedule: 'First business day of each month',
    source: 'ISM',
  },
  {
    name: 'Retail Sales',
    description: 'Monthly retail and food services sales',
    impact: 'medium',
    schedule: 'Monthly, around the 15th',
    source: 'Census Bureau',
  },
  {
    name: 'JOLTS Job Openings',
    description: 'Job Openings and Labor Turnover Survey',
    impact: 'medium',
    schedule: 'Monthly, first or second week',
    source: 'Bureau of Labor Statistics',
  },
  {
    name: 'Initial Jobless Claims',
    description: 'Weekly unemployment insurance claims',
    impact: 'medium',
    schedule: 'Every Thursday',
    source: 'Department of Labor',
  },
  {
    name: 'Michigan Consumer Sentiment',
    description: 'University of Michigan consumer confidence survey',
    impact: 'low',
    schedule: 'Monthly — preliminary mid-month, final end of month',
    source: 'University of Michigan',
  },
];

/**
 * FOMC meeting dates for 2026 (approximate — two-day meetings, release on second day).
 * These follow the pattern published by the Federal Reserve.
 */
const FOMC_DATES_2026 = [
  '2026-01-28', '2026-03-18', '2026-05-06', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16',
];

export class EconomicCalendar {
  /**
   * Get upcoming economic events with estimated next dates.
   */
  getUpcomingEvents(): EconomicEvent[] {
    const now = new Date();
    const events: EconomicEvent[] = [];

    for (const event of RECURRING_EVENTS) {
      const nextDate = this.estimateNextDate(event.name, now);
      events.push({ ...event, nextDate });
    }

    // Sort by next date (soonest first)
    events.sort((a, b) => a.nextDate.localeCompare(b.nextDate));

    logger.debug({ count: events.length }, 'Generated upcoming economic events');
    return events;
  }

  /**
   * Returns true if a high-impact event is within 24 hours.
   */
  isHighImpactPeriod(): boolean {
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const events = this.getUpcomingEvents();

    return events.some((event) => {
      if (event.impact !== 'high') return false;
      const eventTime = new Date(event.nextDate).getTime();
      const diff = Math.abs(eventTime - now);
      return diff <= twentyFourHours;
    });
  }

  // ---- private helpers ----

  /**
   * Estimate the next occurrence date for a given event.
   */
  private estimateNextDate(eventName: string, now: Date): string {
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed

    switch (eventName) {
      case 'FOMC Interest Rate Decision':
        return this.nextFomcDate(now);

      case 'CPI Release':
        return this.nextMonthlyDate(now, 12); // ~12th of month

      case 'Non-Farm Payrolls (NFP)':
        return this.nextFirstFriday(now);

      case 'GDP Report':
        return this.nextQuarterlyDate(now, 28); // ~28th of quarter-end month

      case 'PCE Price Index':
        return this.nextMonthlyDate(now, 28); // ~28th of month

      case 'ISM Manufacturing PMI':
        return this.nextMonthlyDate(now, 1); // ~1st of month

      case 'Retail Sales':
        return this.nextMonthlyDate(now, 15); // ~15th of month

      case 'JOLTS Job Openings':
        return this.nextMonthlyDate(now, 7); // ~7th of month

      case 'Initial Jobless Claims':
        return this.nextThursday(now);

      case 'Michigan Consumer Sentiment':
        return this.nextMonthlyDate(now, 14); // ~14th of month

      default:
        return this.nextMonthlyDate(now, 15);
    }
  }

  private nextFomcDate(now: Date): string {
    const nowStr = now.toISOString().slice(0, 10);
    for (const date of FOMC_DATES_2026) {
      if (date >= nowStr) return date;
    }
    // If past all 2026 dates, return first of next year estimate
    return `${now.getFullYear() + 1}-01-28`;
  }

  private nextMonthlyDate(now: Date, dayOfMonth: number): string {
    const candidate = new Date(now.getFullYear(), now.getMonth(), dayOfMonth);
    if (candidate.getTime() > now.getTime()) {
      return candidate.toISOString().slice(0, 10);
    }
    // Move to next month
    candidate.setMonth(candidate.getMonth() + 1);
    return candidate.toISOString().slice(0, 10);
  }

  private nextFirstFriday(now: Date): string {
    // Find first Friday of current or next month
    let candidate = new Date(now.getFullYear(), now.getMonth(), 1);
    while (candidate.getDay() !== 5) {
      candidate.setDate(candidate.getDate() + 1);
    }
    if (candidate.getTime() > now.getTime()) {
      return candidate.toISOString().slice(0, 10);
    }
    // Try next month
    candidate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    while (candidate.getDay() !== 5) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.toISOString().slice(0, 10);
  }

  private nextThursday(now: Date): string {
    const candidate = new Date(now);
    const daysUntilThursday = (4 - candidate.getDay() + 7) % 7 || 7;
    candidate.setDate(candidate.getDate() + daysUntilThursday);
    return candidate.toISOString().slice(0, 10);
  }

  private nextQuarterlyDate(now: Date, dayOfMonth: number): string {
    // Quarter-end months: March(2), June(5), September(8), December(11)
    const quarterEndMonths = [2, 5, 8, 11];
    for (const m of quarterEndMonths) {
      const candidate = new Date(now.getFullYear(), m, dayOfMonth);
      if (candidate.getTime() > now.getTime()) {
        return candidate.toISOString().slice(0, 10);
      }
    }
    // Next year Q1
    return `${now.getFullYear() + 1}-03-${dayOfMonth}`;
  }
}
