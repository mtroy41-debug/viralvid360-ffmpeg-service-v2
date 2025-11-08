import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import tmp from "tmp"; // Import the tmp library
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 8080;

// Environment Variables for R2 and Service Configuration
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize S3 Client (for R2)
let s3 = null;
if (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  s3 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    tls: { rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' } // Respect environment variable
  });
  console.log('[R2] ✅ Configured');
} else {
  console.error('[R2] ❌ Missing credentials for R2!');
}

// Function to check FFmpeg presence and version
let ffmpegPath = 'ffmpeg'; // Default, assume it's in PATH
async function checkFfmpeg() {
  try {
    const { stdout } = await execAsync('which ffmpeg');
    ffmpegPath = stdout.trim(); // Get full path if `which` works
    const { stdout: versionStdout } = await execAsync(`${ffmpegPath} -version`);
    console.log(`[FFmpeg] ✅ Found at: ${ffmpegPath}`);
    console.log(`[FFmpeg] Version: ${versionStdout.split('\n')[0]}`);
    return true;
  } catch (error) {
    console.error(`[FFmpeg] ❌ Not found or executable: ${error.message}`);
    console.error('[FFmpeg] Please ensure FFmpeg is installed and in the PATH.');
    return false;
  }
}

let isFfmpegReady = false;
// Health Check Endpoint
app.get("/health", async (req, res) => {
  if (!isFfmpegReady) {
    isFfmpegReady = await checkFfmpeg(); // Check on first health request if not already checked
  }

  res.json({
    ok: true,
    service: "ffmpeg-cli-processor",
    version: "3.1-bulletproof", // Updated version for tracking
    timestamp: new Date().toISOString(),
    r2Configured: !!s3,
    ffmpegReady: isFfmpegReady
  });
});

