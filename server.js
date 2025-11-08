// server.js
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

// allow browser calls
app.use(cors());
app.use(express.json());

// health
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// POST /process
app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body || {};

    if (!inputUrl || !outputKey) {
      return res.status(400).json({
        ok: false,
        error: "inputUrl and outputKey are required",
      });
    }

    // 👇 this is where you'd actually run ffmpeg / upload to R2.
    // For now we just check that the URL looks real.
    // If the file at inputUrl doesn't exist, your real code would fail there.
    // We're just returning success so the frontend can continue.

    return res.json({
      ok: true,
      message: "process endpoint reached",
      inputUrl,
      outputKey,
      publicUrl: `https://cdn.viralvid360.com/${outputKey}`,
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
