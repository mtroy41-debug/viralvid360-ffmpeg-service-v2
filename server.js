// server.js
import express from "express";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "200mb" }));

// ---- CORS (allow app + cdn + local) ----
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = [
    "https://viralvid360.com",
    "https://www.viralvid360.com",
    "https://cdn.viralvid360.com",
    "http://localhost:3000",
    "http://localhost:5173",
  ];

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // if you want to open it up, uncomment:
    // res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-service-key");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// ---- helpers ----
function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---- health ----
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "viralvid360-ffmpeg-service-v2" });
});

// ---- main process ----
app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body;

    if (!inputUrl) {
      return res.status(400).json({ ok: false, error: "inputUrl is required" });
    }
    if (!outputKey) {
      return res.status(400).json({ ok: false, error: "outputKey is required" });
    }

    console.log("downloading", inputUrl);

    // Node 20 has global fetch
    const sourceResp = await fetch(inputUrl);
    if (!sourceResp.ok) {
      return res.status(400).json({
        ok: false,
        error: `download failed: ${sourceResp.status} ${sourceResp.statusText}`,
        inputUrl,
      });
    }

    // ---- save input to /tmp/input.mp4 ----
    const arrayBuf = await sourceResp.arrayBuffer();
    const inputPath = "/tmp/input.mp4";
    fs.writeFileSync(inputPath, Buffer.from(arrayBuf));

    // ---- make sure output dir exists ----
    const outLocalPath = `/tmp/${outputKey}`;
    ensureDirForFile(outLocalPath);

    // ---- TODO: run real ffmpeg ----
    // for now just copy input → output so pipeline succeeds
    fs.copyFileSync(inputPath, outLocalPath);
    console.log("processed to", outLocalPath);

    // ---- build public url ----
    const cdnBase =
      process.env.R2_PUBLIC_BASE_URL || "https://cdn.viralvid360.com";
    const publicUrl = `${cdnBase}/${outputKey}`;

    return res.json({
      ok: true,
      inputUrl,
      outputKey,
      url: publicUrl,
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal error",
    });
  }
});

// ---- start server ----
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("FFmpeg service listening on port", port);
});
