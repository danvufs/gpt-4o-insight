"use client";

import { useId, useEffect, useRef, useState } from "react";
import { useChat } from "ai/react";
import useSilenceAwareRecorder from "silence-aware-recorder/react";
import useMediaRecorder from "@wmik/use-media-recorder";
import mergeImages from "merge-images";
import { useLocalStorage } from "../lib/use-local-storage";

const INTERVAL = 250;
const IMAGE_WIDTH = 512;
const IMAGE_QUALITY = 0.6;
const COLUMNS = 4;
const MAX_SCREENSHOTS = 60;
const SILENCE_DURATION = 2500;
const SILENT_THRESHOLD = -30;

const transparentPixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/wcAAwAB/2lXzAAAACV0RVh0ZGF0ZTpjcmVhdGU9MjAyMy0xMC0xOFQxNTo0MDozMCswMDowMEfahTAAAAAldEVYdGRhdGU6bW9kaWZ5PTIwMjMtMTAtMThUMTU6NDA6MzArMDA6MDBa8cKfAAAAAElFTkSuQmCC";

function playAudio(url) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    audio.onended = resolve;
    audio.play();
  });
}

async function getImageDimensions(src) {
  return new Promise((resolve, reject) => {
    const img = new globalThis.Image();
    img.onload = function () {
      resolve({ width: this.width, height: this.height });
    };
    img.onerror = function () {
      reject(new Error("Failed to load image."));
    };
    img.src = src;
  });
}

