// server.js
import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

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
      error: "inputUrl and outputKey are required"
    });
  }

  // dummy response for now
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
