// server.js
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

// parse JSON bodies
app.use(express.json());

// allow browser calls (you can tighten origin later)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// simple root
app.get("/", (req, res) => {
  res.json({ ok: true, service: "viralvid360-ffmpeg-service-v2" });
});

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// handle OPTIONS for /process (browser preflight)
app.options("/process", (req, res) => {
  res.sendStatus(200);
});

// main endpoint your site will call
app.post("/process", (req, res) => {
  const { inputUrl, outputKey } = req.body || {};

  // validate
  if (!inputUrl || !outputKey) {
    return res.status(400).json({
      ok: false,
      error: "inputUrl and outputKey are required"
    });
  }

  // dummy success response — this is what your frontend expects
  return res.json({
    ok: true,
    message: "process endpoint reached",
    inputUrl,
    outputKey,
    publicUrl: `https://cdn.viralvid360.com/${outputKey}`
  });
});

// start server
app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
