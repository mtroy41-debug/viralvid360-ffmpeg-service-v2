import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const app = express();
const PORT = process.env.PORT || 8080;

// Env vars
const SERVICE_KEY = process.env.SERVICE_KEY || "";
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

app.use(express.json());

// Cloudflare R2 Client
const r2 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ffmpeg-service",
    ts: new Date().toISOString(),
  });
});

app.post("/process", async (req, res) => {
  try {
    const incomingKey = req.headers["x-service-key"];
    if (SERVICE_KEY && incomingKey !== SERVICE_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { inputUrl, outputKey } = req.body || {};
    if (!inputUrl || !outputKey) {
      return res
        .status(400)
        .json({ ok: false, error: "inputUrl and outputKey are required" });
    }

    const inPath = `/tmp/in-${Date.now()}.mp4`;
    const outPath = `/tmp/out-${Date.now()}.mp4`;

    // Step 1: Download input
    const resp = await fetch(inputUrl);
    if (!resp.ok) throw new Error(`Failed to fetch input: ${resp.status}`);
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(inPath);
      resp.body.pipe(file);
      resp.body.on("error", reject);
      file.on("finish", resolve);
    });

    // Step 2: Process video
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
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });
    });

    // Step 3: Upload to R2
    const buffer = fs.readFileSync(outPath);
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: buffer,
        ContentType: "video/mp4",
      })
    );

    // Cleanup
    fs.unlink(inPath, () => {});
    fs.unlink(outPath, () => {});

    const publicUrl = `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${outputKey}`;

    return res.json({
      ok: true,
      message: "Processing complete",
      publicUrl,
      outputKey,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`FFmpeg service running on ${PORT}`));
