import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import { z } from "zod";

const app = express();

// ---- config ----
const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- middleware ----
app.use(helmet());
app.use(express.json({ limit: "64kb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow no-origin (curl, server-to-server) and allowlisted origins
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // dev fallback
      return ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"));
    },
  })
);

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 30, // 30 requests/min per IP (adjust)
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---- routes ----
app.get("/health", (_req, res) => res.json({ ok: true }));

const AskSchema = z.object({
  question: z.string().trim().min(1).max(300),
  userName: z.string().trim().min(1).max(30).optional(),
  userColor: z.string().trim().min(1).max(20).optional(),
});

async function withTimeout(promise, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await promise(controller.signal);
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAI({ question }, attemptSignal) {
  const developer = `
You are a friendly VR 101 teacher inside a Unity VR classroom.
Answer in 1–3 short sentences. Beginner-friendly. No links.
If unrelated, redirect to VR basics: presence, tracking, locomotion, interaction, spatial audio, comfort.
  `.trim();

  const input = [
    { role: "developer", content: developer },
    {
      role: "user",
      content: `${question}`,
    },
  ];

  // Responses API is the recommended API for new projects. :contentReference[oaicite:1]{index=1}
  const resp = await client.responses.create({
    model: "gpt-5-mini",
    input,
    // You can also request a short max output if you want to cap cost/length
  }, { signal: attemptSignal });

  return resp.output_text || "I didn’t catch that—can you rephrase?";
}

app.post("/ask", async (req, res, next) => {
  try {
    const parsed = AskSchema.parse(req.body);

    // timeout + 1 retry (simple reliability)
    const answer = await withTimeout(async (signal) => {
      try {
        return await callOpenAI(parsed, signal);
      } catch (e) {
        // retry once on transient failures
        return await callOpenAI(parsed, signal);
      }
    }, 12_000);

    res.json({ answer });
  } catch (err) {
    next(err);
  }
});

// ---- error handler ----
app.use((err, _req, res, _next) => {
  const msg = err?.message || "Server error";
  const status =
    msg.includes("CORS") ? 403 :
    msg.includes("Too many requests") ? 429 :
    msg.includes("Expected") || msg.includes("Required") ? 400 :
    500;

  res.status(status).json({ error: msg });
});

app.listen(PORT, () => console.log(`VR101 AI server on :${PORT}`));
