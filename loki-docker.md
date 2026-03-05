# LogQL Queries for Loggerino (Docker)

A beginner-friendly cheat sheet of LogQL queries you can paste straight into
**Grafana → Explore → Loki** to query logs from the loggerino app running in
local Docker containers (collected by the Alloy agent).

> **Prerequisite:** You should already have loggerino, Loki, Alloy, and Grafana
> running on the `monitoring` Docker network as described in the README.

---

## How LogQL Works (the 30-second version)

Every query starts with a **log stream selector** inside curly braces `{}`.
This picks *which* logs to look at based on **labels** (metadata that Alloy
attaches — in our setup the Alloy config adds `app="loggerino"` and
`env="dev"` as external labels).

After the selector you can add **filters** (search inside the log text) and
**parsers** (extract fields so you can do math or more filtering).

```
{labels} |= "some text"     <- line filter
{labels} | pattern `...`    <- parser
```

---

## 1. Stream Selectors — Pick Your Logs

### See all loggerino logs

```logql
{app="loggerino"}
```

> `app="loggerino"` — matches the external label set in our Alloy config.
> This is the main selector you'll use in this Docker setup.

### Filter by environment label

```logql
{app="loggerino", env="dev"}
```

> You can combine multiple labels to be more specific.

---

## 2. Line Filters — Search Inside Logs

### Find all error-level logs

```logql
{app="loggerino"} |= "LEVEL=SERVER_ERROR"
```

> `|=` means **"line contains"**. This returns only lines that include the
> exact text `LEVEL=SERVER_ERROR`.

### Find client errors (4xx)

```logql
{app="loggerino"} |= "LEVEL=CLIENT_ERROR"
```

### Find 404 Not Found responses

```logql
{app="loggerino"} |= "STATUS=404"
```

### Exclude noisy health-check lines

```logql
{app="loggerino"} != "/status" != "/metrics"
```

> `!=` means **"line does NOT contain"**. You can chain multiple `!=` to
> filter out several things at once.

### Regex filter — find any 5xx status

```logql
{app="loggerino"} |~ "STATUS=5[0-9]{2}"
```

> `|~` means **"line matches regex"**. `5[0-9]{2}` matches 500, 503, etc.

---

## 3. Parsers — Extract Fields from Log Lines

The app writes structured logs like:

```
[2026-03-05T12:00:00.000Z] || LEVEL=INFO || STATUS=200 || METHOD=GET || PATH="/status" || RES_TIME_MS=1.23 ...
```

We can use the `pattern` or `regexp` parser to pull out individual fields.

### Parse with `pattern`

```logql
{app="loggerino"}
  | pattern `<_> || LEVEL=<level> || STATUS=<status> || METHOD=<method> || PATH=<path> || RES_TIME_MS=<response_time> || <_>`
```

> `<level>`, `<status>`, etc. become **extracted labels** you can filter on.
> `<_>` means "ignore this part".

### Parse with `regexp` (more precise)

```logql
{app="loggerino"}
  | regexp `LEVEL=(?P<level>\w+).*STATUS=(?P<status>\d+).*METHOD=(?P<method>\w+).*RES_TIME_MS=(?P<response_time>[\d.]+)`
```

> `(?P<name>...)` creates a named capture group. After this line, `level`,
> `status`, `method`, and `response_time` are available as labels.

### Filter on extracted fields

```logql
{app="loggerino"}
  | pattern `<_> || LEVEL=<level> || STATUS=<status> || METHOD=<method> || PATH=<path> || RES_TIME_MS=<response_time> || <_>`
  | status >= 500
```

> After parsing, you can use `|` with conditions like `=`, `!=`, `>`, `>=`,
> `<`, `<=` on extracted fields. Here we only keep lines where `status >= 500`.

### Show only POST requests

```logql
{app="loggerino"}
  | pattern `<_> || LEVEL=<level> || STATUS=<status> || METHOD=<method> || PATH=<path> || <_>`
  | method = "POST"
```

---

## 4. Metric Queries — Turn Logs into Numbers

These are what you use to build **Grafana dashboard panels** (graphs, stats).

### Count all log lines per second

```logql
rate({app="loggerino"}[5m])
```

> `rate(...[5m])` counts how many log lines were produced per second,
> averaged over the last 5 minutes. Think of it like a speedometer for logs.

### Count errors per second

