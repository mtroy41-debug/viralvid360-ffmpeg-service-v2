import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from 'stream';

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

// Cloudflare R2 Client with enhanced configuration
const r2 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // Required for R2
  tls: true, // Explicitly enable TLS
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ffmpeg-service",
    version: "2.0.0",
    ts: new Date().toISOString(),
    config: {
      hasR2Endpoint: !!R2_ENDPOINT,
      hasR2Bucket: !!R2_BUCKET,
      hasR2Credentials: !!(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY),
      hasServiceKey: !!SERVICE_KEY,
    }
  });
});

// Process video endpoint
app.post("/process", async (req, res) => {
  let inPath = null;
  let outPath = null;

  try {
    // Validate service key
    const incomingKey = req.headers["x-service-key"];
    if (SERVICE_KEY && incomingKey !== SERVICE_KEY) {
      console.error("Unauthorized request - invalid service key");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Validate request body
    const { inputUrl, outputKey, filter } = req.body || {};
    if (!inputUrl || !outputKey || !filter) {
      console.error("Missing required parameters:", { hasInputUrl: !!inputUrl, hasOutputKey: !!outputKey, hasFilter: !!filter });
      return res.status(400).json({ 
        ok: false, 
        error: "Missing required parameters",
        details: "inputUrl, outputKey, and filter are all required"
      });
    }

    // Validate R2 configuration
    if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      console.error("R2 configuration incomplete:", {
        hasEndpoint: !!R2_ENDPOINT,
        hasBucket: !!R2_BUCKET,
        hasAccessKey: !!R2_ACCESS_KEY_ID,
        hasSecretKey: !!R2_SECRET_ACCESS_KEY
      });
      return res.status(500).json({
        ok: false,
        error: "R2 storage not configured",
        details: "Missing R2 environment variables"
      });
    }

    console.log(`[Process] Starting video processing`);
    console.log(`[Process] Input URL: ${inputUrl}`);
    console.log(`[Process] Output Key: ${outputKey}`);
    console.log(`[Process] Filter: ${filter}`);

    inPath = `/tmp/in-${Date.now()}.mp4`;
    outPath = `/tmp/out-${Date.now()}.mp4`;

    // Step 1: Download input video
    console.log(`[Download] Fetching video from: ${inputUrl}`);
    const resp = await fetch(inputUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch video: HTTP ${resp.status} ${resp.statusText}`);
    }

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(inPath);
      const nodeStream = Readable.fromWeb(resp.body);
      
      nodeStream.pipe(file);
      nodeStream.on("error", (err) => {
        console.error(`[Download] Stream error:`, err);
        reject(err);
      });
      file.on("finish", () => {
        console.log(`[Download] Video saved to: ${inPath}`);
        resolve();
      });
      file.on("error", (err) => {
        console.error(`[Download] File write error:`, err);
        reject(err);
      });
    });

    const inputSize = fs.statSync(inPath).size;
    console.log(`[Download] Complete. File size: ${(inputSize / 1024 / 1024).toFixed(2)} MB`);

    // Step 2: Process video with FFmpeg
    console.log(`[FFmpeg] Starting processing with filter: ${filter}`);
    await new Promise((resolve, reject) => {
      const ffmpegArgs = [
        "-y",
        "-i", inPath,
        "-vf", filter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "copy",
        outPath,
      ];

      const ff = spawn("ffmpeg", ffmpegArgs);
      
      ff.stderr.on("data", (data) => {
        const output = data.toString();
        // Only log important FFmpeg messages
        if (output.includes("error") || output.includes("Error")) {
          console.error(`[FFmpeg] ${output}`);
        }
      });

      ff.on("error", (err) => {
        console.error(`[FFmpeg] Process error:`, err);
        reject(err);
      });

      ff.on("close", (code) => {
        if (code === 0) {
          console.log(`[FFmpeg] Processing complete`);
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    });

    const outputSize = fs.statSync(outPath).size;
    console.log(`[FFmpeg] Output file size: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);

    // Step 3: Upload to R2
    console.log(`[R2] Uploading to bucket: ${R2_BUCKET}, key: ${outputKey}`);
    console.log(`[R2] Endpoint: ${R2_ENDPOINT}`);
    
    const buffer = fs.readFileSync(outPath);
    
    try {
      await r2.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: outputKey,
          Body: buffer,
          ContentType: "video/mp4",
        })
      );
      console.log(`[R2] Upload successful`);
    } catch (r2Error) {
      console.error(`[R2] Upload failed:`, r2Error);
      console.error(`[R2] Error details:`, {
        message: r2Error.message,
        code: r2Error.code,
        statusCode: r2Error.$metadata?.httpStatusCode,
        endpoint: R2_ENDPOINT,
        bucket: R2_BUCKET,
      });
      throw new Error(`R2 upload failed: ${r2Error.message}`);
    }

    // Step 4: Cleanup temporary files
    try {
      if (inPath && fs.existsSync(inPath)) {
        fs.unlinkSync(inPath);
        console.log(`[Cleanup] Deleted input file: ${inPath}`);
      }
      if (outPath && fs.existsSync(outPath)) {
        fs.unlinkSync(outPath);
        console.log(`[Cleanup] Deleted output file: ${outPath}`);
      }
    } catch (cleanupError) {
      console.error(`[Cleanup] Error deleting temp files:`, cleanupError);
    }

    // Step 5: Return success response
    const publicUrl = `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${outputKey}`;
    console.log(`[Success] Processing complete. Public URL: ${publicUrl}`);

    return res.json({
      ok: true,
      message: "Processing complete",
      outputUrl: publicUrl,
      outputKey,
      debug: {
        inputSize: `${(inputSize / 1024 / 1024).toFixed(2)} MB`,
        outputSize: `${(outputSize / 1024 / 1024).toFixed(2)} MB`,
        filter,
      }
    });

  } catch (err) {
    console.error(`[Error] Processing failed:`, err);
    console.error(`[Error] Stack trace:`, err.stack);

    // Cleanup on error
    try {
      if (inPath && fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (cleanupError) {
      console.error(`[Error] Cleanup failed:`, cleanupError);
    }

    // Provide helpful error hints
    let hint = "Check Railway logs for details";
    if (err.message.includes("fetch")) {
      hint = "Failed to download input video. Check that the URL is accessible from Railway.";
    } else if (err.message.includes("FFmpeg")) {
      hint = "FFmpeg processing failed. Check the filter syntax or video format compatibility.";
    } else if (err.message.includes("R2") || err.message.includes("EPROTO") || err.message.includes("SSL")) {
      hint = "R2 upload failed. Check R2_ENDPOINT format (should be https://<account-id>.r2.cloudflarestorage.com), R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in Railway environment variables.";
    }

    return res.status(500).json({ 
      ok: false, 
      error: err.message,
      hint,
      details: err.stack,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] FFmpeg service running on port ${PORT}`);
  console.log(`[Server] Configuration check:`);
  console.log(`  - R2_ENDPOINT: ${R2_ENDPOINT ? '✓' : '✗'}`);
  console.log(`  - R2_BUCKET: ${R2_BUCKET ? '✓' : '✗'}`);
  console.log(`  - R2_ACCESS_KEY_ID: ${R2_ACCESS_KEY_ID ? '✓' : '✗'}`);
  console.log(`  - R2_SECRET_ACCESS_KEY: ${R2_SECRET_ACCESS_KEY ? '✓' : '✗'}`);
  console.log(`  - SERVICE_KEY: ${SERVICE_KEY ? '✓' : '✗'}`);
});
