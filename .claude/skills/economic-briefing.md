---
description: Get a full economic briefing — period, news impact, upcoming events, policy bias
allowed-tools: Bash, Read
---

Run the Research Team's economic assessment and present a briefing:

1. Run from `trading-algo-py/`:
```bash
cd trading-algo-py && python -c "
from team.ceo import ResearchTeam
from team.agent_network import AgentNetwork

network = AgentNetwork()
research = ResearchTeam(network, 'briefing')

period = research.assess_economic_period()
news = research.assess_news_impact()

print('=== ECONOMIC BRIEFING ===')
print(f'Phase: {period[\"phase\"].upper()} (confidence: {period[\"confidence\"]:.0%})')
print(f'Details: {period[\"details\"]}')
print(f'Policy bias: {period[\"policy_bias\"]}')
print(f'Risk adjustment: {period[\"risk_adjustment\"]}')
print(f'Event period: {period[\"is_event_period\"]}')
print()
print('Upcoming High-Impact Events:')
for e in period['upcoming_high_impact']:
    print(f'  {e[\"date\"]} — {e[\"name\"]}')
print()
print(f'=== NEWS IMPACT: {news[\"impact_level\"].upper()} (score {news[\"impact_score\"]}/100) ===')
print(f'Reduce size: {news[\"should_reduce_size\"]}')
if news['avoid_pairs']:
    print(f'Avoid: {', '.join(news[\"avoid_pairs\"])}')
for d in news['details']:
    print(f'  {d}')
"
```

2. Present the results clearly:
   - Current economic phase and why
   - Upcoming events that could move markets
   - Risk adjustment recommendation
   - Which pairs to avoid
