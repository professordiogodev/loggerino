// index.js  –  Minimal Express + Morgan demo
import express from 'express';     // Node ≥18: ES‑module syntax works out of the box
import morgan  from 'morgan';

const app  = express();
const PORT = process.env.PORT ?? 3005;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(morgan('dev'));       // e.g. GET /status 200 12.3 ms - 36
app.use(express.json());      // built‑in JSON body parser

// ─── “Always‑OK” routes ────────────────────────────────────────────────────────
app.get('/',        (req, res) => res.send('👋 Hello, world!'));
app.get('/status',  (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.post('/echo',   (req, res) => res.json({ youSent: req.body }));

// ─── Helper that randomly throws ───────────────────────────────────────────────
function maybeThrow(req, res, next) {
  if (Math.random() < 0.5) {
    const pool = [
      Object.assign(new Error('Database connection failed'), { status: 503 }),
      Object.assign(new Error('Cache not available'),        { status: 500 }),
      Object.assign(new Error('Token expired'),              { status: 401 }),
    ];
    return next(pool[Math.floor(Math.random() * pool.length)]);
  }
  next();               // 50 % chance we fall through and route “works”
}

// ─── “Flaky” routes (50 % chance of failure) ───────────────────────────────────
app.get('/random',     maybeThrow, (req, res) => res.json({ value: Math.random() }));
app.post('/compute',   maybeThrow, (req, res) => res.json({ result: 42 }));

// ─── Route that ALWAYS fails ───────────────────────────────────────────────────
app.get('/error', (req, res, next) => next(new Error('This endpoint always bombs')));

// ─── 404 handler (no route matched) ────────────────────────────────────────────
app.use((req, res, next) => next(Object.assign(new Error('Not Found'), { status: 404 })));

// ─── Central error‑handling middleware ─────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  res.status(status).json({
    error: { message: err.message, status },
  });
});

// ─── Launch server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
