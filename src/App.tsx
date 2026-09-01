import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL_ID,
  getVideoModel,
  VIDEO_MODELS,
  type VideoModelConfig,
} from "../shared/videoModels";
import {
  getLocalH3QualityPreset,
  LOCAL_H3_DURATIONS,
  LOCAL_H3_QUALITY_PRESETS,
  LOCAL_H3_RESOLUTIONS,
} from "../shared/localH3";
import {
  ApiError,
  generateVideo,
  getAppConfig,
  getVideoContent,
  getVideoStatus,
  type GenerationStatus,
  type AppConfig,
  type VideoJob,
} from "./api";

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
  localSsdStreaming: boolean;
}

interface DisplayJob extends VideoJob {
  aspectRatio?: string;
}

type IconName =
  | "arrow"
  | "check"
  | "copy"
  | "download"
  | "film"
  | "image"
  | "lock"
  | "spark";

const statusOrder: GenerationStatus[] = ["queued", "processing", "completed", "failed"];
const storedJobKey = "motion-lab:video-job";

function loadStoredJob(): DisplayJob | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storedJobKey) || "null");
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("status" in value) ||
      typeof value.status !== "string" ||
      !statusOrder.includes(value.status as GenerationStatus)
    ) {
      return null;
    }
    const status = value.status as GenerationStatus;
    const provider =
      "provider" in value && value.provider === "local" ? "local" : "openrouter";
    const job: DisplayJob = {
      id: value.id,
      provider,
      status,
    };

    if ("aspectRatio" in value && typeof value.aspectRatio === "string") {
      job.aspectRatio = value.aspectRatio;
    }
    if ("error" in value && typeof value.error === "string") job.error = value.error;
    if ("cost" in value && typeof value.cost === "number") job.cost = value.cost;
    if ("phase" in value && typeof value.phase === "string") job.phase = value.phase;
    if ("progress" in value && typeof value.progress === "number") {
      job.progress = value.progress;
    }
    if (status === "completed") {
      const id = encodeURIComponent(value.id);
      job.videoUrl = `/api/video/content/${id}`;
      job.downloadUrl = `/api/video/content/${id}?download=1`;
    }
    return job;
  } catch {
    return null;
  }
}

