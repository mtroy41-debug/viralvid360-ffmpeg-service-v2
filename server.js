// server.js
import express from "express";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "200mb" }));

// ✅ CORS: allow your app + cdn + local
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
    // if you want to be super open, uncomment:
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

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "viralvid360-ffmpeg-service-v2" });
});

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

    // ✅ use global fetch (Node 20 has this)
    const sourceResp = await fetch(inputUrl);
    if (!sourceResp.ok) {
      return res.status(400).json({
        ok: false,
        error: `download failed: ${sourceResp.status} ${sourceResp.statusText}`,
        inputUrl,
      });
    }

    // save input to /tmp
    const inputPath = `/tmp/input.mp4`;
    const fileStream = fs.createWriteStream(inputPath);
    await new Promise((resolve, reject) => {
      sourceResp.body.pipe(fileStream);
      sourceResp.body.on("error", reject);
      fileStream.on("finish", resolve);
    });

    // make sure /tmp/processed/... exists
    const outLocalPath = `/tmp/${outputKey}`;
    ensureDirForFile(outLocalPath);

    // ✅ TODO: run your real ffmpeg here
    // for now just copy the input so the pipeline always succeeds
    fs.copyFileSync(inputPath, outLocalPath);
    console.log("processed to", outLocalPath);

    // build public URL
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

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("FFmpeg service listening on port", port);
});
