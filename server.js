// server.js
import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

// so we can read JSON body
app.use(express.json());

// health check (this already works)
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// --- THIS is the route Postman is calling ---
app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body || {};

    if (!inputUrl || !outputKey) {
      return res.status(400).json({
        ok: false,
        error: "inputUrl and outputKey are required"
      });
    }

    // for now we just pretend we processed it – we can wire FFmpeg/R2 after
    return res.json({
      ok: true,
      message: "process endpoint reached",
      inputUrl,
      outputKey,
      // this is what your frontend expects
      publicUrl: `https://cdn.viralvid360.com/${outputKey}`
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
