// server.js - Final Bulletproof Version

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import tmp from "tmp"; // Robust temporary file creation
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 8080; // Railway automatically sets PORT

// --- Railway Environment Variables (MUST BE SET IN RAILWAY) ---
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
// This handles the TLS warning you saw.
// IMPORTANT: Ensure NODE_TLS_REJECT_UNAUTHORIZED=0 is set in Railway Variables
const NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

// --- Express Middleware ---
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json({ limit: '50mb' })); // Parse JSON bodies with a larger limit

// --- Initialize S3 Client for Cloudflare R2 ---
let s3 = null;
if (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  s3 = new S3Client({
    region: "auto", // Cloudflare R2 uses "auto" region
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    // Dynamically set rejectUnauthorized based on env variable
    tls: { rejectUnauthorized: NODE_TLS_REJECT_UNAUTHORIZED !== '0' }
  });
  console.log('[R2] ✅ Client configured successfully.');
} else {
  console.error('[R2] ❌ CRITICAL: Missing R2 credentials. Uploads will fail!');
  console.error('[R2] Ensure R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are set.');
}

// --- FFmpeg Binary Check ---
// We try to find FFmpeg on startup and store its path.
let ffmpegPath = 'ffmpeg'; // Default, assuming it's in PATH
let isFfmpegReady = false; // Flag to track FFmpeg readiness

async function checkFfmpegInstallation() {
  try {
    const { stdout: whichOutput } = await execAsync('which ffmpeg');
    ffmpegPath = whichOutput.trim(); // Get full path
    const { stdout: versionOutput } = await execAsync(`${ffmpegPath} -version`);
    console.log(`[FFmpeg] ✅ Found at: ${ffmpegPath}`);
    console.log(`[FFmpeg] Version: ${versionOutput.split('\n')[0]}`);
    return true;
  } catch (error) {
    console.error(`[FFmpeg] ❌ Not found or not executable: ${error.message}`);
    console.error('[FFmpeg] Please ensure FFmpeg is installed and in the system PATH.');
    return false;
  }
}

// --- Health Check Endpoint ---
// Provides status of the service, R2, and FFmpeg
app.get("/health", async (req, res) => {
  // Check FFmpeg status if not already checked on startup
  if (!isFfmpegReady) {
    isFfmpegReady = await checkFfmpegInstallation();
  }

  res.json({
    ok: true,
    service: "ffmpeg-cli-processor",
    version: "3.2-final", // Updated version
    timestamp: new Date().toISOString(),
    r2Configured: !!s3,
    ffmpegReady: isFfmpegReady,
    env_tls_reject_unauthorized: NODE_TLS_REJECT_UNAUTHORIZED,
    ffmpeg_path_used: ffmpegPath
  });
});

