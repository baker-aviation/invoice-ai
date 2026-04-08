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
  | "audio"
  | "uploading"
  | "transcribing"
  | "done"
  | "error";

type Mode = "full" | "audio-only";

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
const SERVER_SIDE_THRESHOLD = 500 * 1024 * 1024; // 500MB — above this, go server-side

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

export default function VideoTranscribe() {
  const [step, setStep] = useState<Step>("idle");
  const [mode, setMode] = useState<Mode>("full");
  const [statusMsg, setStatusMsg] = useState("");
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [selectedImg, setSelectedImg] = useState<Screenshot | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  const reset = () => {
    setStep("idle");
    setStatusMsg("");
    setScreenshots([]);
    setTranscript("");
    setError("");
    setProgress(0);
    setSelectedImg(null);
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

  // ── Transcode HEVC → H.264 via FFmpeg.wasm (client-side, < 500MB) ───────

  const transcodeToH264 = useCallback(async (file: File): Promise<File> => {
    if (!ffmpegRef.current) {
      const ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress: p }) => {
        setProgress(Math.round(p * 100));
      });

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

  // ── Screenshot extraction via video+canvas ────────────────────────────────

  const extractScreenshots = useCallback(
    (file: File, interval: number = 3): Promise<Screenshot[]> => {
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
          canvas.height = Math.round(
            (canvas.width / video.videoWidth) * video.videoHeight,
          );
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

  // ── Audio extraction via AudioContext (client-side) ────────────────────────

  const extractAudioClientSide = useCallback(
    async (file: File): Promise<AudioBuffer> => {
      setStatusMsg("Reading video file...");
      const arrayBuffer = await file.arrayBuffer();

      setStatusMsg("Decoding audio (this may take a moment for large files)...");
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      await audioCtx.close();

      return audioBuffer;
    },
    [],
  );

  // ── Upload chunks to GCS ──────────────────────────────────────────────────

  const uploadChunksToGcs = useCallback(
    async (chunks: Blob[]): Promise<string[]> => {
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
    },
    [],
  );

  // ── Upload raw video to GCS + server-side audio extraction ────────────────

  const extractAudioServerSide = useCallback(async (file: File): Promise<string[]> => {
    // Upload raw video to GCS
    setStep("uploading-video");
    setStatusMsg(`Uploading video (${(file.size / 1024 / 1024).toFixed(0)}MB)...`);
    setProgress(0);

    const ext = file.name.split(".").pop() || "mov";
    const presignRes = await fetch(
      `/api/admin/transcribe?action=presign&filename=video.${ext}`,
    );
    if (!presignRes.ok) throw new Error("Failed to get upload URL for video");
    const { url, key, contentType } = await presignRes.json();

    // Upload with progress via XMLHttpRequest
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

  // ── Transcribe audio chunks via Whisper ───────────────────────────────────

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

  // ── Main processing flow ──────────────────────────────────────────────────

  const processVideo = useCallback(
    async (file: File) => {
      try {
        setStep("loading");
        setError("");
        setScreenshots([]);
        setTranscript("");

        const isLarge = file.size > SERVER_SIDE_THRESHOLD;
        const playable = await canPlayNatively(file);
        const needsTranscode = !playable;

        // ── FULL MODE ────────────────────────────────────────────────────
        if (mode === "full") {
          let videoFile = file;

          if (needsTranscode && isLarge) {
            // Too big for client-side transcode — do audio-only server-side + warn
            setStatusMsg("Video too large for browser transcoding — extracting audio server-side (no screenshots for large HEVC files)...");
            const gcsKeys = await extractAudioServerSide(file);
            const text = await transcribeChunks(gcsKeys);
            setTranscript(text);
            setStep("done");
            setStatusMsg(`Done! Transcript from ${gcsKeys.length} audio chunk(s). (Screenshots skipped — file too large for browser transcode)`);
            return;
          }

          if (needsTranscode) {
            setStep("transcoding");
            setProgress(0);
            videoFile = await transcodeToH264(file);
          }

          // Extract screenshots
          setStep("screenshots");
          setStatusMsg("Extracting screenshots every 3 seconds...");
          setProgress(0);
          const frames = await extractScreenshots(videoFile, 3);
          setScreenshots(frames);

          // Client-side audio extraction
          setStep("audio");
          setProgress(0);
          const audioBuffer = await extractAudioClientSide(videoFile);
          setStatusMsg(
            `Audio decoded: ${Math.round(audioBuffer.duration)}s at ${audioBuffer.sampleRate}Hz`,
          );

          const chunks = splitAudioBuffer(audioBuffer);
          setStatusMsg(
            `Audio split into ${chunks.length} chunk(s) (${chunks.map((c) => (c.size / 1024 / 1024).toFixed(1) + "MB").join(", ")})`,
          );

          setStep("uploading");
          const gcsKeys = await uploadChunksToGcs(chunks);
          const text = await transcribeChunks(gcsKeys);
          setTranscript(text);
          setStep("done");
          setStatusMsg(`Done! ${frames.length} screenshots, ${gcsKeys.length} audio chunk(s) transcribed.`);
          return;
        }

        // ── AUDIO ONLY MODE ──────────────────────────────────────────────
        if (isLarge || needsTranscode) {
          // Server-side for large files or unplayable codecs
          const gcsKeys = await extractAudioServerSide(file);
          const text = await transcribeChunks(gcsKeys);
          setTranscript(text);
          setStep("done");
          setStatusMsg(`Done! ${gcsKeys.length} audio chunk(s) transcribed.`);
          return;
        }

        // Small playable file — client-side audio extraction
        setStep("audio");
        setProgress(0);
        const audioBuffer = await extractAudioClientSide(file);
        setStatusMsg(
          `Audio decoded: ${Math.round(audioBuffer.duration)}s at ${audioBuffer.sampleRate}Hz`,
        );

        const chunks = splitAudioBuffer(audioBuffer);
        setStep("uploading");
        const gcsKeys = await uploadChunksToGcs(chunks);
        const text = await transcribeChunks(gcsKeys);
        setTranscript(text);
        setStep("done");
        setStatusMsg(`Done! ${gcsKeys.length} audio chunk(s) transcribed.`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Something went wrong";
        console.error("Video processing error:", e);
        setError(msg);
        setStep("error");
      }
    },
    [
      mode,
      canPlayNatively,
      transcodeToH264,
      extractScreenshots,
      extractAudioClientSide,
      uploadChunksToGcs,
      extractAudioServerSide,
      transcribeChunks,
    ],
  );

  // ── Drop / file handlers ──────────────────────────────────────────────────

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

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  // ── Format helpers ────────────────────────────────────────────────────────

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const isProcessing = [
    "loading", "transcoding", "uploading-video", "extracting-server",
    "screenshots", "audio", "uploading", "transcribing",
  ].includes(step);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="px-6 space-y-6">
      {/* Mode toggle */}
      {(step === "idle" || step === "error") && (
        <div className="flex gap-2">
          <button
            onClick={() => setMode("full")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === "full"
                ? "bg-blue-600 text-white"
                : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
            }`}
          >
            Screenshots + Transcript
          </button>
          <button
            onClick={() => setMode("audio-only")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === "audio-only"
                ? "bg-blue-600 text-white"
                : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
            }`}
          >
            Transcript Only
          </button>
        </div>
      )}

      {/* Drop zone */}
      {step === "idle" || step === "error" ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
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
            onChange={handleFileInput}
            className="hidden"
          />
          <div className="text-4xl mb-3">🎬</div>
          <p className="text-lg font-medium text-zinc-200">
            Drop a video here or click to browse
          </p>
          <p className="text-sm text-zinc-400 mt-1">
            {mode === "full"
              ? "Supports .mov, .mp4, .webm — extracts screenshots every 3s + full transcription"
              : "Supports .mov, .mp4, .webm — extracts and transcribes audio only"}
          </p>
          <p className="text-xs text-zinc-500 mt-1">
            Large files (&gt;500MB) and HEVC screen recordings are processed server-side
          </p>
        </div>
      ) : null}

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-700 p-4 text-red-300">
          <p className="font-medium">Error</p>
          <p className="text-sm mt-1">{error}</p>
          <button
            onClick={reset}
            className="mt-3 text-sm text-red-400 hover:text-red-200 underline"
          >
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
              {step === "transcoding" && "Transcoding video (HEVC → H.264)..."}
              {step === "uploading-video" && "Uploading video to server..."}
              {step === "extracting-server" && "Server extracting audio (FFmpeg)..."}
              {step === "screenshots" && "Extracting screenshots..."}
              {step === "audio" && "Extracting audio..."}
              {step === "uploading" && "Uploading audio..."}
              {step === "transcribing" && "Transcribing..."}
              {step === "loading" && "Preparing..."}
            </span>
          </div>
          <p className="text-xs text-zinc-400 mb-2">{statusMsg}</p>
          {progress > 0 && (
            <div className="w-full bg-zinc-700 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Done status */}
      {step === "done" && (
        <div className="rounded-lg bg-emerald-900/30 border border-emerald-700 p-4 flex items-center justify-between">
          <p className="text-emerald-300 text-sm">{statusMsg}</p>
          <button
            onClick={reset}
            className="text-sm text-emerald-400 hover:text-emerald-200 underline"
          >
            Process another video
          </button>
        </div>
      )}

      {/* Screenshots gallery */}
      {screenshots.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">
            Screenshots ({screenshots.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {screenshots.map((s) => (
              <button
                key={s.time}
                onClick={() => setSelectedImg(s)}
                className="relative group rounded-lg overflow-hidden border border-zinc-700 hover:border-zinc-500 transition-colors"
              >
                <img
                  src={s.dataUrl}
                  alt={`Frame at ${formatTime(s.time)}`}
                  className="w-full aspect-video object-cover"
                />
                <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-xs text-zinc-300 text-center py-0.5">
                  {formatTime(s.time)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lightbox */}
      {selectedImg && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setSelectedImg(null)}
        >
          <div className="relative max-w-5xl w-full" onClick={(e) => e.stopPropagation()}>
            <img
              src={selectedImg.dataUrl}
              alt={`Frame at ${formatTime(selectedImg.time)}`}
              className="w-full rounded-lg"
            />
            <div className="absolute top-2 right-2 flex gap-2">
              <span className="bg-black/70 text-white text-sm px-3 py-1 rounded-full">
                {formatTime(selectedImg.time)}
              </span>
              <button
                onClick={() => setSelectedImg(null)}
                className="bg-black/70 text-white text-sm px-3 py-1 rounded-full hover:bg-black"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transcript */}
      {transcript && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-300">Transcript</h3>
            <button
              onClick={() => navigator.clipboard.writeText(transcript)}
              className="text-xs text-blue-400 hover:text-blue-300 underline"
            >
              Copy to clipboard
            </button>
          </div>
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 max-h-96 overflow-y-auto">
            <p className="text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">
              {transcript}
            </p>
          </div>
        </div>
      )}

      {/* Hidden video element for potential future use */}
      <video ref={videoRef} className="hidden" />
    </div>
  );
}
