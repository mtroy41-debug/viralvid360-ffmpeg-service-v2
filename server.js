// server.js
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

// allow JSON
app.use(express.json());

// CORS – allow your site to call this service
app.use(
  cors({
    origin: [
      "https://viralvid360.com",
      "https://www.viralvid360.com",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// health
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// process
app.post("/process", async (req, res) => {
  const { inputUrl, outputKey } = req.body || {};

  if (!inputUrl || !outputKey) {
    return res.status(400).json({
      ok: false,
      error: "inputUrl and outputKey are required",
    });
  }

  // OPTIONAL: quick check the URL exists
  try {
    const headRes = await fetch(inputUrl, { method: "HEAD" });
    if (!headRes.ok) {
      return res.status(500).json({
        ok: false,
        error: `download failed: ${headRes.status} ${headRes.statusText}`,
      });
    }
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "download failed: " + e.message,
    });
  }

  // for now just return what your frontend expects
  return res.json({
    ok: true,
    message: "process endpoint reached",
    inputUrl,
    outputKey,
    publicUrl: `https://cdn.viralvid360.com/${outputKey}`,
  });
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
