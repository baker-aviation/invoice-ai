"use client";

import { useState, useRef, useCallback } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

// ─── Types ──────────────────────────────────────────────────────────────────

type Step =
  | "idle"
  | "loading"
  | "transcoding"
  | "uploading-video"
  | "extracting-server"
  | "screenshots"
  | "uploading-screenshots"
  | "audio"
  | "uploading"
  | "transcribing"
  | "done"
  | "error";

type Screenshot = {
  time: number;
  dataUrl: string;
};

// ─── WAV Encoder ────────────────────────────────────────────────────────────

function encodeWavChunk(
  audioBuffer: AudioBuffer,
  startSample: number,
  endSample: number,
): Blob {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const samples = endSample - startSample;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples * 2, true);

  const channelData = audioBuffer.getChannelData(0);
  let offset = 44;
  for (let i = startSample; i < endSample; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const SERVER_SIDE_THRESHOLD = 500 * 1024 * 1024;
const SCREENSHOT_INTERVAL = 5; // seconds

function splitAudioBuffer(audioBuffer: AudioBuffer): Blob[] {
  const totalSamples = audioBuffer.length;
  const bytesPerSample = 2;
  const maxSamplesPerChunk = Math.floor((MAX_CHUNK_BYTES - 44) / bytesPerSample);

  const chunks: Blob[] = [];
  let start = 0;
  while (start < totalSamples) {
    const end = Math.min(start + maxSamplesPerChunk, totalSamples);
    chunks.push(encodeWavChunk(audioBuffer, start, end));
    start = end;
  }
  return chunks;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function MeetingUpload({ onComplete }: { onComplete: (meetingId: number) => void }) {
  const [step, setStep] = useState<Step>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [title, setTitle] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  const reset = () => {
    setStep("idle");
    setStatusMsg("");
    setError("");
    setProgress(0);
  };

  // ── Check if browser can play the video natively ─────────────────────────

  const canPlayNatively = useCallback((file: File): Promise<boolean> => {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      video.preload = "auto";
      video.muted = true;
      const cleanup = () => URL.revokeObjectURL(url);
      video.onloadedmetadata = () => { cleanup(); resolve(true); };
      video.onerror = () => { cleanup(); resolve(false); };
      video.src = url;
    });
  }, []);

  // ── Get video duration ───────────────────────────────────────────────────

  const getVideoDuration = useCallback((file: File): Promise<number> => {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(Math.round(video.duration));
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };
      video.src = url;
    });
  }, []);

  // ── Transcode HEVC -> H.264 ──────────────────────────────────────────────

  const transcodeToH264 = useCallback(async (file: File): Promise<File> => {
    if (!ffmpegRef.current) {
      const ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress: p }) => setProgress(Math.round(p * 100)));

      setStatusMsg("Loading FFmpeg (first time may take a moment)...");
      const baseURL = "/ffmpeg";
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      ffmpegRef.current = ffmpeg;
    }

    const ffmpeg = ffmpegRef.current;
    const ext = file.name.split(".").pop() || "mov";
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";

    setStatusMsg("Transcoding video to H.264...");
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    await ffmpeg.exec([
      "-i", inputName,
      "-c:v", "libx264", "-preset", "fast", "-crf", "23",
      "-c:a", "aac", "-movflags", "+faststart",
      outputName,
    ]);

    const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);

    const blob = new Blob([new Uint8Array(data.buffer as ArrayBuffer)], { type: "video/mp4" });
    return new File([blob], file.name.replace(/\.\w+$/, ".mp4"), { type: "video/mp4" });
  }, []);

  // ── Screenshot extraction ────────────────────────────────────────────────

  const extractScreenshots = useCallback(
    (file: File, interval: number = SCREENSHOT_INTERVAL): Promise<Screenshot[]> => {
      return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;

        const url = URL.createObjectURL(file);
        video.src = url;

        const frames: Screenshot[] = [];
        let currentTime = 0;

        video.onloadedmetadata = () => {
          const duration = video.duration;
          const totalFrames = Math.ceil(duration / interval);

          const canvas = document.createElement("canvas");
          canvas.width = Math.min(video.videoWidth, 1280);
          canvas.height = Math.round((canvas.width / video.videoWidth) * video.videoHeight);
          const ctx = canvas.getContext("2d")!;

          const captureFrame = () => {
            if (currentTime > duration) {
              URL.revokeObjectURL(url);
              resolve(frames);
              return;
            }
            video.currentTime = currentTime;
          };

          video.onseeked = () => {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frames.push({
              time: currentTime,
              dataUrl: canvas.toDataURL("image/jpeg", 0.85),
            });
            setProgress(Math.round((frames.length / totalFrames) * 100));
            currentTime += interval;
            captureFrame();
          };

          captureFrame();
        };

        video.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("Failed to load video"));
        };
      });
    },
    [],
  );

  // ── Audio extraction via AudioContext ─────────────────────────────────────

  const extractAudioClientSide = useCallback(async (file: File): Promise<AudioBuffer> => {
    setStatusMsg("Reading video file...");
    const arrayBuffer = await file.arrayBuffer();
    setStatusMsg("Decoding audio (this may take a moment for large files)...");
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();
    return audioBuffer;
  }, []);

  // ── Upload audio chunks to GCS (via transcribe presign) ──────────────────

  const uploadAudioChunksToGcs = useCallback(async (chunks: Blob[]): Promise<string[]> => {
    const keys: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      setStatusMsg(`Uploading audio chunk ${i + 1}/${chunks.length}...`);
      setProgress(Math.round(((i + 1) / chunks.length) * 100));

      const presignRes = await fetch(
        `/api/admin/transcribe?action=presign&filename=chunk_${String(i).padStart(3, "0")}.wav`,
      );
      if (!presignRes.ok) throw new Error("Failed to get upload URL");
      const { url, key, contentType } = await presignRes.json();

      const uploadRes = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: chunks[i],
      });
      if (!uploadRes.ok) throw new Error(`Failed to upload chunk ${i + 1}`);
      keys.push(key);
    }
    return keys;
  }, []);

  // ── Server-side audio extraction ─────────────────────────────────────────

  const extractAudioServerSide = useCallback(async (file: File, meetingId: number): Promise<string[]> => {
    setStep("uploading-video");
    setStatusMsg(`Uploading video (${(file.size / 1024 / 1024).toFixed(0)}MB)...`);
    setProgress(0);

    const ext = file.name.split(".").pop() || "mov";
    const presignRes = await fetch(
      `/api/admin/meetings?action=presign&meeting_id=${meetingId}&filename=video.${ext}`,
    );
    if (!presignRes.ok) throw new Error("Failed to get upload URL for video");
    const { url, key, contentType } = await presignRes.json();

    // Upload with progress
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.send(file);
    });

    // Save video GCS key to meeting
    await fetch("/api/admin/meetings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: meetingId, video_gcs_key: key }),
    });

    // Server-side FFmpeg extraction
    setStep("extracting-server");
    setStatusMsg("Server is extracting audio with FFmpeg...");
    setProgress(0);

    const res = await fetch("/api/admin/extract-audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gcsKey: key }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server extraction failed (${res.status})`);
    }

    const { gcsKeys } = await res.json();
    return gcsKeys;
  }, []);

  // ── Upload screenshots to GCS ────────────────────────────────────────────

  const uploadScreenshots = useCallback(
    async (meetingId: number, frames: Screenshot[]): Promise<void> => {
      setStep("uploading-screenshots");
      setStatusMsg(`Uploading ${frames.length} screenshots...`);
      setProgress(0);

      // Get batch presigned URLs
      const presignRes = await fetch(
        `/api/admin/meetings?action=presign-screenshots&meeting_id=${meetingId}&count=${frames.length}`,
      );
      if (!presignRes.ok) throw new Error("Failed to get screenshot upload URLs");
      const { uploads } = await presignRes.json();

      const screenshotRecords: { gcs_key: string; time_sec: number }[] = [];

      // Upload each screenshot
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const upload = uploads[i];

        // Convert dataUrl to blob (without fetch — avoids CSP connect-src issues)
        const [header, b64] = frame.dataUrl.split(",");
        const mime = header.match(/:(.*?);/)?.[1] || "image/jpeg";
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
        const blob = new Blob([bytes], { type: mime });

        const uploadRes = await fetch(upload.url, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        });

        if (!uploadRes.ok) {
          console.warn(`Failed to upload screenshot ${i}`);
          continue;
        }

        screenshotRecords.push({ gcs_key: upload.key, time_sec: frame.time });
        setProgress(Math.round(((i + 1) / frames.length) * 100));
      }

      // Bulk insert screenshot records
      if (screenshotRecords.length > 0) {
        await fetch(`/api/admin/meetings/${meetingId}/screenshots`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ screenshots: screenshotRecords }),
        });
      }
    },
    [],
  );

  // ── Transcribe audio chunks via Whisper ──────────────────────────────────

  const transcribeChunks = useCallback(async (gcsKeys: string[]): Promise<string> => {
    setStep("transcribing");
    setStatusMsg("Transcribing with Whisper...");
    setProgress(0);

    const res = await fetch("/api/admin/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gcsKeys }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Transcription failed (${res.status})`);
    }

    const data = await res.json();
    return data.transcript;
  }, []);

  // ── Main processing flow ─────────────────────────────────────────────────

  const processVideo = useCallback(
    async (file: File) => {
      try {
        setStep("loading");
        setError("");
        setStatusMsg("Preparing...");

        const duration = await getVideoDuration(file);
        const isLarge = file.size > SERVER_SIDE_THRESHOLD;
        const playable = await canPlayNatively(file);
        const needsTranscode = !playable;

        // 1. Create meeting record
        const meetingTitle = title.trim() || file.name.replace(/\.\w+$/, "");
        const createRes = await fetch("/api/admin/meetings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: meetingTitle, duration_sec: duration }),
        });
        if (!createRes.ok) throw new Error("Failed to create meeting record");
        const { meeting } = await createRes.json();
        const meetingId = meeting.id;

        let videoFile = file;

        // 2. Handle large HEVC files: server-side audio, no screenshots
        if (needsTranscode && isLarge) {
          setStatusMsg("Video too large for browser — extracting audio server-side...");
          const gcsKeys = await extractAudioServerSide(file, meetingId);
          const transcript = await transcribeChunks(gcsKeys);

          await fetch("/api/admin/meetings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: meetingId, transcript, status: "transcribed" }),
          });

          setStep("done");
          setStatusMsg("Done! (Screenshots skipped — file too large for browser transcode)");
          onComplete(meetingId);
          return;
        }

        // 3. Transcode if needed
        if (needsTranscode) {
          setStep("transcoding");
          setProgress(0);
          videoFile = await transcodeToH264(file);
        }

        // 4. Extract screenshots
        setStep("screenshots");
        setStatusMsg(`Extracting screenshots every ${SCREENSHOT_INTERVAL} seconds...`);
        setProgress(0);
        const frames = await extractScreenshots(videoFile, SCREENSHOT_INTERVAL);

        // 5. Upload video to GCS
        setStep("uploading-video");
        setStatusMsg("Uploading video...");
        setProgress(0);

        const ext = videoFile.name.split(".").pop() || "mp4";
        const presignRes = await fetch(
          `/api/admin/meetings?action=presign&meeting_id=${meetingId}&filename=video.${ext}`,
        );
        if (!presignRes.ok) throw new Error("Failed to get video upload URL");
        const { url: videoUrl, key: videoKey, contentType: videoCt } = await presignRes.json();

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Upload failed")));
          xhr.onerror = () => reject(new Error("Upload failed"));
          xhr.open("PUT", videoUrl);
          xhr.setRequestHeader("Content-Type", videoCt);
          xhr.send(videoFile);
        });

        // Save video key
        await fetch("/api/admin/meetings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: meetingId, video_gcs_key: videoKey }),
        });

        // 6. Upload screenshots
        await uploadScreenshots(meetingId, frames);

        // 7. Extract and upload audio
        setStep("audio");
        setProgress(0);
        const audioBuffer = await extractAudioClientSide(videoFile);
        setStatusMsg(`Audio decoded: ${Math.round(audioBuffer.duration)}s at ${audioBuffer.sampleRate}Hz`);

        const chunks = splitAudioBuffer(audioBuffer);
        setStep("uploading");
        const gcsKeys = await uploadAudioChunksToGcs(chunks);

        // 8. Transcribe
        const transcript = await transcribeChunks(gcsKeys);

        // 9. Save transcript
        await fetch("/api/admin/meetings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: meetingId, transcript, status: "transcribed" }),
        });

        setStep("done");
        setStatusMsg(`Done! ${frames.length} screenshots, ${gcsKeys.length} audio chunk(s) transcribed.`);
        onComplete(meetingId);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Something went wrong";
        console.error("Meeting processing error:", e);
        setError(`${msg} (step: ${step})`);
        setStep("error");
      }
    },
    [
      title,
      onComplete,
      canPlayNatively,
      getVideoDuration,
      transcodeToH264,
      extractScreenshots,
      extractAudioClientSide,
      uploadAudioChunksToGcs,
      uploadScreenshots,
      extractAudioServerSide,
      transcribeChunks,
    ],
  );

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleFile = (file: File) => {
    if (!file.type.startsWith("video/")) {
      setError("Please drop a video file (.mov, .mp4, .webm)");
      setStep("error");
      return;
    }
    processVideo(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const isProcessing = step !== "idle" && step !== "done" && step !== "error";

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-100">New Meeting Recording</h2>

      {/* Title input */}
      {(step === "idle" || step === "error") && (
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Meeting Title (optional)</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Weekly Standup, Feature Review..."
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 text-sm placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
          />
        </div>
      )}

      {/* Drop zone */}
      {(step === "idle" || step === "error") && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
            dragOver
              ? "border-blue-500 bg-blue-500/10"
              : "border-zinc-600 hover:border-zinc-400 bg-zinc-800/50"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            className="hidden"
          />
          <div className="text-4xl mb-3">🎬</div>
          <p className="text-lg font-medium text-zinc-200">Drop a video here or click to browse</p>
          <p className="text-sm text-zinc-400 mt-1">
            Supports .mov, .mp4, .webm — extracts screenshots every {SCREENSHOT_INTERVAL}s + full transcription
          </p>
          <p className="text-xs text-zinc-500 mt-1">
            Large files (&gt;500MB) and HEVC screen recordings are processed server-side
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-700 p-4 text-red-300">
          <p className="font-medium">Error</p>
          <p className="text-sm mt-1">{error}</p>
          <button onClick={reset} className="mt-3 text-sm text-red-400 hover:text-red-200 underline">
            Try again
          </button>
        </div>
      )}

      {/* Progress */}
      {isProcessing && (
        <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="animate-spin w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full" />
            <span className="text-sm font-medium text-zinc-200">
              {step === "transcoding" && "Transcoding video (HEVC -> H.264)..."}
              {step === "uploading-video" && "Uploading video..."}
              {step === "extracting-server" && "Server extracting audio (FFmpeg)..."}
              {step === "screenshots" && "Extracting screenshots..."}
              {step === "uploading-screenshots" && "Uploading screenshots..."}
              {step === "audio" && "Extracting audio..."}
              {step === "uploading" && "Uploading audio..."}
              {step === "transcribing" && "Transcribing with Whisper..."}
              {step === "loading" && "Preparing..."}
            </span>
          </div>
          <p className="text-xs text-zinc-400 mb-2">{statusMsg}</p>
          {progress > 0 && (
            <div className="w-full bg-zinc-700 rounded-full h-2">
              <div className="bg-blue-500 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      )}

      {/* Done */}
      {step === "done" && (
        <div className="rounded-lg bg-emerald-900/30 border border-emerald-700 p-4">
          <p className="text-emerald-300 text-sm">{statusMsg}</p>
          <p className="text-emerald-400 text-xs mt-2">Redirecting to meeting detail...</p>
        </div>
      )}
    </div>
  );
}