```logql
rate({app="loggerino"} |= "LEVEL=SERVER_ERROR" [5m])
```

> Same idea, but we first filter to only error lines, then count them.

### Error rate as a percentage of total requests

```logql
sum(rate({app="loggerino"} |= "LEVEL=SERVER_ERROR" [5m]))
/
sum(rate({app="loggerino"} |= "LEVEL=" [5m]))
* 100
```

> Divides error count by total count and multiplies by 100 to get a
> percentage. Useful for an "error rate %" panel in Grafana.

### Count logs grouped by HTTP status code

```logql
sum by (status) (
  count_over_time(
    {app="loggerino"}
      | pattern `<_> || LEVEL=<level> || STATUS=<status> || <_>`
    [5m]
  )
)
```

> `count_over_time(...[5m])` counts log lines in 5-minute windows.
> `sum by (status)` groups the results so you get one line per status code
> (200, 404, 500, etc.) — great for a stacked bar chart.

### Count logs grouped by log level

```logql
sum by (level) (
  count_over_time(
    {app="loggerino"}
      | pattern `<_> || LEVEL=<level> || <_>`
    [5m]
  )
)
```

### Average response time (in ms)

```logql
avg_over_time(
  {app="loggerino"}
    | pattern `<_> || LEVEL=<level> || STATUS=<status> || METHOD=<method> || PATH=<path> || RES_TIME_MS=<response_time> || <_>`
    | unwrap response_time
  [5m]
) by (path)
```

> `unwrap response_time` tells Loki "treat this extracted field as a number".
> `avg_over_time` then computes the average. `by (path)` splits the result
> per endpoint — so you can see which routes are slow.

### P99 response time per route

```logql
quantile_over_time(0.99,
  {app="loggerino"}
    | pattern `<_> || LEVEL=<level> || STATUS=<status> || METHOD=<method> || PATH=<path> || RES_TIME_MS=<response_time> || <_>`
    | unwrap response_time
  [5m]
) by (path)
```

> Shows the 99th percentile response time. If this number is high, it means
> 1% of your requests are really slow.

---

## 5. Real-World Dashboard Queries

### Requests per second by route

```logql
sum by (path) (
  rate(
    {app="loggerino"}
      | pattern `<_> || LEVEL=<level> || STATUS=<status> || METHOD=<method> || PATH=<path> || <_>`
    [5m]
  )
)
```

### Top 5 slowest requests (instant table)

```logql
topk(5,
  avg_over_time(
    {app="loggerino"}
      | pattern `<_> || LEVEL=<level> || STATUS=<status> || METHOD=<method> || PATH=<path> || RES_TIME_MS=<response_time> || <_>`
      | unwrap response_time
    [1h]
  ) by (method, path)
)
```

> Use this with a **Table** visualization in Grafana. It shows the routes
> with the highest average response time over the last hour.

### Spot "Database connection failed" errors

```logql
{app="loggerino"} |= "Database connection failed"
```

> Simple text search. Works for any error message the app throws.

### Logs for a specific endpoint

```logql
{app="loggerino"} |= `PATH="/compute"`
```

> The backticks `` ` `` let you use double quotes inside the filter without
> escaping.

---

## Quick Reference

| Operator | Meaning                  | Example                          |
|----------|--------------------------|----------------------------------|
| `\|=`    | Line contains            | `\|= "error"`                    |
| `!=`     | Line does NOT contain    | `!= "/health"`                   |
| `\|~`    | Line matches regex       | `\|~ "STATUS=5\\d{2}"`           |
| `!~`     | Line does NOT match regex| `!~ "GET\|HEAD"`                 |
| `=`      | Label equals (selector)  | `{app="loggerino"}`              |
| `=~`     | Label matches regex      | `{app=~"logger.*"}`              |
| `!=`     | Label not equal          | `{env!="prod"}`                  |
| `!~`     | Label not match regex    | `{app!~"alloy-.*"}`             |

| Function              | What it does                                       |
|-----------------------|----------------------------------------------------|
| `rate([interval])`    | Log lines per second (averaged over interval)      |
| `count_over_time()`   | Total log lines in each interval window            |
| `avg_over_time()`     | Average of an `unwrap`-ed numeric field            |
| `quantile_over_time()`| Percentile (e.g. 0.99) of a numeric field          |
| `sum by (label)`      | Group and sum results by a label                   |
| `topk(n, ...)`        | Return only the top N results                      |
