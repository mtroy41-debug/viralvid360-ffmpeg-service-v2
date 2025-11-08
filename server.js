// server.js
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

// allow browser/apps to call this
app.use(cors());

// so we can read JSON body
app.use(express.json());

// health
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// process
app.post("/process", (req, res) => {
  const { inputUrl, outputKey } = req.body || {};

  if (!inputUrl || !outputKey) {
    return res.status(400).json({
      ok: false,
      error: "inputUrl and outputKey are required",
    });
  }

  // dummy response (this is what we’ll swap for real ffmpeg later)
  return res.json({
    ok: true,
    message: "process endpoint reached",
    inputUrl,
    outputKey,
    publicUrl: `https://cdn.viralvid360.com/${outputKey}`,
  });
});

// optional: so GET /process in browser doesn't look broken
app.get("/process", (req, res) => {
  res.json({
    ok: true,
    info: "POST here with { inputUrl, outputKey }"
  });
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