// --- Helper: Download video to buffer ---
async function downloadToBuffer(url) {
  console.log(`[Download] Starting download from: ${url.substring(0, 80)}...`);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60000) // 60 seconds timeout for download
  });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[Download] ✅ Download complete: ${buffer.length} bytes.`);
  return buffer;
}

// --- Helper: Process video with FFmpeg CLI ---
async function processVideoCLI(inputPath, outputPath, style = 'cinematic') {
  console.log(`[FFmpeg-CLI] Starting processing for style: ${style}`);
  
  // Define FFmpeg filter graphs based on style
  const filters = {
    cinematic: 'eq=contrast=1.2:brightness=0.1:saturation=1.1',
    vibrant: 'eq=contrast=1.3:saturation=1.5',
    vintage: 'curves=vintage,vignette',
    bw: 'hue=s=0',
    default: 'scale=1920:1080' // Fallback filter
  };
  
  const filter = filters[style] || filters.default;
  
  // Construct the full FFmpeg command
  const ffmpegCmd = `${ffmpegPath} -i "${inputPath}" -vf "${filter}" -c:v libx264 -preset ultrafast -c:a copy "${outputPath}" -y`; // -y to overwrite output
  
  console.log(`[FFmpeg-CLI] Executing command: ${ffmpegCmd}`);
  
  try {
    const { stdout, stderr } = await execAsync(ffmpegCmd, { maxBuffer: 20 * 1024 * 1024, timeout: 180000 }); // 3 min timeout, increased buffer
    if (stdout) console.log('[FFmpeg-CLI] Stdout:', stdout.substring(0, 500) + (stdout.length > 500 ? '...' : ''));
    if (stderr) console.warn('[FFmpeg-CLI] Stderr:', stderr.substring(0, 500) + (stderr.length > 500 ? '...' : ''));
    console.log('[FFmpeg-CLI] ✅ Command completed successfully.');
    return { success: true };
  } catch (error) {
    console.error(`[FFmpeg-CLI] ❌ Command failed: ${error.message}`);
    // Log full error stdout/stderr for detailed debugging
    if (error.stdout) console.error('[FFmpeg-CLI] Error Stdout:', error.stdout);
    if (error.stderr) console.error('[FFmpeg-CLI] Error Stderr:', error.stderr);
    throw new Error(`FFmpeg processing failed: ${error.message}`);
  }
}

// --- Main Video Processing Endpoint ---
app.post("/process", async (req, res) => {
  const { inputUrl, outputKey, style = 'cinematic' } = req.body || {};
  const requestId = Date.now().toString(36); // Unique ID for each request

  console.log(`\n[${requestId}] ========== NEW REQUEST ==========`);
  console.log(`[${requestId}] Input URL: ${inputUrl?.substring(0, 80)}...`);
  console.log(`[${requestId}] Output Key: ${outputKey}`);
  console.log(`[${requestId}] Style: ${style}`);

  // --- Pre-flight checks ---
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
    // --- Step 1: Create temporary files ---
    // `tmp.fileSync` creates a unique file path that is automatically removed on process exit.
    tmpInFile = tmp.fileSync({ postfix: ".mp4" });
    tmpOutFile = tmp.fileSync({ postfix: ".mp4" });
    console.log(`[${requestId}] Temp input file path: ${tmpInFile.name}`);
    console.log(`[${requestId}] Temp output file path: ${tmpOutFile.name}`);

    // --- Step 2: Download input video ---
    const inputBuffer = await downloadToBuffer(inputUrl);
    await fs.writeFile(tmpInFile.name, inputBuffer);
    console.log(`[${requestId}] ✅ Input video saved to temp file: ${tmpInFile.name}`);

    // --- Step 3: Process video with FFmpeg CLI ---
    await processVideoCLI(tmpInFile.name, tmpOutFile.name, style);
    console.log(`[${requestId}] ✅ Video processed successfully to temp file: ${tmpOutFile.name}`);

    // --- Step 4: Read processed output into buffer ---
    const outputBuffer = await fs.readFile(tmpOutFile.name);
    console.log(`[${requestId}] ✅ Processed output size: ${outputBuffer.length} bytes.`);

    // --- Step 5: Upload to R2 ---
    console.log(`[${requestId}] Uploading processed video to R2 Bucket: ${R2_BUCKET}, Key: ${outputKey}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: outputBuffer, // Send as Buffer (not stream) for robustness
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000", // Cache for 1 year
      })
    );
    console.log(`[${requestId}] ✅ Upload to R2 complete.`);

    // --- Step 6: Construct CDN URL and send response ---
    const cdnUrl = `${R2_PUBLIC_BASE_URL}/${outputKey}`.replace(/([^:]\/)\/+/g, "$1");
    console.log(`[${requestId}] 🎉 SUCCESS! CDN URL: ${cdnUrl}`);

    res.json({
      success: true,
      cdnUrl,
      outputKey,
      message: "Video processed and uploaded successfully.",
      requestId,
      timestamp: new Date().toISOString()
    });

    // --- Step 7: Asynchronous cleanup of temporary files ---
    // Ensures response is sent quickly, then cleans up.
    setImmediate(async () => {
      try {
        if (tmpInFile) {
          tmpInFile.removeCallback(); // Use tmp's built-in cleanup
        }
        if (tmpOutFile) {
          tmpOutFile.removeCallback(); // Use tmp's built-in cleanup
        }
        console.log(`[${requestId}] 🧹 Cleanup of temporary files completed.`);
      } catch (cleanupError) {
        console.warn(`[${requestId}] Warning during cleanup: ${cleanupError.message}`);
      }
    });

  } catch (error) {
    console.error(`[${requestId}] ❌ Processing failed: ${error.message}`);
    console.error(`[${requestId}] Error stack:`, error.stack);
    
    // --- Cleanup on error ---
    setImmediate(async () => {
      try {
        if (tmpInFile) {
          tmpInFile.removeCallback();
        }
        if (tmpOutFile) {
          tmpOutFile.removeCallback();
        }
      } catch (cleanupError) {
        console.warn(`[${requestId}] Warning during error cleanup: ${cleanupError.message}`);
      }
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

// --- Server Startup Logic ---
app.listen(PORT, '0.0.0.0', async () => {
  console.log('\n======================================================');
  console.log(`🚀 FFmpeg CLI Service v3.2 - FINAL BULLETPROOF`);
  console.log(`   Listening on Port: ${PORT}`);
  console.log(`   R2 Configured: ${s3 ? 'YES ✅' : 'NO ❌'}`);
  console.log('======================================================\n');

  // Perform FFmpeg check once on startup, important for `isFfmpegReady` flag
  isFfmpegReady = await checkFfmpegInstallation();
  if (!isFfmpegReady) {
    console.error("CRITICAL: FFmpeg not found or not ready. Service will likely fail.");
  }
});

// --- Graceful Shutdown ---
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
