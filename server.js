/**
 * Garmin Steps Proxy Server
 * Wraps the garmin-connect npm package to expose a simple REST API
 * for the weekly steps widget.
 *
 * Endpoints:
 *   POST /api/auth        — authenticate with Garmin credentials
 *   GET  /api/steps/week  — get current calendar week step data
 */

const express = require("express");
const cors = require("cors");
const { GarminConnect } = require("garmin-connect");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" })); // tighten this in production
app.use(express.json());

// In-memory session store (keyed by a random token we issue)
// For production, use Redis or a DB
const sessions = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { monday, sunday };
}

function formatDate(d) {
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

function randomToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/auth
 * Body: { email, password }
 * Returns: { token }
 */
app.post("/api/auth", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  try {
    const client = new GarminConnect({ username: email, password });
    await client.login();

    const token = randomToken();
    sessions.set(token, { client, createdAt: Date.now() });

    // Auto-expire sessions after 1 hour
    setTimeout(() => sessions.delete(token), 60 * 60 * 1000);

    return res.json({ token });
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid Garmin credentials" });
  }
});

/**
 * GET /api/steps/week
 * Header: Authorization: Bearer <token>
 * Returns: { weekStart, weekEnd, totalSteps, goal, days: [{date, steps}] }
 */
app.get("/api/steps/week", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Invalid or expired session. Re-authenticate." });
  }

  const { client } = sessions.get(token);
  const { monday, sunday } = getWeekBounds();

  try {
    // garmin-connect returns an array of daily summaries for a date range
    const summaries = await client.getStepsData(monday, sunday);

    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateStr = formatDate(d);

      // Find matching summary from Garmin
      const match = summaries?.find?.(
        (s) => s.calendarDate === dateStr || s.startTimeLocal?.startsWith(dateStr)
      );

      return {
        date: dateStr,
        dayLabel: d.toLocaleDateString("en-US", { weekday: "short" }),
        steps: match?.totalSteps ?? match?.steps ?? null,
      };
    });

    const totalSteps = days.reduce((sum, d) => sum + (d.steps || 0), 0);

    return res.json({
      weekStart: formatDate(monday),
      weekEnd: formatDate(sunday),
      totalSteps,
      goal: 70000, // 10k/day × 7
      days,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Steps fetch error:", err.message);

    // If session expired on Garmin's end, tell client to re-auth
    if (err.message?.includes("auth") || err.statusCode === 401) {
      sessions.delete(token);
      return res.status(401).json({ error: "Garmin session expired. Please re-authenticate." });
    }

    return res.status(500).json({ error: "Failed to fetch step data from Garmin." });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ ok: true }));

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Garmin proxy running on http://localhost:${PORT}`);
});
