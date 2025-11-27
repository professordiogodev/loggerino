// index.js – Express + Morgan file logging demo
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';          // File System module
import path, { dirname } from 'path'; // Path module
import { fileURLToPath } from 'url'; // For resolving __dirname in ES Modules

// Helper to get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app  = express();
const PORT = process.env.PORT ?? 3005;

// ─── Ensure logs/ directory exists ─────────────────────────────────────────────
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ─── Log File Setup ────────────────────────────────────────────────────────────
const logFilePath = path.join(logsDir, 'main.log');

// Create a write stream (in append mode 'a') for the log file
const accessLogStream = fs.createWriteStream(logFilePath, { flags: 'a' });
console.log(`Logs will be written to: ${logFilePath}`);

// ─── Middleware ────────────────────────────────────────────────────────────────
// 1. File Logging: Use 'combined' format for detailed, archival logs, saving to main.log
app.use(morgan('combined', { stream: accessLogStream }));

// 2. Console Logging: Keep 'dev' format for brief console output
app.use(morgan('dev')); // e.g. GET /status 200 12.3 ms - 36

app.use(express.json()); // built‑in JSON body parser

// ─── “Always‑OK” routes ────────────────────────────────────────────────────────
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
  next();           // 50 % chance we fall through and route “works”
}

// ─── “Flaky” routes (50 % chance of failure) ───────────────────────────────────
app.get('/random',    maybeThrow, (req, res) => res.json({ value: Math.random() }));
app.get('/compute',  maybeThrow, (req, res) => res.json({ result: 42 }));

// ─── Route that ALWAYS fails ───────────────────────────────────────────────────
app.get('/error', (req, res, next) => next(new Error('This endpoint always bombs')));

// ─── 404 handler (no route matched) ────────────────────────────────────────────
app.use((req, res, next) => next(Object.assign(new Error('Not Found'), { status: 404 })));

// ─── Central error‑handling middleware ─────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  
  // Log the error stack for server-side debugging and save it to main.log
  if (status >= 500) {
    // Prepare stack trace by replacing newlines with a delimiter for single-line logging
    const stackTrace = err.stack ? err.stack.replace(/\r?\n\s*/g, ' | ') : 'N/A';
    
    // Construct the single-line log entry for easy scraping, ending with \n for the file.
    // The message is quoted and internal quotes are escaped to prevent breaking the structure.
    const errorLogSingleLine = 
      `[${new Date().toISOString()}] || LEVEL=SERVER_ERROR || STATUS=${status} || METHOD=${req.method} || PATH=${req.originalUrl} || MESSAGE="${err.message.replace(/"/g, '""')}" || STACK=${stackTrace}\n`;
      
    // Write the detailed, single-line error to the log file (main.log)
    accessLogStream.write(errorLogSingleLine);
    
    // Also print a multi-line, readable version to console for immediate feedback
    console.error(
        `[${new Date().toISOString()}] Internal Server Error\n` +
        `  Method: ${req.method} | Path: ${req.originalUrl}\n` +
        `  Status: ${status} | Message: ${err.message}\n` +
        `  Stack Trace:\n${err.stack}\n`
    );
  }
  // For client errors (4xx), Morgan already logs the request/response status.
  else if (status >= 400 && status < 500) {
      console.warn(`[${status}] Client Error: ${err.message} on ${req.method} ${req.originalUrl}`);
  }


  res.status(status).json({
    error: { message: err.message, status },
  });
});

// ─── Launch server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));