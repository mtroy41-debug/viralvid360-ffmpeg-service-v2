// server.js
import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const app = express();
const PORT = process.env.PORT || 8080;

// --- envs from your Railway screenshot ---
const SERVICE_KEY = process.env.SERVICE_KEY || ""; // e.g. "ffmpeg-test-123"
const R2_ENDPOINT = process.env.R2_ENDPOINT;       // e.g. https://fe0e...r2.cloudflarestorage.com
const R2_BUCKET = process.env.R2_BUCKET;           // e.g. viralvid360
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL; // e.g. https://cdn.viralvid360.com
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

app.use(express.json());

// R2 client (Cloudflare R2 is S3-compatible)
const r2 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    service: "ffmpeg-processor",
  });
});

// main process
app.post("/process", async (req, res) => {
  try {
    // optional shared secret
    const incomingKey = req.headers["x-service-key"];
    if (SERVICE_KEY && incomingKey !== SERVICE_KEY) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { inputUrl, outputKey } = req.body || {};
    if (!inputUrl || !outputKey) {
      return res
        .status(400)
        .json({ ok: false, error: "inputUrl and outputKey are required" });
    }

    // 1) download to /tmp
    const inPath = `/tmp/in-${Date.now()}.mp4`;
    const outPath = `/tmp/out-${Date.now()}.mp4`;

    const resp = await fetch(inputUrl);
    if (!resp.ok) {
      return res.status(500).json({
        ok: false,
        error: `failed to download input: ${resp.status} ${resp.statusText}`,
      });
    }

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(inPath);
      resp.body.pipe(file);
      resp.body.on("error", reject);
      file.on("finish", resolve);
    });

    // 2) run ffmpeg
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-i",
        inPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        outPath,
      ]);

      ff.stderr.on("data", (d) => console.log(d.toString()));
      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code === 0) return resolve();
        return reject(new Error(`ffmpeg exited with code ${code}`));
      });
    });

    // 3) upload to R2
    const fileBuffer = fs.readFileSync(outPath);

    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: fileBuffer,
        ContentType: "video/mp4",
      })
    );

    // 4) cleanup
    fs.unlink(inPath, () => {});
    fs.unlink(outPath, () => {});

    // 5) public URL back to Remix Studio
    const publicUrl =
      R2_PUBLIC_BASE_URL.replace(/\/+$/, "") + "/" + outputKey.replace(/^\/+/, "");

    return res.json({
      ok: true,
      message: "video processed",
      inputUrl,
      outputKey,
      publicUrl,
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
