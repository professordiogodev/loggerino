// index.js – Express + Morgan Structured Logging + Prometheus Metrics
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import promClient from 'prom-client'; //  <-- 1. Import prom-client

// Helper to get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT ?? 3005;

// ----------------------------------------------------------------------------
// 1. Prometheus Metrics Setup
// ----------------------------------------------------------------------------

// A. Enable default metrics (e.g., CPU, Memory, NodeJS GC stats)
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'node_app_' }); // Add a prefix for clarity

// B. Define a custom Histogram for HTTP request duration
const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], // e.g. 5ms to 10s
});

// C. Define a custom Counter for application errors
const appErrorsCounter = new promClient.Counter({
  name: 'application_errors_total',
  help: 'Total count of application-level errors (e.g., uncaught exceptions, internal server errors)',
  labelNames: ['method', 'route', 'status_code'],
});


// ----------------------------------------------------------------------------
// 2. Logging Setup
// ----------------------------------------------------------------------------

// ─── Ensure logs/ directory exists ─────────────────────────────────────────────
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ─── Log File Setup ────────────────────────────────────────────────────────────
const logFilePath = path.join(logsDir, 'main.log');
const accessLogStream = fs.createWriteStream(logFilePath, { flags: 'a' });
console.log(`Logs will be written to: ${logFilePath}`);

// ─── Define a Structured Log Format for Morgan ─────────────────────────────────
// This format is designed for easy JSON/key-value parsing.
const structuredLogFormat = (tokens, req, res) => {
  // Extract essential fields
  const method = tokens.method(req, res);
  const url = tokens.url(req, res);
  const status = tokens.status(req, res);
  const responseTime = tokens['response-time'](req, res); // In milliseconds
  const contentLength = tokens.res(req, res, 'content-length') || '-';
  const remoteAddress = tokens['remote-addr'](req, res);
  const userAgent = tokens['user-agent'](req, res);
  const date = tokens.date(req, res, 'iso');
  
  // Custom token to safely quote messages/URL parts for single-line parsing
  const quote = (str) => `"${(str || '').replace(/"/g, '""')}"`;

  // Use a key-value structure for a single line (easier for log aggregators)
  return `[${date}] || LEVEL=INFO || STATUS=${status} || METHOD=${method} || PATH=${quote(url)} || RES_TIME_MS=${responseTime} || LENGTH=${contentLength} || REMOTE_IP=${remoteAddress} || USER_AGENT=${quote(userAgent)}`;
};


// ----------------------------------------------------------------------------
// 3. Middleware
// ----------------------------------------------------------------------------

// A. Metrics Middleware: Start the timer for Prometheus
app.use((req, res, next) => {
  req.start_time = process.hrtime(); // Use high-resolution timer
  next();
});

// B. Structured Console/File Logging
app.use(morgan(structuredLogFormat, { 
    stream: accessLogStream, // Write to file
}));
app.use(morgan(structuredLogFormat, { 
    // Use the `skip` function to prevent writing to console for the file stream.
    // Console output should be cleaner, so we'll customize it for console later.
    skip: (req, res) => false, // For file logging, we log everything.
}));
// Simpler console logging
app.use(morgan('dev')); // e.g. GET /status 200 12.3 ms - 36


app.use(express.json());

// ----------------------------------------------------------------------------
// 4. Routes (Same as original)
// ----------------------------------------------------------------------------