function base64ToBlob(base64, mimeType) {
  const byteCharacters = atob(base64.split(",")[1]);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

async function uploadImageToTmpFiles(base64Image) {
  const blob = base64ToBlob(base64Image, "image/jpeg");
  const formData = new FormData();
  formData.append("file", blob, "image.jpg");

  try {
    const response = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.data.url.replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/");
  } catch (error) {
    console.error("Error uploading image:", error);
    throw error;
  }
}

async function imagesGrid({
  base64Images,
  columns = COLUMNS,
  gridImageWidth = IMAGE_WIDTH,
  quality = IMAGE_QUALITY,
}) {
  if (!base64Images.length) {
    return transparentPixel;
  }

  const dimensions = await getImageDimensions(base64Images[0]);
  const aspectRatio = dimensions.width / dimensions.height;
  const gridImageHeight = gridImageWidth / aspectRatio;
  const rows = Math.ceil(base64Images.length / columns);

  const imagesWithCoordinates = base64Images.map((src, index) => ({
    src,
    x: (index % columns) * gridImageWidth,
    y: Math.floor(index / columns) * gridImageHeight,
  }));

  return await mergeImages(imagesWithCoordinates, {
    format: "image/jpeg",
    quality,
    width: columns * gridImageWidth,
    height: rows * gridImageHeight,
  });
}

export default function Chat() {
  const id = useId();
  const maxVolumeRef = useRef(0);
  const minVolumeRef = useRef(-100);
  const [displayDebug, setDisplayDebug] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const [phase, setPhase] = useState("not inited");
  const [transcription, setTranscription] = useState("");
  const [imagesGridUrl, setImagesGridUrl] = useState(null);
  const [currentVolume, setCurrentVolume] = useState(-50);
  const [volumePercentage, setVolumePercentage] = useState(0);
  const [token, setToken] = useLocalStorage("ai-token", "");
  const [lang, setLang] = useLocalStorage("lang", "");
  const isBusy = useRef(false);
  const screenshotsRef = useRef([]);
  const videoRef = useRef();
  const canvasRef = useRef();

  const audio = useSilenceAwareRecorder({
    onDataAvailable: onSpeech,
    onVolumeChange: setCurrentVolume,
    silenceDuration: SILENCE_DURATION,
    silentThreshold: SILENT_THRESHOLD,
    minDecibels: -100,
  });

  let { liveStream, ...video } = useMediaRecorder({
    recordScreen: false,
    blobOptions: { type: "video/webm" },
    mediaStreamConstraints: { audio: false, video: true },
  });

  function startRecording() {
    audio.startRecording();
    video.startRecording();
    setIsStarted(true);
    setPhase("user: waiting for speech");
  }

  function stopRecording() {
    document.location.reload();
  }

  async function onSpeech(data) {
    if (isBusy.current) return;

    const token = JSON.parse(localStorage.getItem("ai-token"));
    isBusy.current = true;
    audio.stopRecording();
    setPhase("user: processing speech to text");

    const speechtotextFormData = new FormData();
    speechtotextFormData.append("file", data, "audio.webm");
    speechtotextFormData.append("token", token);
    speechtotextFormData.append("lang", lang);

    const speechtotextResponse = await fetch("/api/speechtotext", {
      method: "POST",
      body: speechtotextFormData,
    });

    const { text, error } = await speechtotextResponse.json();
    if (error) {
      alert(error);
    }

    setTranscription(text);
    setPhase("user: uploading video captures");
    screenshotsRef.current = screenshotsRef.current.slice(-MAX_SCREENSHOTS);

    const imageUrl = await imagesGrid({ base64Images: screenshotsRef.current });
    screenshotsRef.current = [];

    const uploadUrl = await uploadImageToTmpFiles(imageUrl);
    setImagesGridUrl(imageUrl);
    setPhase("user: processing completion");

    await append({
      content: [
        text,
        {
          type: "image_url",
          image_url: { url: uploadUrl },
        },
      ],
      role: "user",
    });
  }

  const { messages, append, reload, isLoading } = useChat({
    id,
    body: { id, token, lang },
    async onFinish(message) {
      setPhase("assistant: processing text to speech");

      const token = JSON.parse(localStorage.getItem("ai-token"));
      const texttospeechFormData = new FormData();
      texttospeechFormData.append("input", message.content);
      texttospeechFormData.append("token", token);

      const response = await fetch("/api/texttospeech", { method: "POST", body: texttospeechFormData });
      setPhase("assistant: playing audio");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      await playAudio(url);

      audio.startRecording();
      isBusy.current = false;
      setPhase("user: waiting for speech");
    },
  });

  useEffect(() => {
    if (videoRef.current && liveStream && !videoRef.current.srcObject) {
      videoRef.current.srcObject = liveStream;
    }
  }, [liveStream]);

  useEffect(() => {
    const captureFrame = () => {
      if (video.status === "recording" && audio.isRecording) {
        const targetWidth = IMAGE_WIDTH;
        const videoNode = videoRef.current;
        const canvasNode = canvasRef.current;

        if (videoNode && canvasNode) {
          const context = canvasNode.getContext("2d");
          const originalWidth = videoNode.videoWidth;
          const originalHeight = videoNode.videoHeight;
          const aspectRatio = originalHeight / originalWidth;

          canvasNode.width = targetWidth;
          canvasNode.height = targetWidth * aspectRatio;
          context.drawImage(videoNode, 0, 0, canvasNode.width, canvasNode.height);
          const quality = 1;
          const base64Image = canvasNode.toDataURL("image/jpeg", quality);

          if (base64Image !== "data:,") {
            screenshotsRef.current.push(base64Image);
          }
        }
      }
    };

    const intervalId = setInterval(captureFrame, INTERVAL);
    return () => clearInterval(intervalId);
  }, [video.status, audio.isRecording]);

  useEffect(() => {
    if (!audio.isRecording) {
      setVolumePercentage(0);
      return;
    }

    if (typeof currentVolume === "number" && isFinite(currentVolume)) {
      if (currentVolume > maxVolumeRef.current) maxVolumeRef.current = currentVolume;
      if (currentVolume < minVolumeRef.current) minVolumeRef.current = currentVolume;

      if (maxVolumeRef.current !== minVolumeRef.current) {
        setVolumePercentage((currentVolume - minVolumeRef.current) / (maxVolumeRef.current - minVolumeRef.current));
      }
    }
  }, [currentVolume, audio.isRecording]);

  const lastAssistantMessage = messages.filter((it) => it.role === "assistant").pop();

  return (
    <>
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <header className="w-full bg-gray-900 text-white py-4 shadow-md">
        <div className="container mx-auto flex justify-between items-center">
          <h1 className="text-2xl font-bold">GPT-4o Video Experiment</h1>
          <nav>
            <ul className="flex space-x-4">
              <li><a href="#" className="hover:underline">Home</a></li>
              <li><a href="#" className="hover:underline">About</a></li>
              <li><a href="#" className="hover:underline">Contact</a></li>
            </ul>
          </nav>
        </div>
      </header>
      <div className="antialiased w-screen h-screen p-4 flex flex-col justify-center items-center bg-gradient-to-r from-gray-800 via-gray-900 to-black text-white">
        <div className="w-full h-full sm:container sm:h-auto grid grid-rows-[auto_1fr_auto] grid-cols-[1fr] sm:grid-cols-[2fr_1fr] sm:grid-rows-[1fr_auto] justify-center">
          <div className="relative">
            <video
              ref={videoRef}
              className="h-auto w-full aspect-[4/3] object-cover rounded-lg bg-gray-900 shadow-lg"
              autoPlay
            />
            {audio.isRecording && (
              <div
                className="absolute top-4 left-1/2 transform -translate-x-1/2 w-16 h-16 bg-red-500 opacity-50 rounded-full transition-transform"
                style={{ transform: `scale(${Math.pow(volumePercentage, 4).toFixed(4)})` }}
              ></div>
            )}
          </div>
          <div className="flex items-center justify-center p-12 text-md leading-relaxed relative">
            {lastAssistantMessage?.content}
            {isLoading && (
              <div className="absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 w-8 h-8">
                <div className="w-6 h-6 -mr-3 -mt-3 rounded-full bg-cyan-500 animate-ping" />
              </div>
            )}
          </div>
          <div className="flex items-center justify-center mt-4">
            {audio.isRecording ? (
              <button
                className="px-4 py-2 bg-red-600 rounded-md text-white hover:bg-red-700 transition disabled:opacity-50"
                onClick={stopRecording}
              >
                Stop session
              </button>
            ) : (
              <button
                className="px-4 py-2 bg-green-600 rounded-md text-white hover:bg-green-700 transition disabled:opacity-50"
                onClick={startRecording}
              >
                Start session
              </button>
            )}
          </div>
        </div>
      </div>
      <footer className="w-full bg-gray-900 text-white py-4 shadow-md">
        <div className="container mx-auto text-center">
          <p>&copy; 2024 GPT-4o Video Experiment. Just for fun</p>
        </div>
      </footer>
    </>
  );
}
