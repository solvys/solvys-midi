import Busboy from "busboy";
import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const AUDIVERIS_BIN = process.env.AUDIVERIS_BIN || "audiveris";
const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 40 * 1024 * 1024);
const TIMEOUT_MS = Number(process.env.OMR_TIMEOUT_MS || 240_000);

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function bearerAuthorized(request) {
  const token = process.env.OMR_WORKER_TOKEN?.trim();
  if (!token) {
    return true;
  }

  return request.headers.authorization === `Bearer ${token}`;
}

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(absolutePath);
    }

    return [absolutePath];
  }));

  return files.flat();
}

async function firstExportedScore(outputDir) {
  const exported = (await collectFiles(outputDir))
    .filter((entry) => /\.(mxl|musicxml|xml)$/i.test(entry))
    .sort((a, b) => {
      const aMxl = a.toLowerCase().endsWith(".mxl") ? 0 : 1;
      const bMxl = b.toLowerCase().endsWith(".mxl") ? 0 : 1;
      return aMxl - bMxl || a.localeCompare(b);
    });

  if (!exported[0]) {
    throw new Error("Audiveris finished without exporting MusicXML.");
  }

  return exported[0];
}

function runAudiveris(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      AUDIVERIS_BIN,
      ["-batch", "-transcribe", "-export", "-output", outputDir, "--", inputPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Audiveris timed out before finishing this PDF."));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Audiveris exited with code ${code}.`));
    });
  });
}

async function receivePdf(request, workDir) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: request.headers,
      limits: {
        files: 1,
        fileSize: MAX_BYTES,
      },
    });
    let filePath = "";
    let uploadStarted = false;
    let writePromise = Promise.resolve();

    busboy.on("file", (_fieldname, file, info) => {
      uploadStarted = true;
      if (!info.filename.toLowerCase().endsWith(".pdf")) {
        file.resume();
        reject(new Error("Only PDF uploads are accepted."));
        return;
      }

      filePath = path.join(workDir, `${randomUUID()}.pdf`);
      writePromise = pipeline(file, createWriteStream(filePath));
    });

    busboy.on("finish", () => {
      if (!uploadStarted || !filePath) {
        reject(new Error("No PDF file was uploaded."));
        return;
      }
      writePromise.then(() => resolve(filePath), reject);
    });
    busboy.on("error", reject);
    busboy.on("filesLimit", () => reject(new Error("Upload contains too many files.")));
    request.pipe(busboy);
  });
}

async function handleTranscribe(request, response) {
  if (!bearerAuthorized(request)) {
    sendJson(response, 401, { error: "Unauthorized OMR worker request." });
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "solvys-midi-omr-"));
  const outputDir = path.join(workDir, "out");
  await fs.mkdir(outputDir);

  try {
    const inputPath = await receivePdf(request, workDir);
    await runAudiveris(inputPath, outputDir);
    const scorePath = await firstExportedScore(outputDir);
    const scoreBytes = await fs.readFile(scorePath);
    const isMxl = scorePath.toLowerCase().endsWith(".mxl");

    sendJson(response, 200, isMxl
      ? { mxlBase64: scoreBytes.toString("base64") }
      : { musicXml: scoreBytes.toString("utf8") });
  } catch (error) {
    sendJson(response, 422, { error: error instanceof Error ? error.message : "OMR failed." });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, engine: "Audiveris" });
    return;
  }

  if (request.method === "POST" && request.url === "/transcribe") {
    handleTranscribe(request, response);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
});

server.listen(PORT, () => {
  console.log(`SolvysMIDI OMR worker listening on ${PORT}`);
});
