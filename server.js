import express from "express";
import bodyParser from "body-parser";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.json());

// 🩺 Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// 🎬 Ensure output directory exists
function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ⚙️ POST /process — main video handler
app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body;

    if (!inputUrl || !outputKey) {
      return res.status(400).json({ ok: false, error: "Missing inputUrl or outputKey" });
    }

    const outputDir = "/tmp/processed";
    ensureDirForFile(`${outputDir}/${outputKey}`);

    const outPath = path.join(outputDir, outputKey);
    const ffmpegCmd = `ffmpeg -y -i "${inputUrl}" -t 6 -c:v libx264 -preset ultrafast -c:a copy "${outPath}"`;

    console.log("🎥 Running:", ffmpegCmd);
    exec(ffmpegCmd, async (err, stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg error:", stderr);
        return res.status(500).json({ ok: false, error: stderr });
      }

      console.log("✅ FFmpeg finished:", outPath);

      // Normally you'd upload to R2 here
      const outputUrl = `https://cdn.viralvid360.com/${outputKey}`;
      res.json({ ok: true, outputUrl });
    });
  } catch (err) {
    console.error("🔥 Internal error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 🚀 Start
app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
