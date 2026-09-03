import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { getVideoModel, VIDEO_MODELS } from "../shared/videoModels";
import { MUSE_IMAGE_MODEL } from "../shared/imageModels";
import {
  getLocalH3QualityPreset,
  LOCAL_H3_DURATIONS,
  LOCAL_H3_FRAME_FITS,
  LOCAL_H3_QUALITY_PRESETS,
  LOCAL_H3_RESOLUTIONS,
  type LocalH3FrameFitId,
} from "../shared/localH3";
import {
  ApiError,
  discardLocalWorkspace,
  deleteLocalReferenceImage,
  generateImage,
  generateVideo,
  getAppConfig,
  getVideoContent,
  getVideoStatus,
  uploadLocalReferenceImage,
  type GenerationStatus,
  type AppConfig,
  type ImageGenerationResponse,
  type VideoJob,
} from "./api";

type Workflow = "video" | "image";

interface FormState {
  provider: "openrouter" | "local";
  prompt: string;
  model: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  firstFrameUrl: string;
  lastFrameUrl: string;
  generateAudio: boolean;
  localResolution: string;
  localFrames: number;
  localQuality: string;
  localSeed: number;
  localFirstFramePath: string;
  localLastFramePath: string;
  localFrameFit: LocalH3FrameFitId;
  localSsdStreaming: boolean;
}

interface DisplayJob extends VideoJob {
  aspectRatio?: string;
  temporaryApiKey?: string;
}

type IconName =
  | "arrow"
  | "check"
  | "copy"
  | "download"
  | "film"
  | "github"
  | "image"
  | "lock"
  | "spark";

const statusOrder: GenerationStatus[] = ["queued", "processing", "completed", "failed"];
const imageReferenceMaxBytes = 10 * 1024 * 1024;
const uncertainSubmissionMessage = "OpenRouter may already be processing a paid request that Motio cannot track. Check OpenRouter Activity before unlocking another submission.";
const uncertainSubmissionErrors = new Set([
  "invalid_local_response",
  "invalid_provider_response",
  "local_network_error",
  "network_error",
  "provider_error",
  "timeout",
]);

function initialForm(): FormState {
  const model = VIDEO_MODELS[0];
  return {
    provider: "openrouter",
    prompt: "",
    model: model.id,
    duration: model.defaultDuration,
    aspectRatio: model.defaultAspectRatio,
    resolution: model.defaultResolution,
    firstFrameUrl: "",
    lastFrameUrl: "",
    generateAudio: model.generateAudio.default,
    localResolution: "512x512",
    localFrames: 22,
    localQuality: "balanced",
    localSeed: 42,
    localFirstFramePath: "",
    localLastFramePath: "",
    localFrameFit: "contain",
    localSsdStreaming: false,
  };
}

function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M5 21h14" /></>,
    film: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14M3 9h4m10 0h4M3 15h4m10 0h4" /></>,
    github: <><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.3 4 5 5 0 0 0 19.2.5S18 0 15 1.8a13.4 13.4 0 0 0-7 0C5-.1 3.8.5 3.8.5A5 5 0 0 0 3.7 4a5.4 5.4 0 0 0-1.5 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4" /><path d="M8 19c-3 .9-3-1.5-4-2" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    spark: <path d="m12 3 1.3 4.2L17 9l-3.7 1.8L12 15l-1.3-4.2L7 9l3.7-1.8L12 3Zm6 11 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14ZM5 4l.7 2.3L8 7l-2.3.7L5 10l-.7-2.3L2 7l2.3-.7L5 4Z" />,
  };

  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function FieldLabel({ children, htmlFor, optional }: { children: ReactNode; htmlFor: string; optional?: boolean }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <label className="text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700" htmlFor={htmlFor}>
        {children}
      </label>
      {optional && <span className="text-[10px] uppercase tracking-[0.12em] text-stone-400">Optional</span>}
    </div>
  );
}

function StatusRail({ status }: { status?: GenerationStatus }) {
  const currentIndex = status ? statusOrder.indexOf(status) : -1;
  return (
    <div className="grid grid-cols-4 border-y border-white/10" aria-label="Generation progress" aria-live="polite">
      {statusOrder.map((item, index) => {
        const active = status === item;
        const passed = currentIndex > index && status !== "failed";
        return (
          <div
            className={`relative px-2 py-3 text-center text-[9px] font-bold uppercase tracking-[0.13em] sm:text-[10px] ${
              active ? "text-[#d9ff72]" : passed ? "text-white" : "text-white/30"
            }`}
            key={item}
          >
            <span
              className={`mr-1.5 inline-block size-1.5 rounded-full ${
                active ? "bg-[#d9ff72] shadow-[0_0_12px_#d9ff72]" : passed ? "bg-white" : "bg-white/20"
              }`}
            />
            {item}
          </div>
        );
      })}
    </div>
  );
}