function initialForm(model: VideoModelConfig): FormState {
  return {
    provider: "openrouter",
    prompt: "",
    model: model.id,
    duration: model.defaultDuration,
    aspectRatio: model.defaultAspectRatio,
    resolution: model.defaultResolution || "",
    firstFrameUrl: "",
    lastFrameUrl: "",
    generateAudio: model.generateAudio.default,
    localResolution: "512x512",
    localFrames: 22,
    localQuality: "balanced",
    localSeed: 42,
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
  return (
    <div className="grid grid-cols-4 border-y border-white/10" aria-label="Generation progress" aria-live="polite">
      {statusOrder.map((item, index) => {
        const active = status === item;
        const currentIndex = status ? statusOrder.indexOf(status) : -1;
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
  onMediaError,
  videoSource,
}: {
  aspectRatio: string;
  job: DisplayJob | null;
  mediaLoading: boolean;
  mediaError: string | null;
  onMediaError: () => void;
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
            {job.phase || "Automatic status checks are active"}
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
  const defaultModel = getVideoModel(DEFAULT_MODEL_ID) || VIDEO_MODELS[0];
  const [form, setForm] = useState<FormState>(() => initialForm(defaultModel));
  const [job, setJob] = useState<DisplayJob | null>(loadStoredJob);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [sessionApiKey, setSessionApiKey] = useState("");
  const [temporaryVideoUrl, setTemporaryVideoUrl] = useState<string | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedModel = getVideoModel(form.model) || defaultModel;
  const selectedLocalQuality = getLocalH3QualityPreset(form.localQuality);
  const isActive = job?.status === "queued" || job?.status === "processing";
  const hasSessionApiKey = Boolean(sessionApiKey.trim());
  const usesSessionMedia = job?.provider !== "local" && hasSessionApiKey;
  const pollApiKey = job?.provider === "local" ? "" : sessionApiKey;
  const videoSource = usesSessionMedia ? temporaryVideoUrl || undefined : job?.videoUrl;
  const downloadSource = usesSessionMedia ? temporaryVideoUrl || undefined : job?.downloadUrl;

  useEffect(() => {
    void getAppConfig().then(setAppConfig).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "processing")) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let consecutiveFailures = 0;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const nextJob = await getVideoStatus(
          job.id,
          pollApiKey || undefined,
          controller.signal,
        );
        if (disposed) return;

        consecutiveFailures = 0;
        setPollWarning(null);
        setJob({
          ...nextJob,
          aspectRatio: job.aspectRatio,
        });

        if (nextJob.status === "failed") {
          setError(nextJob.error || "The video provider could not complete this generation.");
          return;
        }

        if (nextJob.status === "queued" || nextJob.status === "processing") {
          timer = setTimeout(poll, 10_000);
        }
      } catch (pollError) {
        if (disposed || controller.signal.aborted) return;

        const apiError = pollError instanceof ApiError ? pollError : null;
        if (job.provider === "local" && apiError?.status === 404) {
          const message = apiError.message;
          setJob((current) => current ? { ...current, status: "failed", error: message } : current);
          setError(message);
          return;
        }

        consecutiveFailures += 1;
        const retryDelay = apiError?.retryAfterSeconds
          ? apiError.retryAfterSeconds * 1000
          : apiError && !apiError.retryable
            ? 30_000
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
  }, [job?.id, pollApiKey]);

  useEffect(() => {
    if (job) localStorage.setItem(storedJobKey, JSON.stringify(job));
    else localStorage.removeItem(storedJobKey);
  }, [job]);

  useEffect(() => {
    setTemporaryVideoUrl(null);
    setMediaError(null);
    setMediaLoading(false);

    if (
      job?.status !== "completed" ||
      job.provider === "local" ||
      !job.videoUrl ||
      !sessionApiKey.trim()
    ) {
      return;
    }

    const key = sessionApiKey.trim();
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setMediaLoading(true);

    void getVideoContent(job.videoUrl, key, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setTemporaryVideoUrl(objectUrl);
      })
      .catch((contentError) => {
        if (!controller.signal.aborted) {
          setMediaError(messageFrom(contentError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setMediaLoading(false);
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [job?.id, job?.status, job?.videoUrl, sessionApiKey]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const updateModel = (modelId: string) => {
    const model = getVideoModel(modelId);
    if (!model) return;
    setForm((current) => ({ ...initialForm(model), prompt: current.prompt }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setPollWarning(null);
    setCopied(false);
    setMediaError(null);

    try {
      const key = sessionApiKey.trim();
      const nextJob = form.provider === "local"
        ? await generateVideo({
            provider: "local",
            prompt: form.prompt,
            resolution: form.localResolution,
            frames: form.localFrames,
            quality: form.localQuality,
            seed: form.localSeed,
            ssdStreaming: form.localSsdStreaming,
          })
        : await generateVideo(
            {
              provider: "openrouter",
              prompt: form.prompt,
              model: form.model,
              duration: form.duration,
              aspectRatio: form.aspectRatio,
              resolution: form.resolution || undefined,
              firstFrameUrl: form.firstFrameUrl || undefined,
              lastFrameUrl: form.lastFrameUrl || undefined,
              generateAudio: selectedModel.generateAudio.supported ? form.generateAudio : undefined,
            },
            key || undefined,
          );
      setJob({
        ...nextJob,
        aspectRatio:
          form.provider === "local"
            ? form.localResolution.replace("x", ":")
            : form.aspectRatio,
      });
    } catch (submitError) {
      setError(messageFrom(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const clear = () => {
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
    setJob(null);
    setError(null);
    setPollWarning(null);
    setCopied(false);
    setMediaError(null);
    setMediaLoading(false);
  };

  const copyVideoUrl = async () => {
    if (!videoSource) return;
    try {
      await navigator.clipboard.writeText(new URL(videoSource, window.location.origin).href);
      setError(null);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2_000);
    } catch {
      const videoUrl = new URL(videoSource, window.location.origin).href;
      const input = document.createElement("textarea");
      input.value = videoUrl;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copiedWithFallback = document.execCommand("copy");
      input.remove();
      if (!copiedWithFallback) {
        setError("The browser could not copy the video URL to the clipboard.");
        return;
      }
      setError(null);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2_000);
    }
  };

  return (
    <main className="min-h-screen bg-[#0c0d0c] text-[#191b18]">
      <header className="border-b border-white/10 bg-[#0c0d0c] text-white">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-4 sm:px-8 lg:px-10">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center bg-[#d9ff72] text-black">
              <Icon name="film" className="size-4" />
            </div>
            <div>
              <p className="font-display text-sm uppercase tracking-[-0.02em]">Motion Lab</p>
              <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-white/35">Remote + local video studio</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[9px] uppercase tracking-[0.15em] text-white/55">
            <Icon name="lock" className="size-3 text-[#d9ff72]" />
            <span className="hidden sm:inline">{form.provider === "local" ? "Local Metal" : sessionApiKey.trim() ? "Session override active" : "API key secured"}</span>
            <span className="sm:hidden">{form.provider === "local" ? "Local" : "Secured"}</span>
          </div>
        </div>
      </header>

      <section className="border-b border-white/10 bg-[#0c0d0c] text-white">
        <div className="mx-auto grid max-w-[1500px] gap-7 px-5 py-10 sm:px-8 md:grid-cols-[1fr_auto] md:items-end lg:px-10 lg:py-14">
          <div>
            <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.28em] text-[#d9ff72]">Director's console / 001</p>
            <h1 className="max-w-4xl font-display text-[clamp(3.25rem,8vw,7.8rem)] uppercase leading-[0.77] tracking-[-0.075em]">
              Make the still
              <span className="block text-white/32">start moving.</span>
            </h1>
          </div>
          <p className="max-w-xs border-l border-[#d9ff72]/50 pl-4 text-xs leading-5 text-white/45 md:mb-1">
            Compose a scene, set the frame, and render native audiovisual motion with MiniMax Hailuo 3.
          </p>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1500px] lg:grid-cols-[minmax(0,0.88fr)_minmax(440px,1.12fr)]">
        <form className="bg-[#f0efe8] px-5 py-8 sm:px-8 lg:px-10 lg:py-10" onSubmit={submit}>
          <div className="mb-8 flex items-center justify-between border-b border-black/10 pb-4">
            <h2 className="font-display text-xl uppercase tracking-[-0.04em]">Scene setup</h2>
            <span className="font-mono text-[9px] tracking-[0.15em] text-stone-400">01—05</span>
          </div>

          <div className="mb-7 grid grid-cols-2 gap-1.5 bg-black/5 p-1.5" aria-label="Generation provider">
            {(["openrouter", "local"] as const).map((provider) => (
              <button
                aria-pressed={form.provider === provider}
                className={`h-12 text-xs font-bold uppercase tracking-[0.12em] transition disabled:cursor-not-allowed disabled:opacity-40 ${form.provider === provider ? "bg-black text-[#d9ff72]" : "text-stone-500 hover:bg-white/60 hover:text-black"}`}
                disabled={submitting || isActive || (provider === "local" && appConfig?.localH3.supported === false)}
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
              Local h3.c requires running this app directly on macOS with Apple Silicon; it is unavailable in Docker.
            </p>
          )}

          {form.provider === "openrouter" && (
          <div className="mb-7 border border-black/12 bg-[#e7e5dc] p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center bg-white/70"><Icon name="lock" /></div>
              <div className="min-w-0 flex-1">
                <FieldLabel htmlFor="session-api-key" optional>Temporary API key</FieldLabel>
                <div className="flex gap-2">
                  <input
                    aria-describedby="session-key-help"
                    autoComplete="off"
                    className="h-11 min-w-0 flex-1 border border-black/15 bg-[#faf9f3] px-3 font-mono text-xs outline-none transition placeholder:text-stone-400 focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
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
                      onClick={() => setSessionApiKey("")}
                      type="button"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-4 text-stone-500" id="session-key-help">
                  Overrides <code>OPENROUTER_API_KEY</code> for this tab. Kept only in memory, sent only to the local backend, and erased when this page closes or reloads.
                </p>
              </div>
            </div>
          </div>
          )}

          <fieldset disabled={submitting || isActive}>
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
                onChange={(event) => updateModel(event.target.value)}
                id="model"
                value={form.model}
              >
                {VIDEO_MODELS.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </div>
            {selectedModel.resolutions.length > 0 && (
              <div>
                <FieldLabel htmlFor="resolution">Resolution</FieldLabel>
                <select
                  className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                  onChange={(event) => setForm((current) => ({ ...current, resolution: event.target.value }))}
                  id="resolution"
                  value={form.resolution}
                >
                  {selectedModel.resolutions.map((resolution) => <option key={resolution}>{resolution}</option>)}
                </select>
              </div>
            )}
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
                    OpenRouter documents public HTTPS image URLs for this endpoint. Local file uploads and base64 are not sent because they are not documented for video generation.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {selectedModel.frameImages.supported.includes("first_frame") && (
                  <div>
                    <FieldLabel htmlFor="first-frame-url" optional>First frame URL</FieldLabel>
                    <input
                      className="h-11 w-full border border-black/15 bg-[#faf9f3] px-3 text-xs outline-none transition placeholder:text-stone-400 focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                      onChange={(event) => setForm((current) => ({ ...current, firstFrameUrl: event.target.value }))}
                      id="first-frame-url"
                      placeholder="https://.../opening.jpg"
                      type="url"
                      value={form.firstFrameUrl}
                    />
                  </div>
                )}
                {selectedModel.frameImages.supported.includes("last_frame") && (
                  <div>
                    <FieldLabel htmlFor="last-frame-url" optional>Last frame URL</FieldLabel>
                    <input
                      className="h-11 w-full border border-black/15 bg-[#faf9f3] px-3 text-xs outline-none transition placeholder:text-stone-400 focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                      onChange={(event) => setForm((current) => ({ ...current, lastFrameUrl: event.target.value }))}
                      id="last-frame-url"
                      placeholder="https://.../closing.jpg"
                      type="url"
                      value={form.lastFrameUrl}
                    />
                  </div>
                )}
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
            <div className="mt-6 border border-black/12 bg-[#e7e5dc] p-4 sm:p-5">
              <div className="mb-5 flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center bg-[#d9ff72] text-black"><Icon name="spark" /></div>
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em]">h3.c on Apple Silicon</h3>
                  <p className="mt-1 text-[11px] leading-4 text-stone-500">
                    {appConfig?.localH3.configured
                      ? "Backend configured. Runs one local job at a time and generates native video with audio."
                      : "Set H3_BINARY and H3_MODEL_DIR on the backend. The h3.c binary, model snapshot, and FFmpeg are required."}
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <FieldLabel htmlFor="local-resolution">Canvas</FieldLabel>
                  <select
                    className="h-11 w-full border border-black/15 bg-[#faf9f3] px-3 text-xs outline-none focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="local-resolution"
                    onChange={(event) => setForm((current) => ({ ...current, localResolution: event.target.value }))}
                    value={form.localResolution}
                  >
                    {LOCAL_H3_RESOLUTIONS.map((resolution) => (
                      <option key={resolution.id} value={resolution.id}>{resolution.label} - {resolution.note}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <FieldLabel htmlFor="local-duration">Clip length</FieldLabel>
                  <select
                    className="h-11 w-full border border-black/15 bg-[#faf9f3] px-3 text-xs outline-none focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="local-duration"
                    onChange={(event) => setForm((current) => ({ ...current, localFrames: Number(event.target.value) }))}
                    value={form.localFrames}
                  >
                    {LOCAL_H3_DURATIONS.map((duration) => (
                      <option key={duration.frames} value={duration.frames}>{duration.label} / {duration.frames} frames</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <FieldLabel htmlFor="local-quality">Quality</FieldLabel>
                  <select
                    className="h-11 w-full border border-black/15 bg-[#faf9f3] px-3 text-xs outline-none focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="local-quality"
                    onChange={(event) => setForm((current) => ({ ...current, localQuality: event.target.value }))}
                    value={form.localQuality}
                  >
                    {LOCAL_H3_QUALITY_PRESETS.map((quality) => (
                      <option key={quality.id} value={quality.id}>{quality.label}</option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[10px] leading-4 text-stone-500">{selectedLocalQuality?.note}</p>
                </div>
                <div>
                  <FieldLabel htmlFor="local-seed">Seed</FieldLabel>
                  <input
                    className="h-11 w-full border border-black/15 bg-[#faf9f3] px-3 font-mono text-xs outline-none focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="local-seed"
                    max={Number.MAX_SAFE_INTEGER}
                    min={0}
                    onChange={(event) => setForm((current) => ({ ...current, localSeed: Number(event.target.value) }))}
                    required
                    type="number"
                    value={form.localSeed}
                  />
                </div>
              </div>

              <label className="mt-5 flex cursor-pointer items-center justify-between border-t border-black/10 pt-4">
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
            </div>
          )}
          </fieldset>

          {error && (
            <div className="mt-5 border-l-4 border-[#e44d38] bg-[#f9dfd9] px-4 py-3 text-sm leading-5 text-[#712519]" role="alert">
              {error}
            </div>
          )}

          <div className="mt-7 flex gap-3">
            <button
              className="group flex h-14 flex-1 items-center justify-between bg-black px-5 font-display text-sm uppercase tracking-[0.02em] text-white transition hover:bg-[#242722] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={submitting || isActive || !form.prompt.trim()}
              type="submit"
            >
              <span>{submitting ? "Submitting..." : isActive ? "Generation active" : form.provider === "local" ? "Generate locally" : "Generate video"}</span>
              <span className="flex size-8 items-center justify-center rounded-full bg-[#d9ff72] text-black transition group-hover:translate-x-1"><Icon name="arrow" /></span>
            </button>
            {(job || error) && (
              <button className="h-14 border border-black/20 px-4 text-[10px] font-bold uppercase tracking-[0.12em] hover:border-black" onClick={clear} type="button">
                {isActive ? "Stop watching" : "Clear"}
              </button>
            )}
          </div>
        </form>

        <section className="flex min-h-[620px] flex-col bg-[#171917] text-white lg:min-h-full">
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
                onMediaError={() => setMediaError("The completed video could not be loaded in the player. Try downloading it instead.")}
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
                <span>{isActive ? "Polling every 10 seconds" : "Output controls unlock on completion"}</span>
                {typeof job?.cost === "number" && <span>Cost ${job.cost.toFixed(4)}</span>}
              </div>
            )}
            {job?.status === "completed" && typeof job.cost === "number" && (
              <p className="mt-3 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-white/35">OpenRouter cost ${job.cost.toFixed(4)}</p>
            )}
          </div>
        </section>
      </div>

      <footer className="border-t border-white/10 bg-[#0c0d0c] px-5 py-5 text-white/30 sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-[1420px] flex-col gap-2 font-mono text-[9px] uppercase tracking-[0.15em] sm:flex-row sm:items-center sm:justify-between">
          <span>Local interface / server-side credentials</span>
          <span>OpenRouter asynchronous video API</span>
        </div>
      </footer>
    </main>
  );
}
