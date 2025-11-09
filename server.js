// server.js (Railway FFmpeg service)
import express from "express";
import https from "https";
import fs from "fs";
import { exec } from "child_process";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;

// --- CORS for your site ---
const allowedOrigin = "https://viralvid360.com";
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-service-key");
  // let preflight through
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// quick health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    ffmpegEnabled: process.env.ENABLE_FFMPEG === "true",
  });
});

// tiny helper: download a file to /tmp/input.mp4
function downloadToTmp(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    // NOTE: we relax TLS a bit because some sources are picky
    const agent = new https.Agent({ rejectUnauthorized: false });

    https
      .get(url, { agent }, (response) => {
        if (response.statusCode !== 200) {
          return reject(
            new Error(`download failed: ${response.statusCode} ${response.statusMessage}`)
          );
        }
        response.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}

app.post("/process", async (req, res) => {
  const serviceKey = process.env.SERVICE_KEY || "ffmpeg-test-123";
  const incomingKey = req.header("x-service-key");

  if (incomingKey !== serviceKey) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const { inputUrl, outputKey } = req.body || {};
  if (!inputUrl || !outputKey) {
    return res.status(400).json({ ok: false, error: "inputUrl and outputKey required" });
  }

  // IMPORTANT: your bucket is public at https://cdn.viralvid360.com/
  const publicBase = process.env.R2_PUBLIC_BASE_URL || "https://cdn.viralvid360.com";

  const tmpIn = "/tmp/input.mp4";
  const tmpOut = "/tmp/output.mp4";

  try {
    console.log("downloading", inputUrl);
    await downloadToTmp(inputUrl, tmpIn);

    // do a tiny ffmpeg to prove it works – you can change this to your real command
    const ffmpegCmd = `ffmpeg -y -i ${tmpIn} -c copy ${tmpOut}`;
    console.log("running:", ffmpegCmd);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (err, stdout, stderr) => {
        console.log(stdout);
        console.log(stderr);
        if (err) return reject(err);
        resolve();
      });
    });

    // TODO: here you would upload tmpOut to R2 with @aws-sdk/client-s3
    // for now we just return the public URL that Remix Studio expects
    const publicUrl = `${publicBase}/${outputKey}`;

    return res.json({
      ok: true,
      message: "process endpoint reached",
      inputUrl,
      outputKey,
      publicUrl,
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
