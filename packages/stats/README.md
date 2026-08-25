# @san/stats

Local observability dashboard for AI usage statistics.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.san/agent/sessions/`
- **SQLite aggregation**: Efficient stats storage and querying using `bun:sqlite`
- **Web dashboard**: Real-time metrics visualization with Chart.js
- **Incremental sync**: Only processes new/modified log entries

## Metrics Tracked

| Metric | Calculation |
|--------|-------------|
| Tokens/s | `output_tokens / (duration / 1000)` |
| Cache Rate | `cache_read / (input + cache_read) * 100` |
| Error Rate | `count(stopReason=error) / total_calls * 100` |
| Total Cost | Sum of `usage.cost.total` |
| Avg Latency | Mean of `duration` |
| TTFT | Mean of `ttft` (time to first token) |

## Usage

### Via CLI

```bash
# Start dashboard server (default: http://localhost:3847)
san-stats

# Custom port
san-stats --port 8080

# Print summary to console
san-stats --summary

# Output as JSON (for scripting)
san-stats --json
```

### Programmatic

```typescript
import { getDashboardStats, getUsageAnalyticsStats, syncAllSessions } from "@san/stats";

// Sync session logs to database
const { processed, files } = await syncAllSessions();

// Get the existing dashboard aggregate
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);

// Get the unified consumption analytics payload
const usage = await getUsageAnalyticsStats("7d");
console.log(usage.summary.totalTokens);
console.log(usage.byProvider[0]?.provider);
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Overall stats with all breakdowns |
| `GET /api/stats/usage?range=24h` | Unified consumption analytics: summary, token/cost breakdown, provider/model/project rankings, and trends |
| `GET /api/stats/models` | Per-model statistics |
| `GET /api/stats/folders` | Per-folder/project statistics |
| `GET /api/stats/timeseries` | Hourly time series data |
| `GET /api/sync` | Trigger sync and return counts |

## Data Storage

- **Session logs**: `~/.san/agent/sessions/` (JSONL files)
- **Stats database**: `~/.san/stats.db` (SQLite)

## Dashboard

The web dashboard provides:

- Overall metrics cards (requests, cost, cache rate, error rate, duration, tokens/s)
- Time series chart showing requests and errors over time
- Per-model breakdown table
- Per-folder breakdown table
- Auto-refresh every 30 seconds

## License

MIT