// Helper: Download file to buffer
async function downloadToBuffer(url) {
  console.log('[Download] Fetching input video...');
  const response = await fetch(url, {
    // Adding `signal` to prevent infinite hangs on problematic URLs
    signal: AbortSignal.timeout(60000) // 60 seconds timeout for download
  });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[Download] ✅ ${buffer.length} bytes downloaded.`);
  return buffer;
}

// Helper: Process video with FFmpeg CLI
async function processVideoCLI(inputPath, outputPath, style = 'cinematic') {
  console.log(`[FFmpeg-CLI] Starting processing for style: ${style}`);
  
  // Style filters mapped to FFmpeg CLI syntax
  const filters = {
    cinematic: 'eq=contrast=1.2:brightness=0.1:saturation=1.1',
    vibrant: 'eq=contrast=1.3:saturation=1.5',
    vintage: 'curves=vintage,vignette',
    bw: 'hue=s=0',
    default: 'scale=1920:1080' // A generic filter if style not found
  };
  
  const filter = filters[style] || filters.default;
  
  // Construct FFmpeg CLI command using the detected path
  const ffmpegCmd = `${ffmpegPath} -i "${inputPath}" -vf "${filter}" -c:v libx264 -preset ultrafast -c:a copy "${outputPath}"`;
  
  console.log(`[FFmpeg-CLI] Executing command: ${ffmpegCmd}`);
  
  try {
    const { stdout, stderr } = await execAsync(ffmpegCmd, { maxBuffer: 10 * 1024 * 1024 }); // Increased maxBuffer
    if (stdout) console.log('[FFmpeg-CLI] Stdout:', stdout.substring(0, 500));
    if (stderr) console.warn('[FFmpeg-CLI] Stderr:', stderr.substring(0, 500)); // Log stderr as warning
    console.log('[FFmpeg-CLI] ✅ Command completed successfully.');
    return { success: true };
  } catch (error) {
    console.error(`[FFmpeg-CLI] ❌ Command failed: ${error.message}`);
    console.error('[FFmpeg-CLI] Error details (stdout/stderr might be truncated):', error.stdout?.substring(0, 500), error.stderr?.substring(0, 500));
    throw new Error(`FFmpeg processing failed: ${error.message}`);
  }
}

// Main Processing Endpoint
app.post("/process", async (req, res) => {
  const { inputUrl, outputKey, style = 'cinematic' } = req.body || {};
  const requestId = Date.now().toString(36);

  console.log(`\n[${requestId}] ========== NEW REQUEST ==========`);
  console.log(`[${requestId}] Input URL: ${inputUrl?.substring(0, 80)}...`);
  console.log(`[${requestId}] Output Key: ${outputKey}`);
  console.log(`[${requestId}] Style: ${style}`);

  // Pre-check for FFmpeg and R2 readiness
  if (!isFfmpegReady) {
    return res.status(500).json({ 
      success: false, 
      error: "FFmpeg binary not found or not executable.",
      hint: "Check Railway logs for FFmpeg installation errors.",
      requestId
    });
  }
  if (!inputUrl || !outputKey) {
    return res.status(400).json({ 
      success: false, 
      error: "inputUrl and outputKey are required.",
      requestId
    });
  }
  if (!s3) {
    return res.status(500).json({ 
      success: false, 
      error: "R2 storage not configured. Check environment variables.",
      requestId
    });
  }

  let tmpInFile = null;
  let tmpOutFile = null;

  try {
    // Create temporary files (using tmp.file for robust cleanup)
    tmpInFile = tmp.fileSync({ postfix: ".mp4", keep: true }); // Keep during processing
    tmpOutFile = tmp.fileSync({ postfix: ".mp4", keep: true }); // Keep during processing
    console.log(`[${requestId}] Temp input file: ${tmpInFile.name}`);
    console.log(`[${requestId}] Temp output file: ${tmpOutFile.name}`);

    // Download input video
    console.log(`[${requestId}] Downloading video from: ${inputUrl?.substring(0, 80)}...`);
    const inputBuffer = await downloadToBuffer(inputUrl);
    await fs.writeFile(tmpInFile.name, inputBuffer);
    console.log(`[${requestId}] ✅ Input video saved to temp file.`);

    // Process video with FFmpeg CLI
    console.log(`[${requestId}] Processing video with FFmpeg...`);
    await processVideoCLI(tmpInFile.name, tmpOutFile.name, style);
    console.log(`[${requestId}] ✅ Video processed successfully.`);

    // Read processed output into buffer
    console.log(`[${requestId}] Reading processed output file...`);
    const outputBuffer = await fs.readFile(tmpOutFile.name);
    console.log(`[${requestId}] ✅ Processed output size: ${outputBuffer.length} bytes.`);

    // Upload to R2
    console.log(`[${requestId}] Uploading processed video to R2 Bucket: ${R2_BUCKET}, Key: ${outputKey}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: outputBuffer,
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000",
      })
    );
    console.log(`[${requestId}] ✅ Upload to R2 complete.`);

    // Construct CDN URL
    const cdnUrl = `${R2_PUBLIC_BASE_URL}/${outputKey}`.replace(/([^:]\/)\/+/g, "$1");
    console.log(`[${requestId}] 🎉 SUCCESS! CDN URL: ${cdnUrl}`);

    // Send success response
    res.json({
      success: true,
      cdnUrl,
      outputKey,
      message: "Video processed and uploaded successfully.",
      requestId,
      timestamp: new Date().toISOString()
    });

    // Asynchronous cleanup of temporary files
    setImmediate(async () => {
      try {
        if (tmpInFile) {
          await fs.unlink(tmpInFile.name).catch(e => console.warn(`[${requestId}] Cleanup warning (tmpInFile): ${e.message}`));
          tmpInFile.removeCallback();
        }
        if (tmpOutFile) {
          await fs.unlink(tmpOutFile.name).catch(e => console.warn(`[${requestId}] Cleanup warning (tmpOutFile): ${e.message}`));
          tmpOutFile.removeCallback();
        }
        console.log(`[${requestId}] 🧹 Cleanup of temporary files completed.`);
      } catch (cleanupError) {
        console.warn(`[${requestId}] General cleanup error: ${cleanupError.message}`);
      }
    });

  } catch (error) {
    console.error(`[${requestId}] ❌ Processing failed: ${error.message}`);
    console.error(`[${requestId}] Error stack: ${error.stack}`);
    
    // Ensure temporary files are cleaned up even on error
    setImmediate(async () => {
      try {
        if (tmpInFile) {
          await fs.unlink(tmpInFile.name).catch(e => console.warn(`[${requestId}] Cleanup on error warning (tmpInFile): ${e.message}`));
          tmpInFile.removeCallback();
        }
        if (tmpOutFile) {
          await fs.unlink(tmpOutFile.name).catch(e => console.warn(`[${requestId}] Cleanup on error warning (tmpOutFile): ${e.message}`));
          tmpOutFile.removeCallback();
        }
      } catch {}
    });

    return res.status(500).json({
      success: false,
      error: error.message || "An unknown error occurred during processing.",
      details: error.stack,
      requestId,
      timestamp: new Date().toISOString()
    });
  }
});

// Server startup logic
app.listen(PORT, '0.0.0.0', async () => {
  console.log('\n======================================================');
  console.log(`🚀 FFmpeg CLI Service v3.1 - BULLETPROOF (Docker/Nixpacks)`);
  console.log(`   Listening on Port: ${PORT}`);
  console.log(`   R2 Configured: ${s3 ? 'YES ✅' : 'NO ❌'}`);
  console.log('======================================================\n');

  // Perform FFmpeg check once on startup
  isFfmpegReady = await checkFfmpeg();
  if (!isFfmpegReady) {
    console.error("CRITICAL: FFmpeg not found or not ready. Service will likely fail.");
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
STEP 2: Use this Dockerfile OR nixpacks.toml (Choose ONE):
Option A - Dockerfile (Recommended for full control):

# Use official Node.js 18 image
FROM node:18-slim

# Install FFmpeg and dependencies
# `libavcodec-extra` is important for full codec support, though `ffmpeg` is sufficient for basics
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libavcodec-extra \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy application code
COPY . .

# Expose port
EXPOSE 8080

# Start the application
CMD ["node", "server.js"]
Option B - nixpacks.toml (if you must use Nixpacks):

# Railway build configuration with Nixpacks
providers = ["node"]

# Install FFmpeg and required libraries
[phases.setup]
aptPkgs = ["ffmpeg", "libavcodec-extra"]

# Explicitly run npm install to ensure all Node.js dependencies are fetched
[phases.build]
cmd = "npm install"

# Command to start the application
[start]
cmd = "node server.js"