// ─── “Always-OK” routes ────────────────────────────────────────────────────────
app.get('/',         (req, res) => res.send('👋 Hello, world!'));
app.get('/status',  (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.post('/echo',   (req, res) => res.json({ youSent: req.body }));

// ─── Helper that randomly throws ───────────────────────────────────────────────
function maybeThrow(req, res, next) {
  if (Math.random() < 0.5) {
    const pool = [
      Object.assign(new Error('Database connection failed'), { status: 503 }),
      Object.assign(new Error('Cache not available'),         { status: 500 }),
      Object.assign(new Error('Token expired'),               { status: 401 }),
    ];
    return next(pool[Math.floor(Math.random() * pool.length)]);
  }
  next();
}

// ─── “Flaky” routes (50 % chance of failure) ───────────────────────────────────
app.get('/random',    maybeThrow, (req, res) => res.json({ value: Math.random() }));
app.get('/compute',  maybeThrow, (req, res) => res.json({ result: 42 }));

// ─── Route that ALWAYS fails ───────────────────────────────────────────────────
app.get('/error', (req, res, next) => next(new Error('This endpoint always bombs')));

// ----------------------------------------------------------------------------
// 5. Metrics Route
// ----------------------------------------------------------------------------

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// ----------------------------------------------------------------------------
// 6. Metrics and Logging Post-Processing
// ----------------------------------------------------------------------------

// Metrics and Logging finalization middleware - executed after the route handler and error handler.
app.use((req, res, next) => {
  // A. Prometheus Metrics Recording
  if (req.start_time) {
    const diff = process.hrtime(req.start_time);
    const durationInSeconds = diff[0] + diff[1] / 1e9; // Convert to seconds
    
    // Label for Prometheus
    const route = req.route ? req.route.path : req.path; // Use the matched route path or the original path
    const labels = {
        method: req.method,
        route: route,
        status_code: res.statusCode,
    };
    
    // Record the request duration
    httpRequestDurationMicroseconds.observe(labels, durationInSeconds);
  }
  
  // B. Morgan already handled INFO logs. Next up: 404/Error handling.
  next();
});

// ----------------------------------------------------------------------------
// 7. Error/404 Handling
// ----------------------------------------------------------------------------

// ─── 404 handler (no route matched) ────────────────────────────────────────────
app.use((req, res, next) => next(Object.assign(new Error('Not Found'), { status: 404 })));

// ─── Central error-handling middleware ─────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  const method = req.method;
  const path = req.originalUrl;
  const date = new Date().toISOString();
  
  // Custom function to safely quote messages for single-line logging
  const quote = (str) => `"${(str || '').replace(/"/g, '""')}"`;
  
  // 1. Log the error stack for server-side debugging
  if (status >= 500) {
    // Prepare stack trace by replacing newlines with a delimiter for single-line logging
    const stackTrace = err.stack ? err.stack.replace(/\r?\n\s*/g, ' | ') : 'N/A';
    
    // Construct the single-line log entry for easy scraping
    const errorLogSingleLine = 
      `[${date}] || LEVEL=SERVER_ERROR || STATUS=${status} || METHOD=${method} || PATH=${quote(path)} || MESSAGE=${quote(err.message)} || STACK=${quote(stackTrace)}\n`;
      
    // Write the detailed, single-line error to the log file (main.log)
    accessLogStream.write(errorLogSingleLine);
    
    // Also print a multi-line, readable version to console for immediate feedback
    console.error(
        `[${date}] Internal Server Error\n` +
        `  Method: ${method} | Path: ${path}\n` +
        `  Status: ${status} | Message: ${err.message}\n` +
        `  Stack Trace:\n${err.stack}\n`
    );

    // 2. Increment application error metric (only for 5xx errors)
    const route = req.route ? req.route.path : req.path;
    appErrorsCounter.inc({
        method: req.method,
        route: route,
        status_code: status
    });
  }
  // For client errors (4xx), log a WARN message
  else if (status >= 400 && status < 500) {
      const warningLogSingleLine = 
        `[${date}] || LEVEL=CLIENT_ERROR || STATUS=${status} || METHOD=${method} || PATH=${quote(path)} || MESSAGE=${quote(err.message)}\n`;
      
      accessLogStream.write(warningLogSingleLine);
      console.warn(`[${status}] Client Error: ${err.message} on ${method} ${path}`);
  }

  // Send JSON response to client
  res.status(status).json({
    error: { message: err.message, status },
  });
});

// ----------------------------------------------------------------------------
// 8. Launch server
// ----------------------------------------------------------------------------

app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));