function Preview({
  aspectRatio,
  job,
  mediaLoading,
  mediaError,
  pollingStopped,
  onMediaError,
  onMediaRetry,
  videoSource,
}: {
  aspectRatio: string;
  job: DisplayJob | null;
  mediaLoading: boolean;
  mediaError: string | null;
  pollingStopped: boolean;
  onMediaError: () => void;
  onMediaRetry: () => void;
  videoSource?: string;
}) {
  const ratio = aspectRatio.replace(":", " / ");

  if (job?.status === "completed" && mediaLoading) {
    return (
      <div className="relative flex min-h-72 w-full items-center justify-center overflow-hidden bg-[#111310]" style={{ aspectRatio: ratio }}>
        <div className="absolute inset-0 preview-grid opacity-35" />
        <div className="relative text-center">
          <div className="mx-auto mb-5 size-12 animate-spin rounded-full border border-white/15 border-t-[#d9ff72]" />
          <p className="font-display text-2xl uppercase text-white">Loading secure preview</p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">Creating a temporary in-memory URL</p>
        </div>
      </div>
    );
  }

  if (job?.status === "completed" && mediaError) {
    return (
      <div className="flex min-h-72 w-full items-center justify-center bg-[#17100f] px-8 text-center" style={{ aspectRatio: ratio }}>
        <div>
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-full border border-[#ff826e]/40 text-2xl text-[#ff826e]">!</div>
          <p className="font-display text-2xl uppercase text-white">Preview unavailable</p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-white/55">{mediaError}</p>
          <button
            className="mt-5 border border-white/20 px-4 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-white transition hover:border-white/60"
            onClick={onMediaRetry}
            type="button"
          >
            Retry preview
          </button>
        </div>
      </div>
    );
  }

  if (job?.status === "completed" && videoSource) {
    return (
      <video
        className="h-full w-full bg-black object-contain"
        controls
        onError={onMediaError}
        playsInline
        preload="metadata"
        src={videoSource}
        style={{ aspectRatio: ratio }}
      >
        Your browser does not support video playback.
      </video>
    );
  }

  if (job?.status === "queued" || job?.status === "processing") {
    return (
      <div className="relative flex min-h-72 w-full items-center justify-center overflow-hidden bg-[#111310]" style={{ aspectRatio: ratio }}>
        <div className="absolute inset-0 preview-grid opacity-35" />
        <div className="absolute size-56 animate-[spin_14s_linear_infinite] rounded-full border border-[#d9ff72]/15" />
        <div className="absolute size-40 animate-pulse rounded-full border border-[#d9ff72]/30" />
        <div className="relative text-center">
          <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-[#d9ff72] text-black shadow-[0_0_60px_rgba(217,255,114,0.22)]">
            <Icon name="spark" className="size-7" />
          </div>
          <p className="font-display text-2xl uppercase tracking-[-0.04em] text-white">
            {job.status === "queued" ? "On the reel" : "Rendering motion"}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
            {job.phase || (pollingStopped ? "Automatic status checks stopped" : "Automatic status checks are active")}
          </p>
          {typeof job.progress === "number" && (
            <div className="mx-auto mt-4 h-1 w-40 overflow-hidden bg-white/10">
              <div className="h-full bg-[#d9ff72] transition-[width]" style={{ width: `${job.progress}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (job?.status === "failed") {
    return (
      <div className="flex min-h-72 w-full items-center justify-center bg-[#17100f] px-8 text-center" style={{ aspectRatio: ratio }}>
        <div>
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-full border border-[#ff826e]/40 text-2xl text-[#ff826e]">
            !
          </div>
          <p className="font-display text-2xl uppercase text-white">Generation stopped</p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-white/55">
            {job.error || "The provider could not complete this video."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-72 w-full items-center justify-center overflow-hidden bg-[#111310]" style={{ aspectRatio: ratio }}>
      <div className="absolute inset-0 preview-grid opacity-30" />
      <div className="absolute left-[9%] top-[14%] h-[72%] w-[82%] border border-white/10" />
      <div className="absolute left-[13%] top-[19%] h-[62%] w-[74%] border border-white/5" />
      <div className="relative text-center">
        <Icon name="film" className="mx-auto size-9 text-[#d9ff72]/80" />
        <p className="mt-5 font-display text-2xl uppercase tracking-[-0.04em] text-white">Awaiting direction</p>
        <p className="mt-2 max-w-xs text-xs leading-5 text-white/40">
          Your generated film will appear here when the render completes.
        </p>
      </div>
      <span className="absolute bottom-4 left-5 font-mono text-[9px] tracking-[0.18em] text-white/20">FRAME 000</span>
      <span className="absolute right-5 top-4 font-mono text-[9px] tracking-[0.18em] text-white/20">VIDEO / OUT</span>
    </div>
  );
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export default function App() {
  const [workflow, setWorkflow] = useState<Workflow>("video");
  const [form, setForm] = useState<FormState>(initialForm);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageReference, setImageReference] = useState<{ name: string; dataUrl: string } | null>(null);
  const [readingImageReference, setReadingImageReference] = useState(false);
  const [imageResult, setImageResult] = useState<ImageGenerationResponse | null>(null);
  const [job, setJob] = useState<DisplayJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [submissionUncertain, setSubmissionUncertain] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaRetry, setMediaRetry] = useState(0);
  const [sessionApiKey, setSessionApiKey] = useState("");
  const [temporaryVideoUrl, setTemporaryVideoUrl] = useState<string | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [uploadingReference, setUploadingReference] = useState<"first" | "last" | null>(null);
  const [referenceUploadStatus, setReferenceUploadStatus] = useState("");
  const [referenceUploadTokens, setReferenceUploadTokens] = useState<Partial<Record<"first" | "last", string>>>({});
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationController = useRef<AbortController | null>(null);
  const remoteWorkMayContinue = useRef(false);
  const firstFramePathOnFocus = useRef("");
  const lastFramePathOnFocus = useRef("");
  const serverSession = useRef<string | null>(null);
  const serviceState = useRef<"unknown" | "online" | "offline">("unknown");
  const workspaceVersion = useRef(0);

  const selectedModel = getVideoModel(form.model) ?? VIDEO_MODELS[0];
  const selectedLocalQuality = getLocalH3QualityPreset(form.localQuality);
  const isActive = job?.status === "queued" || job?.status === "processing";
  const jobApiKey = job?.provider === "openrouter" ? job.temporaryApiKey : undefined;
  const usesSessionMedia = Boolean(jobApiKey);
  const videoSource = usesSessionMedia ? temporaryVideoUrl || undefined : job?.videoUrl;
  const downloadSource = usesSessionMedia ? temporaryVideoUrl || undefined : job?.downloadUrl;
  const imageSource = imageResult
    ? `data:${imageResult.mediaType};base64,${imageResult.b64Json}`
    : undefined;
  const imageExtension = imageResult?.mediaType === "image/jpeg"
    ? "jpg"
    : imageResult?.mediaType.split("/")[1] || "png";

  const resetWorkspace = (preserveSubmissionLock: boolean) => {
    workspaceVersion.current += 1;
    generationController.current?.abort();
    generationController.current = null;
    if (copyTimer.current) {
      clearTimeout(copyTimer.current);
      copyTimer.current = null;
    }
    setWorkflow("video");
    setForm(initialForm());
    setImagePrompt("");
    setImageReference(null);
    setReadingImageReference(false);
    setImageResult(null);
    setJob(null);
    setSubmitting(false);
    setError(preserveSubmissionLock ? uncertainSubmissionMessage : null);
    setPollWarning(null);
    setPollingStopped(false);
    setSubmissionUncertain(preserveSubmissionLock);
    remoteWorkMayContinue.current = preserveSubmissionLock;
    setCopied(false);
    setMediaError(null);
    setMediaLoading(false);
    setMediaRetry(0);
    setTemporaryVideoUrl(null);
    setUploadingReference(null);
    setReferenceUploadStatus("");
    setReferenceUploadTokens({});
    firstFramePathOnFocus.current = "";
    lastFramePathOnFocus.current = "";
  };

  useEffect(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const root = document.documentElement;
    if (navigation?.type === "reload" && !root.dataset.localWorkspaceDiscarded) {
      root.dataset.localWorkspaceDiscarded = "true";
      void discardLocalWorkspace().catch(() => undefined);
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let consecutiveFailures = 0;
    let firstFailureAt = 0;

    const refreshConfig = async () => {
      const requestController = new AbortController();
      controller = requestController;
      const requestTimeout = setTimeout(() => requestController.abort(), 2_000);
      try {
        const config = await getAppConfig(requestController.signal);
        if (disposed) return;
        consecutiveFailures = 0;
        firstFailureAt = 0;
        if (serverSession.current && serverSession.current !== config.sessionId) {
          resetWorkspace(remoteWorkMayContinue.current);
        }
        serverSession.current = config.sessionId;
        serviceState.current = "online";
        setAppConfig(config);
      } catch {
        if (disposed) return;
        if (consecutiveFailures === 0) firstFailureAt = Date.now();
        consecutiveFailures += 1;
        if (
          consecutiveFailures >= 3 &&
          Date.now() - firstFailureAt >= 6_000 &&
          serviceState.current !== "offline"
        ) {
          resetWorkspace(remoteWorkMayContinue.current);
          serverSession.current = null;
          serviceState.current = "offline";
          setAppConfig(null);
        }
      } finally {
        clearTimeout(requestTimeout);
        if (!disposed) timer = setTimeout(() => void refreshConfig(), 3_000);
      }
    };

    void refreshConfig();
    return () => {
      disposed = true;
      workspaceVersion.current += 1;
      generationController.current?.abort();
      controller?.abort();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "processing")) return;

    const version = workspaceVersion.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let consecutiveFailures = 0;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const nextJob = await getVideoStatus(
          job.id,
          jobApiKey || undefined,
          controller.signal,
        );
        if (disposed || version !== workspaceVersion.current) return;

        consecutiveFailures = 0;
        setPollWarning(null);
        setPollingStopped(false);
        setJob((current) => current?.id === job.id
          ? {
              ...nextJob,
              aspectRatio: job.aspectRatio,
              temporaryApiKey: nextJob.status === "failed" ? undefined : current.temporaryApiKey,
            }
          : current);

        if (nextJob.status === "completed" || nextJob.status === "failed") {
          remoteWorkMayContinue.current = false;
        }

        if (nextJob.status === "failed") {
          setError(nextJob.error || "The video provider could not complete this generation.");
          return;
        }

        if (nextJob.status === "queued" || nextJob.status === "processing") {
          timer = setTimeout(poll, 10_000);
        }
      } catch (pollError) {
        if (disposed || controller.signal.aborted || version !== workspaceVersion.current) return;

        const apiError = pollError instanceof ApiError ? pollError : null;
        if (job.provider === "local" && apiError?.status === 404) {
          const message = apiError.message;
          setJob((current) => current ? { ...current, status: "failed", error: message } : current);
          setError(message);
          return;
        }

        if (apiError && !apiError.retryable) {
          setPollingStopped(true);
          setPollWarning(`${apiError.message} Automatic status checks stopped${job.provider === "openrouter" ? "; verify the job in OpenRouter Activity before clearing it" : ""}.`);
          return;
        }

        consecutiveFailures += 1;
        const retryDelay = apiError?.retryAfterSeconds
          ? apiError.retryAfterSeconds * 1000
          : Math.min(30_000, 5_000 * 2 ** (consecutiveFailures - 1));
        setPollWarning(`${messageFrom(pollError)} Generation status is unknown; retrying automatically.`);
        timer = setTimeout(poll, retryDelay);
      }
    };

    timer = setTimeout(poll, 3_000);

    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [job?.id, jobApiKey]);

  useEffect(() => {
    setTemporaryVideoUrl(null);
    setMediaError(null);
    setMediaLoading(false);

    if (
      job?.status !== "completed" ||
      job.provider === "local" ||
      !job.videoUrl ||
      !jobApiKey
    ) {
      return;
    }

    const key = jobApiKey;
    const version = workspaceVersion.current;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let disposed = false;
    setMediaLoading(true);

    void getVideoContent(job.videoUrl, key, controller.signal)
      .then((blob) => {
        if (disposed || version !== workspaceVersion.current) return;
        objectUrl = URL.createObjectURL(blob);
        setTemporaryVideoUrl(objectUrl);
      })
      .catch((contentError) => {
        if (!controller.signal.aborted && version === workspaceVersion.current) {
          setMediaError(messageFrom(contentError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && version === workspaceVersion.current) setMediaLoading(false);
      });

    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [job?.id, job?.status, job?.videoUrl, jobApiKey, mediaRetry]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!submitting && !isActive && !submissionUncertain) return;

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [submitting, isActive, submissionUncertain]);

  const releaseChangedReference = (
    position: "first" | "last",
    previousPath: string,
    nextPath: string,
  ) => {
    const token = referenceUploadTokens[position];
    if (!token || !previousPath || previousPath === nextPath) return;

    const otherPosition = position === "first" ? "last" : "first";
    const otherPath = otherPosition === "first"
      ? form.localFirstFramePath
      : form.localLastFramePath;
    setReferenceUploadTokens((current) => {
      const next = { ...current, [position]: undefined };
      if (otherPath === previousPath && !current[otherPosition]) {
        next[otherPosition] = token;
      }
      return next;
    });
    if (otherPath !== previousPath) {
      void deleteLocalReferenceImage(token).catch(() => undefined);
    }
  };

  const selectLocalReference = async (
    event: ChangeEvent<HTMLInputElement>,
    position: "first" | "last",
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const frameLabel = position === "first" ? "First" : "Last";

    const previousPath = position === "first"
      ? form.localFirstFramePath
      : form.localLastFramePath;
    const version = workspaceVersion.current;
    setUploadingReference(position);
    setReferenceUploadStatus(`Uploading ${position} frame image.`);
    setError(null);
    try {
      const otherPath = position === "first"
        ? form.localLastFramePath
        : form.localFirstFramePath;
      const previousToken = otherPath === previousPath
        ? undefined
        : referenceUploadTokens[position];
      const uploadToken = crypto.randomUUID();
      const upload = () => uploadLocalReferenceImage(file, uploadToken, previousToken);
      let result: Awaited<ReturnType<typeof upload>>;
      try {
        result = await upload();
      } catch (firstAttemptError) {
        if (version !== workspaceVersion.current) return;
        const apiError = firstAttemptError instanceof ApiError ? firstAttemptError : null;
        if (!apiError || apiError.status >= 300) throw firstAttemptError;
        result = await upload();
      }
      if (version !== workspaceVersion.current) {
        void deleteLocalReferenceImage(result.token).catch(() => undefined);
        return;
      }
      setForm((current) => position === "first"
        ? { ...current, localFirstFramePath: result.path, localFrameFit: "contain" }
        : { ...current, localLastFramePath: result.path, localFrameFit: "contain" });
      setReferenceUploadTokens((current) => {
        const next = { ...current, [position]: result.token };
        const otherPosition = position === "first" ? "last" : "first";
        if (otherPath === previousPath && current[position] && !current[otherPosition]) {
          next[otherPosition] = current[position];
        }
        return next;
      });
      setReferenceUploadStatus(`${frameLabel} frame image uploaded.`);
    } catch (uploadError) {
      if (version !== workspaceVersion.current) return;
      setReferenceUploadStatus(`${frameLabel} frame image upload failed.`);
      setError(messageFrom(uploadError));
    } finally {
      if (version === workspaceVersion.current) setUploadingReference(null);
    }
  };

  const selectImageReference = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setError(null);
    if (file.size > imageReferenceMaxBytes) {
      setError("The reference image must be 10 MB or smaller.");
      return;
    }

    const version = workspaceVersion.current;
    setImageReference(null);
    setReadingImageReference(true);
    try {
      const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const mediaType =
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
          ? "image/png"
          : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            ? "image/jpeg"
            : new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
                new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
              ? "image/webp"
              : undefined;
      if (!mediaType) throw new Error("Choose a PNG, JPEG, or WebP reference image.");

      const rawDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("The browser could not read the reference image."));
        reader.onerror = () => reject(new Error("The browser could not read the reference image."));
        reader.readAsDataURL(file);
      });
      if (version !== workspaceVersion.current) return;
      setImageReference({
        name: file.name,
        dataUrl: `data:${mediaType};base64,${rawDataUrl.slice(rawDataUrl.indexOf(",") + 1)}`,
      });
    } catch (referenceError) {
      if (version === workspaceVersion.current) setError(messageFrom(referenceError));
    } finally {
      if (version === workspaceVersion.current) setReadingImageReference(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      generationController.current ||
      submissionUncertain ||
      submitting ||
      readingImageReference ||
      (workflow === "video" && isActive)
    ) return;

    const requestController = new AbortController();
    generationController.current = requestController;
    const isPaidSubmission = workflow === "image" || form.provider === "openrouter";
    remoteWorkMayContinue.current = isPaidSubmission;
    const version = workspaceVersion.current;
    setSubmitting(true);
    setError(null);
    setPollWarning(null);
    setPollingStopped(false);
    setCopied(false);
    setMediaError(null);

    try {
      const key = sessionApiKey.trim();
      if (workflow === "image") {
        setImageResult(null);
        const result = await generateImage(
          {
            prompt: imagePrompt,
            model: MUSE_IMAGE_MODEL.id,
            inputReference: imageReference?.dataUrl,
          },
          key || undefined,
          requestController.signal,
        );
        if (version !== workspaceVersion.current) return;
        remoteWorkMayContinue.current = false;
        setImageResult(result);
        return;
      }

      const nextJob = form.provider === "local"
        ? await generateVideo({
            provider: "local",
            prompt: form.prompt,
            resolution: form.localResolution,
            frames: form.localFrames,
            quality: form.localQuality,
            seed: form.localSeed,
            firstFramePath: form.localFirstFramePath || undefined,
            lastFramePath: form.localLastFramePath || undefined,
            frameFit: form.localFrameFit,
            previousJobId: job?.provider === "local" ? job.id : undefined,
            ssdStreaming: form.localSsdStreaming,
          }, undefined, requestController.signal)
        : await generateVideo(
            {
              provider: "openrouter",
              prompt: form.prompt,
              model: selectedModel.id,
              duration: form.duration,
              aspectRatio: form.aspectRatio,
              resolution: form.resolution,
              firstFrameUrl: form.firstFrameUrl || undefined,
              lastFrameUrl: form.lastFrameUrl || undefined,
              generateAudio: selectedModel.generateAudio.supported ? form.generateAudio : undefined,
            },
            key || undefined,
            requestController.signal,
          );
      if (version !== workspaceVersion.current) return;
      remoteWorkMayContinue.current = nextJob.provider === "openrouter" &&
        (nextJob.status === "queued" || nextJob.status === "processing");
      setJob({
        ...nextJob,
        temporaryApiKey:
          nextJob.provider === "openrouter" && nextJob.status !== "failed"
            ? key || undefined
            : undefined,
        aspectRatio:
          form.provider === "local"
            ? form.localResolution.replace("x", ":")
            : form.aspectRatio,
      });
    } catch (submitError) {
      if (version !== workspaceVersion.current) return;
      const apiError = submitError instanceof ApiError ? submitError : null;
      if (
        isPaidSubmission &&
        (apiError?.status === 0 || (apiError?.type && uncertainSubmissionErrors.has(apiError.type)))
      ) {
        setSubmissionUncertain(true);
        setError(uncertainSubmissionMessage);
      } else {
        remoteWorkMayContinue.current = false;
        setError(messageFrom(submitError));
      }
    } finally {
      if (generationController.current === requestController) {
        generationController.current = null;
      }
      if (version === workspaceVersion.current) setSubmitting(false);
    }
  };

  const clear = () => {
    if (submitting || uploadingReference !== null || readingImageReference) return;
    if (
      submissionUncertain &&
      !window.confirm("OpenRouter may already be processing this request. Check OpenRouter Activity first. Unlock another paid submission anyway?")
    ) return;
    if (
      isActive &&
      !window.confirm(
        job?.provider === "local"
          ? "Stop watching this local generation? The h3.c process will continue running on this computer."
          : "Stop watching this generation? OpenRouter does not provide a cancellation endpoint, so this will not stop provider work.",
      )
    ) {
      return;
    }
    const selectedWorkflow = workflow;
    const selectedProvider = form.provider;
    resetWorkspace(false);
    setWorkflow(selectedWorkflow);
    setForm((current) => ({ ...current, provider: selectedProvider }));
    void discardLocalWorkspace().catch(() => undefined);
  };

  const copyVideoUrl = async () => {
    const source = videoSource;
    const version = workspaceVersion.current;
    if (!source) return;
    const videoUrl = new URL(source, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(videoUrl);
    } catch {
      if (version !== workspaceVersion.current) return;
      setError("The browser could not copy the video URL to the clipboard.");
      return;
    }
    if (version !== workspaceVersion.current) return;
    setError(null);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <main className="min-h-screen bg-[#0c0d0c] text-[#191b18]">
      <header className="border-b border-white/10 bg-[#0c0d0c] text-white">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-4 sm:px-8 lg:px-10">
          <div className="flex items-center gap-3">
            <img alt="" className="size-8 object-contain" src="/logo.png" />
            <p className="font-display text-sm uppercase tracking-[-0.02em]">Motio</p>
          </div>
          <a
            className="flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[9px] uppercase tracking-[0.15em] text-white/55 transition hover:border-[#d9ff72]/50 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d9ff72]"
            href="https://github.com/SimaxLabs/motio"
            rel="noreferrer"
            target="_blank"
          >
            <Icon name="github" className="size-3 text-[#d9ff72]" />
            GitHub
          </a>
        </div>
      </header>

      <section className="border-b border-white/10 bg-[#0c0d0c] text-white">
        <div className="mx-auto max-w-[1500px] px-3 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-12">
          <h1 className="w-full text-center font-display text-[clamp(1.75rem,9vw,2.5rem)] uppercase leading-[0.9] tracking-[-0.065em] md:whitespace-nowrap md:text-[clamp(1.25rem,3vw,3rem)] lg:text-left">
            <span className="block md:inline">Start with an idea</span>{" "}
            <span className="block text-white/35 md:inline">Choose how it runs</span>{" "}
            <span className="block text-[#d9ff72] md:inline">Set it in motion</span>
          </h1>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1500px] lg:grid-cols-[minmax(0,0.88fr)_minmax(440px,1.12fr)]">
        <form className="bg-[#f0efe8] px-5 py-8 sm:px-8 lg:px-10 lg:py-10" onSubmit={submit}>
          <div className="mb-8 flex items-center justify-between border-b border-black/10 pb-4">
            <h2 className="font-display text-xl uppercase tracking-[-0.04em]">
              {workflow === "video" ? "Scene setup" : "First frame setup"}
            </h2>
            <span className="font-mono text-[9px] tracking-[0.15em] text-stone-400">
              {workflow === "video" ? "01—05" : "01—02"}
            </span>
          </div>

          <div className="mb-7 grid grid-cols-2 gap-1.5 bg-black/5 p-1.5" aria-label="Generation workflow" role="group">
            {(["video", "image"] as const).map((option) => (
              <button
                aria-pressed={workflow === option}
                className={`h-12 text-xs font-bold uppercase tracking-[0.12em] transition disabled:cursor-not-allowed disabled:opacity-40 ${workflow === option ? "bg-black text-[#d9ff72]" : "text-stone-500 hover:bg-white/60 hover:text-black"}`}
                disabled={submitting || isActive || submissionUncertain || uploadingReference !== null || readingImageReference}
                key={option}
                onClick={() => {
                  setWorkflow(option);
                  setError(null);
                }}
                type="button"
              >
                {option === "video" ? "Text to video" : "Generate first frame"}
              </button>
            ))}
          </div>

          {workflow === "video" && (
          <>
          <div className="mb-7 grid grid-cols-2 gap-1.5 border border-black/10 p-1.5" aria-label="Video generation provider">
            {(["openrouter", "local"] as const).map((provider) => (
              <button
                aria-pressed={form.provider === provider}
                className={`h-11 text-[10px] font-bold uppercase tracking-[0.12em] transition disabled:cursor-not-allowed disabled:opacity-40 ${form.provider === provider ? "bg-black text-[#d9ff72]" : "text-stone-500 hover:bg-white/60 hover:text-black"}`}
                disabled={submitting || isActive || uploadingReference !== null || (provider === "local" && appConfig?.localH3.supported === false)}
                key={provider}
                onClick={() => setForm((current) => ({ ...current, provider }))}
                type="button"
              >
                {provider === "openrouter" ? "OpenRouter" : "Local h3.c"}
              </button>
            ))}
          </div>
          {appConfig?.localH3.supported === false && (
            <p className="-mt-5 mb-7 text-[11px] leading-4 text-stone-500">
              Local h3.c requires macOS on Apple Silicon and a loopback-only server. It is unavailable in Docker.
            </p>
          )}
          </>
          )}

          {(workflow === "image" || form.provider === "openrouter") && (
          <div className="mb-7 border border-black/12 bg-[#e7e5dc] p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center bg-white/70"><Icon name="lock" /></div>
              <div className="min-w-0 flex-1">
                <FieldLabel htmlFor="session-api-key">Temporary OpenRouter API key</FieldLabel>
                <div className="flex gap-2">
                  <input
                    aria-describedby="session-key-help"
                    autoComplete="off"
                    className="h-11 min-w-0 flex-1 border border-black/15 bg-[#faf9f3] px-3 font-mono text-xs outline-none transition placeholder:text-stone-400 focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    disabled={submitting}
                    id="session-api-key"
                    maxLength={1_024}
                    onChange={(event) => setSessionApiKey(event.target.value)}
                    placeholder="sk-or-v1-..."
                    spellCheck={false}
                    type="password"
                    value={sessionApiKey}
                  />
                  {sessionApiKey && (
                    <button
                      className="border border-black/15 px-3 text-[10px] font-bold uppercase tracking-[0.12em] hover:border-black"
                      disabled={submitting}
                      onClick={() => setSessionApiKey("")}
                      type="button"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-4 text-stone-500" id="session-key-help">
                  Temporary for this browser tab only. The key is never stored server-side and remains here until you remove it or close the tab.
                </p>
              </div>
            </div>
          </div>
          )}

          {workflow === "image" ? (
          <fieldset disabled={submitting || readingImageReference}>
            <div>
              <FieldLabel htmlFor="image-prompt">Image prompt</FieldLabel>
              <div className="relative">
                <textarea
                  autoFocus
                  className="min-h-40 w-full resize-y border border-black/15 bg-[#faf9f3] px-4 py-4 text-[15px] leading-6 outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                  id="image-prompt"
                  maxLength={10_000}
                  onChange={(event) => setImagePrompt(event.target.value)}
                  placeholder="The opening frame of a rain-soaked night market, cinematic lighting, reflections rippling across the pavement..."
                  required
                  value={imagePrompt}
                />
                <span className="absolute bottom-3 right-3 font-mono text-[9px] text-stone-400">{imagePrompt.length} / 10K</span>
              </div>
            </div>
            <div className="mt-6 border border-black/12 bg-[#e7e5dc] p-4 sm:p-5">
              <div className="mb-4 flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center bg-white/70"><Icon name="image" /></div>
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em]">Reference image</h3>
                  <p className="mt-1 text-[11px] leading-4 text-stone-500">
                    Add one optional PNG, JPEG, or WebP image up to 10 MB.
                  </p>
                </div>
              </div>
              <FieldLabel htmlFor="image-reference" optional>Image file</FieldLabel>
              <input
                accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                className="h-11 w-full cursor-pointer text-[0] outline-none file:h-11 file:w-full file:cursor-pointer file:border file:border-black/15 file:bg-[#faf9f3] file:px-3 file:text-[10px] file:font-bold file:uppercase file:tracking-[0.12em] hover:file:border-black focus-visible:ring-2 focus-visible:ring-black"
                id="image-reference"
                onChange={(event) => void selectImageReference(event)}
                type="file"
              />
              <p aria-live="polite" className="sr-only" role="status">
                {readingImageReference
                  ? "Reading reference image."
                  : imageReference
                    ? `Reference image ${imageReference.name} is ready.`
                    : ""}
              </p>
              {imageReference && (
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-black/10 pt-3">
                  <span className="truncate text-xs text-stone-600">{imageReference.name}</span>
                  <button
                    className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-stone-600 hover:text-black"
                    onClick={() => setImageReference(null)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
            <div className="mt-6">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Model</p>
              <p className="flex h-12 items-center border border-black/15 bg-[#faf9f3] px-3 text-sm text-stone-700">
                {MUSE_IMAGE_MODEL.name}
              </p>
              <p className="mt-2 font-mono text-[10px] text-stone-600">
                OpenRouter price: {MUSE_IMAGE_MODEL.price}
              </p>
              <p className="mt-2 text-[11px] leading-4 text-stone-500">
                The reference is sent through OpenRouter's documented input_references field.
              </p>
            </div>
          </fieldset>
          ) : (
          <fieldset disabled={submitting || isActive || uploadingReference !== null}>
            <div>
              <FieldLabel htmlFor="prompt">Prompt</FieldLabel>
              <div className="relative">
              <textarea
                autoFocus
                className="min-h-40 w-full resize-y border border-black/15 bg-[#faf9f3] px-4 py-4 text-[15px] leading-6 outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                maxLength={10_000}
                id="prompt"
                onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                placeholder="A single tracking shot through a rain-soaked night market, reflections rippling across the pavement..."
                required
                value={form.prompt}
              />
              <span className="absolute bottom-3 right-3 font-mono text-[9px] text-stone-400">{form.prompt.length} / 10K</span>
              </div>
            </div>

          {form.provider === "openrouter" ? (
          <>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="model">Model</FieldLabel>
              <select
                className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                id="model"
                onChange={(event) => {
                  const model = getVideoModel(event.target.value);
                  if (!model) return;
                  setForm((current) => ({
                    ...current,
                    model: model.id,
                    duration: model.defaultDuration,
                    aspectRatio: model.defaultAspectRatio,
                    resolution: model.defaultResolution,
                    generateAudio: model.generateAudio.default,
                  }));
                }}
                value={selectedModel.id}
              >
                {VIDEO_MODELS.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
              <p className="mt-2 font-mono text-[10px] leading-4 text-stone-600">
                OpenRouter price: {selectedModel.price}
              </p>
            </div>
            <div>
              <FieldLabel htmlFor="resolution">Resolution</FieldLabel>
              <select
                className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                id="resolution"
                onChange={(event) => setForm((current) => ({ ...current, resolution: event.target.value }))}
                value={form.resolution}
              >
                {selectedModel.resolutions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
              </select>
            </div>
          </div>

          <div className="mt-6 grid gap-5 sm:grid-cols-[0.7fr_1.3fr]">
            <div>
              <FieldLabel htmlFor="duration">Duration</FieldLabel>
              <select
                className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                onChange={(event) => setForm((current) => ({ ...current, duration: Number(event.target.value) }))}
                id="duration"
                value={form.duration}
              >
                {selectedModel.durations.map((duration) => <option key={duration} value={duration}>{duration} seconds</option>)}
              </select>
            </div>
            <fieldset>
              <legend className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Aspect ratio</legend>
              <div className="grid grid-cols-3 gap-1.5">
                {selectedModel.aspectRatios.map((ratio) => (
                  <button
                    className={`h-12 border text-xs font-bold transition ${form.aspectRatio === ratio ? "border-black bg-black text-[#d9ff72]" : "border-black/15 bg-[#faf9f3] hover:border-black/50"}`}
                    aria-pressed={form.aspectRatio === ratio}
                    key={ratio}
                    onClick={() => setForm((current) => ({ ...current, aspectRatio: ratio }))}
                    type="button"
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          {selectedModel.frameImages.input === "public_url" && selectedModel.frameImages.supported.length > 0 && (
            <div className="mt-7 border border-black/12 bg-[#e7e5dc] p-4 sm:p-5">
              <div className="mb-4 flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center bg-white/70"><Icon name="image" /></div>
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em]">Reference frames</h3>
                  <p className="mt-1 text-[11px] leading-4 text-stone-500">
                    Reference images must use public HTTPS URLs that the model provider can access.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {selectedModel.frameImages.supported.map((frameType) => {
                  const first = frameType === "first_frame";
                  const position = first ? "first" : "last";
                  return (
                    <div key={frameType}>
                      <FieldLabel htmlFor={`${position}-frame-url`} optional>{first ? "First" : "Last"} frame URL</FieldLabel>
                      <input
                        className="h-11 w-full border border-black/15 bg-[#faf9f3] px-3 text-xs outline-none transition placeholder:text-stone-400 focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                        id={`${position}-frame-url`}
                        onChange={(event) => setForm((current) => first
                          ? { ...current, firstFrameUrl: event.target.value }
                          : { ...current, lastFrameUrl: event.target.value })}
                        placeholder={`https://.../${first ? "opening" : "closing"}.jpg`}
                        type="url"
                        value={first ? form.firstFrameUrl : form.lastFrameUrl}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selectedModel.generateAudio.supported && (
            <label className="mt-5 flex cursor-pointer items-center justify-between border-y border-black/10 py-4">
              <span>
                <span className="block text-xs font-bold uppercase tracking-[0.12em]">Generate audio</span>
                <span className="mt-1 block text-[11px] text-stone-500">Create a matching native soundtrack with the video.</span>
              </span>
              <span className={`relative h-7 w-12 rounded-full transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-black has-[:focus-visible]:ring-offset-2 ${form.generateAudio ? "bg-black" : "bg-stone-300"}`}>
                <input
                  checked={form.generateAudio}
                  className="sr-only"
                  onChange={(event) => setForm((current) => ({ ...current, generateAudio: event.target.checked }))}
                  type="checkbox"
                />
                <span className={`absolute top-1 size-5 rounded-full transition ${form.generateAudio ? "left-6 bg-[#d9ff72]" : "left-1 bg-white"}`} />
              </span>
            </label>
          )}
          </>
          ) : (
            <>
              <div className="mt-6 grid gap-5 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Model</p>
                  <p className="flex h-12 items-center border border-black/15 bg-[#faf9f3] px-3 text-sm text-stone-700">MiniMax H3 / h3.c</p>
                </div>
                <div>
                  <FieldLabel htmlFor="local-resolution">Resolution</FieldLabel>
                  <select
                    className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="local-resolution"
                    onChange={(event) => setForm((current) => ({ ...current, localResolution: event.target.value }))}
                    value={form.localResolution}
                  >
                    {LOCAL_H3_RESOLUTIONS.map((resolution) => (
                      <option key={resolution.id} value={resolution.id}>{resolution.label} - {resolution.note}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-6 grid gap-5 sm:grid-cols-[0.7fr_1.3fr]">
                <div>
                  <FieldLabel htmlFor="local-duration">Duration</FieldLabel>
                  <select
                    className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="local-duration"
                    onChange={(event) => setForm((current) => ({ ...current, localFrames: Number(event.target.value) }))}
                    value={form.localFrames}
                  >
                    {LOCAL_H3_DURATIONS.map((duration) => (
                      <option key={duration.frames} value={duration.frames}>{duration.label} / {duration.frames} frames</option>
                    ))}
                  </select>
                </div>
                <fieldset>
                  <legend className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Quality</legend>
                  <div className="grid grid-cols-3 gap-1.5">
                    {LOCAL_H3_QUALITY_PRESETS.map((quality) => (
                      <button
                        aria-pressed={form.localQuality === quality.id}
                        className={`h-12 border text-xs font-bold transition ${form.localQuality === quality.id ? "border-black bg-black text-[#d9ff72]" : "border-black/15 bg-[#faf9f3] hover:border-black/50"}`}
                        key={quality.id}
                        onClick={() => setForm((current) => ({ ...current, localQuality: quality.id }))}
                        type="button"
                      >
                        {quality.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10px] leading-4 text-stone-500">{selectedLocalQuality?.note}</p>
                </fieldset>
              </div>

              <div className="mt-7 border border-black/12 bg-[#e7e5dc] p-4 sm:p-5">
                <div className="mb-4 flex items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center bg-white/70"><Icon name="image" /></div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-[0.12em]">Reference frames</h3>
                    <p className="mt-1 text-[11px] leading-4 text-stone-500">
                      Enter absolute paths from this Mac, or browse to upload PNG, JPEG, or WebP images up to 25 MB and fill server-owned paths automatically.
                    </p>
                    <p aria-live="polite" className="sr-only" role="status">
                      {referenceUploadStatus}
                    </p>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(["first", "last"] as const).map((position) => {
                    const first = position === "first";
                    const focusPath = first ? firstFramePathOnFocus : lastFramePathOnFocus;
                    const value = first ? form.localFirstFramePath : form.localLastFramePath;
                    return (
                      <div key={position}>
                        <FieldLabel htmlFor={`local-${position}-frame-path`} optional>{first ? "First" : "Last"} frame path</FieldLabel>
                        <div className="flex gap-2">
                          <input
                            className="h-11 min-w-0 flex-1 border border-black/15 bg-[#faf9f3] px-3 font-mono text-xs outline-none transition placeholder:text-stone-400 focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                            id={`local-${position}-frame-path`}
                            onBlur={(event) => {
                              releaseChangedReference(position, focusPath.current, event.currentTarget.value);
                              focusPath.current = event.currentTarget.value;
                            }}
                            onChange={(event) => setForm((current) => first
                              ? {
                                  ...current,
                                  localFirstFramePath: event.target.value,
                                  localFrameFit: event.target.value ? "contain" : current.localFrameFit,
                                }
                              : {
                                  ...current,
                                  localLastFramePath: event.target.value,
                                  localFrameFit: event.target.value ? "contain" : current.localFrameFit,
                                })}
                            onFocus={(event) => { focusPath.current = event.currentTarget.value; }}
                            placeholder={`/Users/.../${first ? "opening" : "closing"}.png`}
                            spellCheck={false}
                            type="text"
                            value={value}
                          />
                          <input
                            accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                            aria-label={uploadingReference === position ? `Uploading ${position} frame image` : `Browse for ${position} frame image`}
                            className="peer sr-only"
                            id={`local-${position}-frame-picker`}
                            onChange={(event) => void selectLocalReference(event, position)}
                            type="file"
                          />
                          <label
                            className="flex size-11 shrink-0 cursor-pointer items-center justify-center border border-black/15 text-stone-600 transition hover:border-black hover:text-black peer-focus-visible:ring-2 peer-focus-visible:ring-black peer-disabled:cursor-wait peer-disabled:opacity-45"
                            htmlFor={`local-${position}-frame-picker`}
                            title={`Browse for ${position} frame image`}
                          >
                            <Icon name="image" />
                            <span className="sr-only">Browse for {position} frame image</span>
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(form.localFirstFramePath || form.localLastFramePath) && (
                  <fieldset className="mt-4 border-t border-black/10 pt-4">
                    <legend className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Reference framing</legend>
                    <div className="grid grid-cols-2 gap-1.5">
                      {LOCAL_H3_FRAME_FITS.map((fit) => (
                        <button
                          aria-describedby={`local-frame-fit-${fit.id}-description`}
                          aria-pressed={form.localFrameFit === fit.id}
                          className={`min-h-11 border px-3 text-xs font-bold transition ${form.localFrameFit === fit.id ? "border-black bg-black text-[#d9ff72]" : "border-black/15 bg-[#faf9f3] hover:border-black/50"}`}
                          key={fit.id}
                          onClick={() => setForm((current) => ({ ...current, localFrameFit: fit.id }))}
                          type="button"
                        >
                          {fit.label}
                          <span className="sr-only" id={`local-frame-fit-${fit.id}-description`}>{fit.note}</span>
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] leading-4 text-stone-600">
                      {LOCAL_H3_FRAME_FITS.find((fit) => fit.id === form.localFrameFit)?.note}
                    </p>
                  </fieldset>
                )}
              </div>

              <div className="mt-6 sm:max-w-[calc(50%-0.625rem)]">
                  <FieldLabel htmlFor="local-seed">Seed / variation</FieldLabel>
                  <input
                    className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 font-mono text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="local-seed"
                    max={Number.MAX_SAFE_INTEGER}
                    min={0}
                    onChange={(event) => setForm((current) => ({ ...current, localSeed: Number(event.target.value) }))}
                    required
                    type="number"
                    value={form.localSeed}
                  />
                  <p className="mt-1.5 text-[10px] leading-4 text-stone-500">
                    Keep the same seed and settings to reproduce a variation; change it for a different result.
                  </p>
              </div>

              <label className="mt-5 flex cursor-pointer items-center justify-between border-y border-black/10 py-4">
                <span>
                  <span className="block text-xs font-bold uppercase tracking-[0.12em]">SSD streaming</span>
                  <span className="mt-1 block text-[11px] text-stone-500">Use much less unified memory at the cost of slower generation.</span>
                </span>
                <span className={`relative h-7 w-12 rounded-full transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-black has-[:focus-visible]:ring-offset-2 ${form.localSsdStreaming ? "bg-black" : "bg-stone-300"}`}>
                  <input
                    checked={form.localSsdStreaming}
                    className="sr-only"
                    onChange={(event) => setForm((current) => ({ ...current, localSsdStreaming: event.target.checked }))}
                    type="checkbox"
                  />
                  <span className={`absolute top-1 size-5 rounded-full transition ${form.localSsdStreaming ? "left-6 bg-[#d9ff72]" : "left-1 bg-white"}`} />
                </span>
              </label>

              <div className="mt-7 border border-black/12 bg-[#e7e5dc] p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center bg-[#d9ff72] text-black"><Icon name="spark" /></div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-[0.12em]">Local engine</h3>
                    <p className="mt-1 text-[11px] leading-4 text-stone-500">
                      {appConfig?.localH3.configured
                        ? "h3.c is configured. Local jobs run one at a time and include native audio."
                        : "Set H3_BINARY and H3_MODEL_DIR on the backend. The h3.c binary, model snapshot, and FFmpeg are required."}
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
          </fieldset>
          )}

          {error && (
            <div className="mt-5 border-l-4 border-[#e44d38] bg-[#f9dfd9] px-4 py-3 text-sm leading-5 text-[#712519]" role="alert">
              {error}
            </div>
          )}

          <div className="mt-7 flex gap-3">
            <button
              className="group flex h-14 flex-1 items-center justify-between bg-black px-5 font-display text-sm uppercase tracking-[0.02em] text-white transition hover:bg-[#242722] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={
                submitting ||
                readingImageReference ||
                submissionUncertain ||
                (workflow === "video" && (isActive || uploadingReference !== null || !form.prompt.trim())) ||
                (workflow === "image" && !imagePrompt.trim())
              }
              type="submit"
            >
              <span>
                {submitting
                  ? "Submitting..."
                  : workflow === "image"
                    ? "Generate first frame"
                    : isActive
                      ? "Generation active"
                      : form.provider === "local"
                        ? "Generate locally"
                        : submissionUncertain
                          ? "Submission status unknown"
                          : "Generate video"}
              </span>
              <span className="flex size-8 items-center justify-center rounded-full bg-[#d9ff72] text-black transition group-hover:translate-x-1"><Icon name="arrow" /></span>
            </button>
            <button
              className="h-14 border border-black/20 px-4 text-[10px] font-bold uppercase tracking-[0.12em] hover:border-black disabled:cursor-not-allowed disabled:opacity-45"
              disabled={submitting || uploadingReference !== null || readingImageReference}
              onClick={clear}
              type="button"
            >
              {submissionUncertain ? "Unlock retry" : workflow === "video" && isActive ? "Stop watching" : "Clear"}
            </button>
          </div>
        </form>

        <section className="flex min-h-[620px] flex-col bg-[#171917] text-white lg:min-h-full">
          {workflow === "image" ? (
          <>
          <div className="flex items-center justify-between px-5 py-5 sm:px-8">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/60">First frame monitor</p>
              <h2 className="mt-1 font-display text-lg uppercase">
                {imageResult ? MUSE_IMAGE_MODEL.name : "No generated frame"}
              </h2>
              <p aria-live="polite" className="sr-only" role="status">
                {submitting ? "Generating first frame." : imageResult ? "First frame generation completed." : ""}
              </p>
            </div>
            {imageResult && (
              <span className="rounded-full border border-[#d9ff72]/30 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[#d9ff72]">
                Completed
              </span>
            )}
          </div>

          <div className="flex flex-1 items-center p-5 sm:p-8">
            <div className="relative flex min-h-72 w-full items-center justify-center overflow-hidden border border-white/10 bg-black shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
              {submitting ? (
                <div className="relative flex min-h-96 w-full items-center justify-center overflow-hidden bg-[#111310]">
                  <div className="absolute inset-0 preview-grid opacity-35" />
                  <div className="relative text-center">
                    <div className="mx-auto mb-5 size-12 animate-spin rounded-full border border-white/15 border-t-[#d9ff72]" />
                    <p className="font-display text-2xl uppercase text-white">Rendering first frame</p>
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/60">Muse is composing the image</p>
                  </div>
                </div>
              ) : imageSource ? (
                <img
                  alt="Generated first frame"
                  className="max-h-[760px] w-full object-contain"
                  src={imageSource}
                />
              ) : (
                <div className="relative flex min-h-96 w-full items-center justify-center overflow-hidden bg-[#111310]">
                  <div className="absolute inset-0 preview-grid opacity-30" />
                  <div className="relative px-6 text-center">
                    <Icon name="image" className="mx-auto size-9 text-[#d9ff72]/80" />
                    <p className="mt-5 font-display text-2xl uppercase tracking-[-0.04em] text-white">Awaiting first frame</p>
                    <p className="mt-2 max-w-xs text-xs leading-5 text-white/65">
                      Describe the opening image for your next video.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-white/10 px-5 py-5 sm:px-8">
            {imageResult && imageSource ? (
              <>
                <a
                  className="flex h-12 w-full items-center justify-center gap-2 bg-[#d9ff72] text-xs font-bold uppercase tracking-[0.12em] text-black transition hover:bg-white"
                  download={`muse-first-frame.${imageExtension}`}
                  href={imageSource}
                >
                  <Icon name="download" /> Download first frame
                </a>
                {typeof imageResult.cost === "number" && (
                  <p className="mt-3 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-white/60">
                    OpenRouter cost ${imageResult.cost.toFixed(4)}
                  </p>
                )}
              </>
            ) : (
              <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-white/60">
                Output controls unlock on completion
              </p>
            )}
          </div>
          </>
          ) : (
          <>
          <div className="flex items-center justify-between px-5 py-5 sm:px-8">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/35">Output monitor</p>
              <h2 className="mt-1 font-display text-lg uppercase">{job ? `Job ${job.id.slice(0, 12)}` : "No active reel"}</h2>
            </div>
            {job && (
              <span className={`rounded-full border px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] ${job.status === "failed" ? "border-[#ff826e]/30 text-[#ff826e]" : "border-[#d9ff72]/30 text-[#d9ff72]"}`}>
                {job.status}
              </span>
            )}
          </div>

          <StatusRail status={job?.status} />

          <div className="flex flex-1 items-center p-5 sm:p-8">
            <div className="w-full overflow-hidden border border-white/10 bg-black shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
              <Preview
                aspectRatio={job?.aspectRatio || (form.provider === "local" ? form.localResolution.replace("x", ":") : form.aspectRatio)}
                job={job}
                mediaLoading={mediaLoading}
                mediaError={mediaError}
                pollingStopped={pollingStopped}
                onMediaError={() => setMediaError("The completed video could not be loaded in the player. Try downloading it instead.")}
                onMediaRetry={() => {
                  setMediaError(null);
                  setMediaRetry((current) => current + 1);
                }}
                videoSource={videoSource}
              />
            </div>
          </div>

          {pollWarning && (
            <div className="mx-5 mb-4 border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-xs leading-5 text-amber-100/70 sm:mx-8" role="status">
              {pollWarning}
            </div>
          )}

          <div className="border-t border-white/10 px-5 py-5 sm:px-8">
            {job?.status === "completed" && downloadSource ? (
              <div className="flex flex-col gap-3 sm:flex-row">
                <a
                  className="flex h-12 flex-1 items-center justify-center gap-2 bg-[#d9ff72] text-xs font-bold uppercase tracking-[0.12em] text-black transition hover:bg-white"
                  download={usesSessionMedia ? "openrouter-video.mp4" : undefined}
                  href={downloadSource}
                >
                  <Icon name="download" /> Download video
                </a>
                <button
                  className="flex h-12 flex-1 items-center justify-center gap-2 border border-white/15 text-xs font-bold uppercase tracking-[0.12em] text-white transition hover:border-white/50"
                  onClick={copyVideoUrl}
                  type="button"
                >
                  <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : usesSessionMedia ? "Copy temporary URL" : "Copy video URL"}
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.15em] text-white/28">
                <span>{pollingStopped ? "Automatic polling stopped" : isActive ? "Polling every 10 seconds" : "Output controls unlock on completion"}</span>
                {typeof job?.cost === "number" && <span>Cost ${job.cost.toFixed(4)}</span>}
              </div>
            )}
            {job?.status === "completed" && typeof job.cost === "number" && (
              <p className="mt-3 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-white/35">OpenRouter cost ${job.cost.toFixed(4)}</p>
            )}
          </div>
          </>
          )}
        </section>
      </div>

    </main>
  );
}
