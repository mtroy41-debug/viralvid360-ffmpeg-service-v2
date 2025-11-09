import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from 'stream'; // Import Readable from Node.js stream module

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

    const { inputUrl, outputKey, filter } = req.body || {}; // Extract 'filter' parameter
    if (!inputUrl || !outputKey || !filter) { // Update validation to include 'filter'
      return res
        .status(400)
        .json({ ok: false, error: "inputUrl, outputKey, and filter are required" });
    }

    const inPath = `/tmp/in-${Date.now()}.mp4`;
    const outPath = `/tmp/out-${Date.now()}.mp4`;

    // Step 1: Download input
    console.log(`Downloading video from: ${inputUrl}`);
    const resp = await fetch(inputUrl);
    if (!resp.ok) throw new Error(`Failed to fetch input: ${resp.status}`);

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(inPath);
      const nodeStream = Readable.fromWeb(resp.body); // Convert Web stream to Node.js stream
      nodeStream.pipe(file); // Use the Node.js stream's pipe method
      nodeStream.on("error", reject); // Add error handling for the new stream
      file.on("finish", resolve);
      file.on("error", reject); // Ensure file write stream errors are caught
    });
    console.log(`Video downloaded to: ${inPath}`);

    // Step 2: Process video with FFmpeg, applying the filter
    console.log(`Processing video with filter: ${filter}`);
    await new Promise((resolve, reject) => {
      const ffmpegArgs = [
        "-y",
        "-i",
        inPath,
        "-vf", // Use -vf for video filters
        filter, // Inject the filter string here
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "copy", // Copy audio stream without re-encoding for efficiency
        outPath,
      ];

      const ff = spawn("ffmpeg", ffmpegArgs);
      ff.stderr.on("data", (d) => console.log(d.toString()));
      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code === 0) {
          console.log("FFmpeg processing complete");
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    });

    // Step 3: Upload to R2
    console.log(`Uploading processed video to R2 with key: ${outputKey}`);
    const buffer = fs.readFileSync(outPath);
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: buffer,
        ContentType: "video/mp4",
      })
    );
    console.log("Upload to R2 complete.");

    // Cleanup
    fs.unlink(inPath, (err) => { if (err) console.error(`Error deleting ${inPath}:`, err); });
    fs.unlink(outPath, (err) => { if (err) console.error(`Error deleting ${outPath}:`, err); });
    console.log("Temporary files cleaned up.");

    const publicUrl = `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${outputKey}`;

    return res.json({
      ok: true,
      message: "Processing complete",
      outputUrl: publicUrl, // Changed to outputUrl for consistency with frontend
      outputKey,
    });
  } catch (err) {
    console.error("Processing error:", err);
    return res.status(500).json({ ok: false, error: err.message, details: err.stack });
  }
});

app.listen(PORT, () => console.log(`FFmpeg service running on ${PORT}`));
