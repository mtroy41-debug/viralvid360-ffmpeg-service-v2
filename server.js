import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from 'stream';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const https = require('https');

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

// Enhanced HTTPS agent for R2 compatibility
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: true, // Always validate certificates in production
  minVersion: 'TLSv1.2', // Minimum TLS version
});

// Cloudflare R2 Client with enhanced configuration
const r2 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  requestHandler: {
    httpsAgent,
  },
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ffmpeg-service",
    version: "3.0.0",
    node: process.version,
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
      console.error("[Auth] Unauthorized - invalid service key");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Validate request body
    const { inputUrl, outputKey, filter } = req.body || {};
    if (!inputUrl || !outputKey || !filter) {
      console.error("[Validate] Missing parameters:", { 
        hasInputUrl: !!inputUrl, 
        hasOutputKey: !!outputKey, 
        hasFilter: !!filter 
      });
      return res.status(400).json({ 
        ok: false, 
        error: "Missing required parameters",
        details: "inputUrl, outputKey, and filter are all required"
      });
    }

    // Validate R2 configuration
    if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      console.error("[R2] Configuration incomplete:", {
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

    console.log(`[Process] Starting job`);
    console.log(`[Process] Input: ${inputUrl.substring(0, 60)}...`);
    console.log(`[Process] Output: ${outputKey}`);
    console.log(`[Process] Filter: ${filter}`);

    inPath = `/tmp/in-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.mp4`;
    outPath = `/tmp/out-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.mp4`;

    // Step 1: Download input video
    console.log(`[Download] Fetching video...`);
    const startDownload = Date.now();
    const resp = await fetch(inputUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch video: HTTP ${resp.status} ${resp.statusText}`);
    }

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(inPath);
      const nodeStream = Readable.fromWeb(resp.body);
      
      nodeStream.pipe(file);
      nodeStream.on("error", reject);
      file.on("finish", resolve);
      file.on("error", reject);
    });

    const downloadTime = Date.now() - startDownload;
    const inputSize = fs.statSync(inPath).size;
    console.log(`[Download] Complete in ${downloadTime}ms. Size: ${(inputSize / 1024 / 1024).toFixed(2)} MB`);

    // Step 2: Process video with FFmpeg
    console.log(`[FFmpeg] Starting processing...`);
    const startProcess = Date.now();
    
    await new Promise((resolve, reject) => {
      const ffmpegArgs = [
        "-y",
        "-i", inPath,
        "-vf", filter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart", // Optimize for streaming
        outPath,
      ];

      const ff = spawn("ffmpeg", ffmpegArgs);
      
      let hasError = false;
      ff.stderr.on("data", (data) => {
        const output = data.toString();
        if (output.includes("error") || output.includes("Error")) {
          console.error(`[FFmpeg] ${output}`);
          hasError = true;
        }
      });

      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code === 0 && !hasError) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    });

    const processTime = Date.now() - startProcess;
    const outputSize = fs.statSync(outPath).size;
    console.log(`[FFmpeg] Complete in ${processTime}ms. Output: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);

    // Step 3: Upload to R2
    console.log(`[R2] Uploading to bucket "${R2_BUCKET}"...`);
    console.log(`[R2] Endpoint: ${R2_ENDPOINT}`);
    console.log(`[R2] Key: ${outputKey}`);
    
    const startUpload = Date.now();
    const buffer = fs.readFileSync(outPath);
    
    try {
      const uploadCommand = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: buffer,
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000", // Cache for 1 year
      });

      await r2.send(uploadCommand);
      
      const uploadTime = Date.now() - startUpload;
      console.log(`[R2] Upload complete in ${uploadTime}ms`);
      
    } catch (r2Error) {
      console.error(`[R2] Upload failed:`, r2Error);
      console.error(`[R2] Error name: ${r2Error.name}`);
      console.error(`[R2] Error code: ${r2Error.code}`);
      console.error(`[R2] HTTP status: ${r2Error.$metadata?.httpStatusCode}`);
      
      // Provide specific error guidance
      let hint = "R2 upload failed. ";
      if (r2Error.message?.includes('EPROTO') || r2Error.message?.includes('SSL')) {
        hint += "SSL/TLS connection error. Verify R2_ENDPOINT format is correct: https://<account-id>.r2.cloudflarestorage.com";
      } else if (r2Error.code === 'InvalidAccessKeyId') {
        hint += "Invalid R2_ACCESS_KEY_ID. Check your Cloudflare R2 credentials.";
      } else if (r2Error.code === 'SignatureDoesNotMatch') {
        hint += "Invalid R2_SECRET_ACCESS_KEY. Check your Cloudflare R2 credentials.";
      } else if (r2Error.code === 'NoSuchBucket') {
        hint += `Bucket "${R2_BUCKET}" not found. Create it in Cloudflare R2 dashboard.";
      } else {
        hint += "Check R2 credentials and endpoint configuration.";
      }
      
      throw new Error(`${hint}\nOriginal error: ${r2Error.message}`);
    }

    // Step 4: Cleanup
    try {
      if (inPath && fs.existsSync(inPath)) {
        fs.unlinkSync(inPath);
        console.log(`[Cleanup] Deleted ${inPath}`);
      }
      if (outPath && fs.existsSync(outPath)) {
        fs.unlinkSync(outPath);
        console.log(`[Cleanup] Deleted ${outPath}`);
      }
    } catch (cleanupError) {
      console.warn(`[Cleanup] Warning:`, cleanupError.message);
    }

    // Step 5: Success response
    const publicUrl = `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${outputKey}`;
    const totalTime = downloadTime + processTime;
    
    console.log(`[Success] Job complete in ${totalTime}ms`);
    console.log(`[Success] Public URL: ${publicUrl}`);

    return res.json({
      ok: true,
      message: "Processing complete",
      outputUrl: publicUrl,
      outputKey,
      debug: {
        times: {
          download: `${downloadTime}ms`,
          process: `${processTime}ms`,
          total: `${totalTime}ms`
        },
        sizes: {
          input: `${(inputSize / 1024 / 1024).toFixed(2)} MB`,
          output: `${(outputSize / 1024 / 1024).toFixed(2)} MB`
        },
        filter,
      }
    });

  } catch (err) {
    console.error(`[Error] Job failed:`, err.message);
    console.error(`[Error] Stack:`, err.stack);

    // Cleanup on error
    try {
      if (inPath && fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (cleanupError) {
      console.warn(`[Cleanup] Error:`, cleanupError.message);
    }

    return res.status(500).json({ 
      ok: false, 
      error: err.message,
      details: err.stack,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 FFmpeg Service v3.0.0 running on port ${PORT}`);
  console.log(`📦 Node.js version: ${process.version}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Configuration:`);
  console.log(`  ✓ R2_ENDPOINT: ${R2_ENDPOINT ? '✓' : '✗'}`);
  console.log(`  ✓ R2_BUCKET: ${R2_BUCKET ? '✓' : '✗'}`);
  console.log(`  ✓ R2_ACCESS_KEY_ID: ${R2_ACCESS_KEY_ID ? '✓' : '✗'}`);
  console.log(`  ✓ R2_SECRET_ACCESS_KEY: ${R2_SECRET_ACCESS_KEY ? '✓' : '✗'}`);
  console.log(`  ✓ SERVICE_KEY: ${SERVICE_KEY ? '✓' : '✗'}`);
  console.log(`${'='.repeat(60)}\n`);
});
