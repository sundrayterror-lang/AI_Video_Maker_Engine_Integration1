import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import { fal } from "@fal-ai/client";
import { fileTypeFromBuffer } from "file-type";

dotenv.config();
if (!process.env.FAL_KEY) {
  console.error("Missing FAL_KEY environment variable. Set it on the server, never in the Android app.");
  process.exit(1);
}
fal.config({ credentials: process.env.FAL_KEY });

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const jobs = new Map();

app.get("/health", (_req, res) => res.json({ ok: true, service: "AI Video Maker backend" }));

app.post("/api/generate", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Please upload an image." });
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !allowedTypes.has(detected.mime)) {
      return res.status(415).json({ error: "Only JPG, PNG, and WEBP images are supported." });
    }
    const prompt = String(req.body.prompt || "").trim();
    if (!prompt || prompt.length > 1200) {
      return res.status(400).json({ error: "Prompt must be between 1 and 1200 characters." });
    }

    const imageFile = new File([req.file.buffer], `upload.${detected.ext}`, { type: detected.mime });
    const imageUrl = await fal.storage.upload(imageFile);

    const submitted = await fal.queue.submit("fal-ai/ovi/image-to-video", {
      input: { prompt, image_url: imageUrl }
    });
    jobs.set(submitted.request_id, { createdAt: Date.now() });
    return res.status(202).json({ requestId: submitted.request_id, status: "IN_QUEUE" });
  } catch (error) {
    console.error("Generation submit failed:", error?.message || error);
    return res.status(500).json({ error: "Could not start video generation. Check the server configuration and provider account." });
  }
});

app.get("/api/status/:requestId", async (req, res) => {
  try {
    const requestId = req.params.requestId;
    if (!jobs.has(requestId)) return res.status(404).json({ error: "Unknown job ID." });
    const status = await fal.queue.status("fal-ai/ovi/image-to-video", { requestId });
    if (status.status === "COMPLETED") {
      const result = await fal.queue.result("fal-ai/ovi/image-to-video", { requestId });
      const videoUrl = result?.data?.video?.url;
      if (!videoUrl) return res.status(502).json({ error: "The provider completed the job but returned no video URL." });
      jobs.delete(requestId);
      return res.json({ status: "COMPLETED", videoUrl });
    }
    if (status.status === "FAILED") {
      jobs.delete(requestId);
      return res.json({ status: "FAILED", error: "The video provider reported a failed generation." });
    }
    return res.json({ status: status.status || "IN_PROGRESS" });
  } catch (error) {
    console.error("Status check failed:", error?.message || error);
    return res.status(500).json({ error: "Could not check video status." });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`AI Video Maker backend listening on ${port}`));
