const express = require("express");
const cors = require("cors");
const { GarminConnect } = require("garmin-connect");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

const sessions = new Map();

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function randomToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

app.post("/api/auth", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const client = new GarminConnect({ username: email, password });
    await client.login(email, password);
    const token = randomToken();
    sessions.set(token, { client, createdAt: Date.now() });
    setTimeout(() => sessions.delete(token), 60 * 60 * 1000);
    return res.json({ token });
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid Garmin credentials" });
  }
});

app.get("/api/steps/week", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Invalid or expired session. Re-authenticate." });
  }
  const { client } = sessions.get(token);
  const { monday, sunday } = getWeekBounds();
  try {
    const summaries = await client.getStepsData(monday, sunday);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateStr = formatDate(d);
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
      goal: 56000,
      days,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Steps fetch error:", err.message);
    if (err.message?.includes("auth") || err.statusCode === 401) {
      sessions.delete(token);
      return res.status(401).json({ error: "Garmin session expired. Please re-authenticate." });
    }
    return res.status(500).json({ error: "Failed to fetch step data from Garmin." });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Garmin proxy running on http://localhost:${PORT}`);
});
