// server.js
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

// allow your website to call this service
app.use(
  cors({
    origin: "*", // you can tighten this later to https://viralvid360.com
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

// so we can read JSON
app.use(express.json());

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// preflight for browser
app.options("/process", (req, res) => {
  res.sendStatus(200);
});

// main endpoint
app.post("/process", async (req, res) => {
  const { inputUrl, outputKey } = req.body || {};

  if (!inputUrl || !outputKey) {
    return res.status(400).json({
      ok: false,
      error: "inputUrl and outputKey are required"
    });
  }

  // we’re not doing the real ffmpeg here yet — just confirming the call works
  return res.json({
    ok: true,
    message: "process endpoint reached",
    inputUrl,
    outputKey,
    publicUrl: `https://cdn.viralvid360.com/${outputKey}`
  });
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
