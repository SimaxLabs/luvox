import { type ChangeEvent, type Dispatch, type FormEvent, type ReactNode, type SetStateAction, useEffect, useRef, useState } from "react";
import { getVideoModel, VIDEO_MODELS } from "../shared/videoModels";
import { getMfluxImageModel, getMfluxImageResolution, MFLUX_IMAGE_MODEL, MFLUX_IMAGE_MODELS, MFLUX_IMAGE_QUANTIZATIONS, MFLUX_IMAGE_RECOMMENDED_SETUPS, MFLUX_IMAGE_RESOLUTIONS, MFLUX_VAE_TILE_SIZES, MUSE_IMAGE_MODEL } from "../shared/imageModels";
import {
  getLocalH3QualityPreset,
  isLocalH3AccelerationAvailable,
  LOCAL_H3_ACCELERATION_PRESETS,
  LOCAL_H3_DURATIONS,
  LOCAL_H3_FRAME_FITS,
  LOCAL_H3_QUALITY_PRESETS,
  LOCAL_H3_RECOMMENDED_SETUPS,
  LOCAL_H3_RESOLUTIONS,
  type LocalH3FrameFitId,
} from "../shared/localH3";
import {
  ApiError,
  deleteLocalVideoJob,
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
  type LocalMfluxProgress,
  type VideoJob,
} from "./api";

type Workflow = "video" | "image";
type VideoProvider = "openrouter" | "local";
type ImageProvider = "openrouter" | "mflux";
type SubmissionKind = "image" | "mflux" | VideoProvider;

interface FormState {
  provider: VideoProvider;
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
  localAcceleration: string;
  localSeed: number;
  localFirstFramePath: string;
  localLastFramePath: string;
  localFrameFit: LocalH3FrameFitId;
  localSsdStreaming: boolean;
}

interface DisplayJob extends VideoJob {
  aspectRatio?: string;
  temporaryApiKey?: string;
  pollWarning?: string;
  pollingStopped?: boolean;
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
const defaultMfluxSetup = MFLUX_IMAGE_RECOMMENDED_SETUPS[0];
const imageReferenceMaxBytes = 10 * 1024 * 1024;
const uncertainSubmissionMessage = "OpenRouter may already be processing a paid request that Motio cannot track. Check OpenRouter Activity before unlocking another submission.";
const uncertainLocalSubmissionMessage = "The local h3.c submission may have been accepted but Motio did not receive its job ID. Clear the workspace before submitting another local job.";
const uncertainMfluxSubmissionMessage = "The local MFLUX request status is unknown. Clear the workspace before submitting another local MFLUX image.";
const untrackedRemoteWork = "__motio_untracked_remote_work__";
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
    localAcceleration: "standard",
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
    <p className="flex min-h-72 items-center justify-center px-6 text-center font-mono text-[10px] uppercase tracking-[0.15em] text-white/60">
      Generated video preview will appear here
    </p>
  );
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function formatSeconds(value?: number): string {
  if (value === undefined) return "Estimating";
  const seconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

function getImageTaskStatus(
  submitting: boolean,
  result: ImageGenerationResponse | null,
  failure: string | null,
): GenerationStatus | "unknown" | null {
  if (submitting) return "processing";
  if (result) return "completed";
  if (failure === uncertainSubmissionMessage || failure === uncertainMfluxSubmissionMessage) return "unknown";
  return failure ? "failed" : null;
}

function JobPoller({
  job,
  localWorkspaceToken,
  remoteWork,
  setAnnouncement,
  setJobs,
  workspaceVersion,
}: {
  job: DisplayJob;
  localWorkspaceToken: string;
  remoteWork: { current: Set<string> };
  setAnnouncement: Dispatch<SetStateAction<string>>;
  setJobs: Dispatch<SetStateAction<DisplayJob[]>>;
  workspaceVersion: { current: number };
}) {
  const { id, provider, temporaryApiKey } = job;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let consecutiveFailures = 0;
    const controller = new AbortController();
    const version = workspaceVersion.current;

    const poll = async () => {
      try {
        const nextJob = await getVideoStatus(
          id,
          temporaryApiKey,
          controller.signal,
          provider === "local" ? localWorkspaceToken : undefined,
        );
        if (disposed || version !== workspaceVersion.current) return;

        consecutiveFailures = 0;
        setJobs((current) => current.map((existing) => existing.id === id
          ? {
              ...nextJob,
              aspectRatio: existing.aspectRatio,
              temporaryApiKey: nextJob.status === "failed" ? undefined : existing.temporaryApiKey,
              pollWarning: undefined,
              pollingStopped: false,
            }
          : existing));

        if (nextJob.status === "completed" || nextJob.status === "failed") {
          remoteWork.current.delete(id);
          setAnnouncement(`${provider === "local" ? "Local h3.c" : "OpenRouter"} job ${id.slice(0, 12)} ${nextJob.status}.`);
          return;
        }

        timer = setTimeout(poll, 10_000);
      } catch (pollError) {
        if (disposed || controller.signal.aborted || version !== workspaceVersion.current) return;

        const apiError = pollError instanceof ApiError ? pollError : null;
        if (provider === "local" && apiError?.status === 404) {
          setJobs((current) => current.map((existing) => existing.id === id
            ? { ...existing, status: "failed", error: apiError.message }
            : existing));
          setAnnouncement(`Local h3.c job ${id.slice(0, 12)} failed.`);
          return;
        }

        if (apiError && !apiError.retryable) {
          setJobs((current) => current.map((existing) => existing.id === id
            ? {
                ...existing,
                pollingStopped: true,
                pollWarning: `${apiError.message} Automatic status checks stopped${provider === "openrouter" ? "; verify the job in OpenRouter Activity before clearing it" : ""}.`,
              }
            : existing));
          return;
        }

        consecutiveFailures += 1;
        const retryDelay = apiError?.retryAfterSeconds
          ? apiError.retryAfterSeconds * 1000
          : Math.min(30_000, 5_000 * 2 ** (consecutiveFailures - 1));
        setJobs((current) => current.map((existing) => existing.id === id
          ? { ...existing, pollWarning: `${messageFrom(pollError)} Generation status is unknown; retrying automatically.` }
          : existing));
        timer = setTimeout(poll, retryDelay);
      }
    };

    timer = setTimeout(poll, 3_000);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, localWorkspaceToken, provider, remoteWork, setAnnouncement, setJobs, temporaryApiKey, workspaceVersion]);

  return null;
}

export default function App() {
  const [workflow, setWorkflow] = useState<Workflow>("video");
  const [form, setForm] = useState<FormState>(initialForm);
  const [imageProvider, setImageProvider] = useState<ImageProvider>("openrouter");
  const [mfluxModel, setMfluxModel] = useState<string>(MFLUX_IMAGE_MODEL.id);
  const [mfluxResolution, setMfluxResolution] = useState<string>(defaultMfluxSetup.resolution);
  const [mfluxSteps, setMfluxSteps] = useState<number>(defaultMfluxSetup.steps);
  const [mfluxQuantization, setMfluxQuantization] = useState<number | null>(defaultMfluxSetup.quantization);
  const [mfluxSeed, setMfluxSeed] = useState("");
  const [mfluxLowRam, setMfluxLowRam] = useState<boolean>(defaultMfluxSetup.lowRam);
  const [mfluxVaeTiling, setMfluxVaeTiling] = useState<boolean>(defaultMfluxSetup.vaeTiling);
  const [mfluxVaeTileSize, setMfluxVaeTileSize] = useState<number>(defaultMfluxSetup.vaeTileSize);
  const [mfluxGuidance, setMfluxGuidance] = useState<number>(defaultMfluxSetup.guidance);
  const [mfluxImageStrength, setMfluxImageStrength] = useState<number>(defaultMfluxSetup.imageStrength);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageReference, setImageReference] = useState<{ name: string; dataUrl: string } | null>(null);
  const [readingImageReference, setReadingImageReference] = useState(false);
  const [imageResult, setImageResult] = useState<ImageGenerationResponse | null>(null);
  const [imageFailure, setImageFailure] = useState<string | null>(null);
  const [mfluxImageResult, setMfluxImageResult] = useState<ImageGenerationResponse | null>(null);
  const [mfluxImageFailure, setMfluxImageFailure] = useState<string | null>(null);
  const [openRouterSubmissionFailure, setOpenRouterSubmissionFailure] = useState<string | null>(null);
  const [localSubmissionFailure, setLocalSubmissionFailure] = useState<string | null>(null);
  const [jobs, setJobs] = useState<DisplayJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [imageSubmitting, setImageSubmitting] = useState(false);
  const [mfluxImageSubmitting, setMfluxImageSubmitting] = useState(false);
  const [mfluxProgress, setMfluxProgress] = useState<LocalMfluxProgress | null>(null);
  const [mfluxElapsedSeconds, setMfluxElapsedSeconds] = useState(0);
  const [openRouterSubmitting, setOpenRouterSubmitting] = useState(false);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRouterImageUncertain, setOpenRouterImageUncertain] = useState(false);
  const [openRouterVideoUncertain, setOpenRouterVideoUncertain] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaRetry, setMediaRetry] = useState(0);
  const [sessionApiKey, setSessionApiKey] = useState("");
  const [temporaryVideoUrl, setTemporaryVideoUrl] = useState<string | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [uploadingReference, setUploadingReference] = useState<"first" | "last" | null>(null);
  const [referenceUploadStatus, setReferenceUploadStatus] = useState("");
  const [localAdvancedStatus, setLocalAdvancedStatus] = useState("");
  const [mfluxAdvancedStatus, setMfluxAdvancedStatus] = useState("");
  const [clearingWorkspace, setClearingWorkspace] = useState(false);
  const [removingJobId, setRemovingJobId] = useState<string | null>(null);
  const [localCleanupFailed, setLocalCleanupFailed] = useState(false);
  const [jobAnnouncement, setJobAnnouncement] = useState("");
  const [referenceUploadTokens, setReferenceUploadTokens] = useState<Partial<Record<"first" | "last", string>>>({});
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationControllers = useRef(new Map<SubmissionKind, AbortController>());
  const cancelledSubmissions = useRef(new Set<SubmissionKind>());
  const removingJobIdRef = useRef<string | null>(null);
  const localWorkspaceToken = useRef(crypto.randomUUID());
  const pendingLocalWorkspaceDiscards = useRef(new Set<string>());
  const remoteImageWork = useRef(new Set<string>());
  const remoteVideoWork = useRef(new Set<string>());
  const selectionVersion = useRef(0);
  const firstFramePathOnFocus = useRef("");
  const lastFramePathOnFocus = useRef("");
  const mfluxStartedAt = useRef(0);
  const serverSession = useRef<string | null>(null);
  const serviceState = useRef<"unknown" | "online" | "offline">("unknown");
  const workspaceVersion = useRef(0);

  const selectedModel = getVideoModel(form.model) ?? VIDEO_MODELS[0];
  const selectedMfluxModel = getMfluxImageModel(mfluxModel) ?? MFLUX_IMAGE_MODEL;
  const selectedMfluxResolution = getMfluxImageResolution(mfluxResolution) ?? MFLUX_IMAGE_RESOLUTIONS[0];
  const mfluxVaeTilingEnabled = mfluxLowRam || mfluxVaeTiling;
  const mfluxResolutionOptions = MFLUX_IMAGE_RESOLUTIONS.filter((resolution, index, resolutions) =>
    resolutions.findIndex((candidate) => candidate.label === resolution.label) === index);
  const mfluxAspectRatioOptions = MFLUX_IMAGE_RESOLUTIONS.filter((resolution, index, resolutions) =>
    resolutions.findIndex((candidate) => candidate.aspectRatio === resolution.aspectRatio) === index);
  const mfluxRecommendedSetups = MFLUX_IMAGE_RECOMMENDED_SETUPS.filter((setup) =>
    (setup.models as readonly string[]).includes(selectedMfluxModel.id));
  const selectedLocalQuality = getLocalH3QualityPreset(form.localQuality);
  const selectedLocalResolution = LOCAL_H3_RESOLUTIONS.find((resolution) => resolution.id === form.localResolution) ?? LOCAL_H3_RESOLUTIONS[0];
  const localResolutionOptions = LOCAL_H3_RESOLUTIONS.filter((resolution, index, resolutions) =>
    resolutions.findIndex((candidate) => candidate.label === resolution.label) === index);
  const localAspectRatioOptions = LOCAL_H3_RESOLUTIONS.filter((resolution, index, resolutions) =>
    resolutions.findIndex((candidate) => candidate.aspectRatio === resolution.aspectRatio) === index);
  const job = jobs.find((candidate) => candidate.id === selectedJobId) ?? null;
  const isActive = job?.status === "queued" || job?.status === "processing";
  const hasActiveOpenRouterJob = jobs.some((candidate) => candidate.provider === "openrouter" && (candidate.status === "queued" || candidate.status === "processing"));
  const hasActiveLocalJob = jobs.some((candidate) => candidate.provider === "local" && (candidate.status === "queued" || candidate.status === "processing"));
  const currentSubmissionKind: SubmissionKind = workflow === "image"
    ? imageProvider === "openrouter" ? "image" : "mflux"
    : form.provider;
  const mfluxSubmissionUncertain = mfluxImageFailure === uncertainMfluxSubmissionMessage;
  const currentSubmissionUncertain = currentSubmissionKind === "image"
    ? openRouterImageUncertain
    : currentSubmissionKind === "openrouter"
      ? openRouterVideoUncertain
      : currentSubmissionKind === "mflux"
        ? mfluxSubmissionUncertain
        : false;
  const currentSubmissionKindRef = useRef(currentSubmissionKind);
  currentSubmissionKindRef.current = currentSubmissionKind;
  const selectedJobIdRef = useRef(selectedJobId);
  selectedJobIdRef.current = selectedJobId;
  const submitting = imageSubmitting || mfluxImageSubmitting || openRouterSubmitting || localSubmitting;
  const currentSubmitting = currentSubmissionKind === "image"
    ? imageSubmitting
    : currentSubmissionKind === "mflux"
      ? mfluxImageSubmitting
    : currentSubmissionKind === "openrouter"
      ? openRouterSubmitting
      : localSubmitting;
  const currentVideoActive = form.provider === "openrouter" ? hasActiveOpenRouterJob : hasActiveLocalJob;
  const currentVideoUnknown = form.provider === "local" && localSubmissionFailure === uncertainLocalSubmissionMessage;
  const currentVideoLocked = currentVideoActive || currentVideoUnknown;
  const hasUnknownSubmission = openRouterImageUncertain || openRouterVideoUncertain || mfluxSubmissionUncertain || localSubmissionFailure === uncertainLocalSubmissionMessage;
  const openRouterImageTaskStatus = getImageTaskStatus(imageSubmitting, imageResult, imageFailure);
  const mfluxImageTaskStatus = getImageTaskStatus(mfluxImageSubmitting, mfluxImageResult, mfluxImageFailure);
  const imageTaskStatus = imageProvider === "openrouter" ? openRouterImageTaskStatus : mfluxImageTaskStatus;
  const currentImageResult = imageProvider === "openrouter" ? imageResult : mfluxImageResult;
  const currentImageFailure = imageProvider === "openrouter" ? imageFailure : mfluxImageFailure;
  const currentImageModel = imageProvider === "openrouter" ? MUSE_IMAGE_MODEL : selectedMfluxModel;
  const selectedMfluxModelAvailable = appConfig?.localMflux.models.includes(selectedMfluxModel.id) === true;
  const openRouterSubmissionStatus = openRouterSubmitting
    ? "submitting"
    : openRouterSubmissionFailure === uncertainSubmissionMessage
      ? "unknown"
      : openRouterSubmissionFailure
        ? "failed"
        : null;
  const localSubmissionStatus = localSubmitting
    ? "submitting"
    : localSubmissionFailure === uncertainLocalSubmissionMessage
      ? "unknown"
      : localSubmissionFailure
        ? "failed"
        : null;
  const currentVideoSubmissionStatus = form.provider === "openrouter"
    ? openRouterSubmissionStatus
    : localSubmissionStatus;
  const sessionItemCount = jobs.length
    + Number(Boolean(openRouterImageTaskStatus))
    + Number(Boolean(mfluxImageTaskStatus))
    + Number(Boolean(openRouterSubmissionStatus))
    + Number(Boolean(localSubmissionStatus));
  const activeJobCount = jobs.filter((candidate) => candidate.status === "queued" || candidate.status === "processing").length
    + Number(imageSubmitting)
    + Number(mfluxImageSubmitting)
    + Number(openRouterSubmitting)
    + Number(localSubmitting);
  const hasActiveJobs = activeJobCount > 0;
  const jobApiKey = job?.provider === "openrouter" ? job.temporaryApiKey : undefined;
  const pollWarning = job?.pollWarning;
  const pollingStopped = Boolean(job?.pollingStopped);
  const usesSessionMedia = Boolean(job && (job.provider === "local" || jobApiKey));
  const videoSource = usesSessionMedia ? temporaryVideoUrl || undefined : job?.videoUrl;
  const downloadSource = usesSessionMedia ? temporaryVideoUrl || undefined : job?.downloadUrl;
  const imageSource = currentImageResult
    ? `data:${currentImageResult.mediaType};base64,${currentImageResult.b64Json}`
    : undefined;
  const imageExtension = currentImageResult?.mediaType === "image/jpeg"
    ? "jpg"
    : currentImageResult?.mediaType.split("/")[1] || "png";

  const selectLocalResolution = (localResolution: string) => {
    const resetAcceleration = !isLocalH3AccelerationAvailable(form.localAcceleration, localResolution, form.localQuality);
    setForm((current) => ({
      ...current,
      localResolution,
      localAcceleration: resetAcceleration ? "standard" : current.localAcceleration,
    }));
    setLocalAdvancedStatus(resetAcceleration ? "Acceleration reset to Standard for the selected resolution." : "");
  };

  const applyMfluxSetup = (setup: (typeof MFLUX_IMAGE_RECOMMENDED_SETUPS)[number]) => {
    setMfluxResolution(setup.resolution);
    setMfluxSteps(setup.steps);
    setMfluxQuantization(setup.quantization);
    setMfluxSeed("");
    setMfluxLowRam(setup.lowRam);
    setMfluxVaeTiling(setup.vaeTiling);
    setMfluxVaeTileSize(setup.vaeTileSize);
    setMfluxGuidance(setup.guidance);
    setMfluxImageStrength(setup.imageStrength);
    setMfluxAdvancedStatus(`${setup.label} setup applied.`);
  };

  const leaveJobView = () => {
    selectionVersion.current += 1;
    if (copyTimer.current) {
      clearTimeout(copyTimer.current);
      copyTimer.current = null;
    }
    setSelectedJobId(null);
    setTemporaryVideoUrl(null);
    setCopied(false);
    setMediaError(null);
    setMediaLoading(false);
    setMediaRetry(0);
  };

  const viewJob = (nextJob: DisplayJob) => {
    leaveJobView();
    setSelectedJobId(nextJob.id);
    setWorkflow("video");
    setForm((current) => ({ ...current, provider: nextJob.provider }));
    setError(null);
  };

  const viewImageTask = (provider: ImageProvider) => {
    leaveJobView();
    setWorkflow("image");
    setImageProvider(provider);
    setError(provider === "openrouter" ? imageFailure : mfluxImageFailure);
  };

  const viewVideoSubmission = (provider: VideoProvider) => {
    leaveJobView();
    setWorkflow("video");
    setForm((current) => ({ ...current, provider }));
    setError(provider === "openrouter" ? openRouterSubmissionFailure : localSubmissionFailure);
  };

  const resetWorkspace = (preserveImageSubmissionLock: boolean, preserveVideoSubmissionLock: boolean) => {
    workspaceVersion.current += 1;
    for (const controller of generationControllers.current.values()) controller.abort();
    generationControllers.current.clear();
    cancelledSubmissions.current.clear();
    removingJobIdRef.current = null;
    leaveJobView();
    setWorkflow("video");
    setForm(initialForm());
    setImageProvider("openrouter");
    setMfluxModel(MFLUX_IMAGE_MODEL.id);
    setMfluxResolution(defaultMfluxSetup.resolution);
    setMfluxSteps(defaultMfluxSetup.steps);
    setMfluxQuantization(defaultMfluxSetup.quantization);
    setMfluxSeed("");
    setMfluxLowRam(defaultMfluxSetup.lowRam);
    setMfluxVaeTiling(defaultMfluxSetup.vaeTiling);
    setMfluxVaeTileSize(defaultMfluxSetup.vaeTileSize);
    setMfluxGuidance(defaultMfluxSetup.guidance);
    setMfluxImageStrength(defaultMfluxSetup.imageStrength);
    setImagePrompt("");
    setImageReference(null);
    setReadingImageReference(false);
    setImageResult(null);
    setImageFailure(preserveImageSubmissionLock ? uncertainSubmissionMessage : null);
    setMfluxImageResult(null);
    setMfluxImageFailure(null);
    setOpenRouterSubmissionFailure(preserveVideoSubmissionLock ? uncertainSubmissionMessage : null);
    setLocalSubmissionFailure(null);
    setJobs([]);
    setImageSubmitting(false);
    setMfluxImageSubmitting(false);
    setMfluxProgress(null);
    setMfluxElapsedSeconds(0);
    setOpenRouterSubmitting(false);
    setLocalSubmitting(false);
    setError(preserveVideoSubmissionLock ? uncertainSubmissionMessage : null);
    setOpenRouterImageUncertain(preserveImageSubmissionLock);
    setOpenRouterVideoUncertain(preserveVideoSubmissionLock);
    remoteImageWork.current.clear();
    remoteVideoWork.current.clear();
    if (preserveImageSubmissionLock) remoteImageWork.current.add(untrackedRemoteWork);
    if (preserveVideoSubmissionLock) remoteVideoWork.current.add(untrackedRemoteWork);
    setUploadingReference(null);
    setReferenceUploadStatus("");
    setLocalAdvancedStatus("");
    setMfluxAdvancedStatus("");
    setReferenceUploadTokens({});
    setClearingWorkspace(false);
    setRemovingJobId(null);
    setLocalCleanupFailed(false);
    setJobAnnouncement("");
    firstFramePathOnFocus.current = "";
    lastFramePathOnFocus.current = "";
  };

  useEffect(() => {
    if (!mfluxImageSubmitting) return;
    const update = () => setMfluxElapsedSeconds(Math.floor((Date.now() - mfluxStartedAt.current) / 1_000));
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [mfluxImageSubmitting]);

  useEffect(() => {
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
        if (serverSession.current && serverSession.current !== config.sessionId) {
          pendingLocalWorkspaceDiscards.current.add(localWorkspaceToken.current);
          localWorkspaceToken.current = crypto.randomUUID();
          resetWorkspace(remoteImageWork.current.size > 0, remoteVideoWork.current.size > 0);
          serverSession.current = config.sessionId;
          setAppConfig(null);
        }
        let cleanupPending = false;
        for (const token of pendingLocalWorkspaceDiscards.current) {
          try {
            await discardLocalWorkspace(token, false, requestController.signal);
            pendingLocalWorkspaceDiscards.current.delete(token);
          } catch {
            cleanupPending = true;
            break;
          }
        }
        if (disposed || cleanupPending) return;
        consecutiveFailures = 0;
        firstFailureAt = 0;
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
          pendingLocalWorkspaceDiscards.current.add(localWorkspaceToken.current);
          localWorkspaceToken.current = crypto.randomUUID();
          resetWorkspace(remoteImageWork.current.size > 0, remoteVideoWork.current.size > 0);
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
      for (const generationController of generationControllers.current.values()) generationController.abort();
      generationControllers.current.clear();
      controller?.abort();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const discardOnPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        for (const token of new Set([
          ...pendingLocalWorkspaceDiscards.current,
          localWorkspaceToken.current,
        ])) {
          void discardLocalWorkspace(token, true).catch(() => undefined);
        }
      }
    };
    window.addEventListener("pagehide", discardOnPageHide);
    return () => window.removeEventListener("pagehide", discardOnPageHide);
  }, []);

  useEffect(() => {
    setTemporaryVideoUrl(null);
    setMediaError(null);
    setMediaLoading(false);

    if (
      workflow !== "video" ||
      job?.status !== "completed" ||
      !job.videoUrl ||
      (job.provider === "openrouter" && !jobApiKey)
    ) {
      return;
    }

    const key = jobApiKey;
    const version = workspaceVersion.current;
    const selectedVersion = selectionVersion.current;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let disposed = false;
    setMediaLoading(true);

    void getVideoContent(
      job.videoUrl,
      key,
      controller.signal,
      job.provider === "local" ? localWorkspaceToken.current : undefined,
    )
      .then((blob) => {
        if (
          disposed ||
          version !== workspaceVersion.current ||
          selectedVersion !== selectionVersion.current
        ) return;
        objectUrl = URL.createObjectURL(blob);
        setTemporaryVideoUrl(objectUrl);
      })
      .catch((contentError) => {
        if (
          !controller.signal.aborted &&
          version === workspaceVersion.current &&
          selectedVersion === selectionVersion.current
        ) {
          setMediaError(messageFrom(contentError));
        }
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          version === workspaceVersion.current &&
          selectedVersion === selectionVersion.current
        ) setMediaLoading(false);
      });

    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workflow, job?.id, job?.status, job?.videoUrl, jobApiKey, mediaRetry]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!submitting && !hasActiveJobs && !hasUnknownSubmission) return;

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [submitting, hasActiveJobs, hasUnknownSubmission]);

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
      void deleteLocalReferenceImage(token, localWorkspaceToken.current).catch(() => undefined);
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
    const workspaceToken = localWorkspaceToken.current;
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
      const upload = () => uploadLocalReferenceImage(
        file,
        uploadToken,
        workspaceToken,
        previousToken,
      );
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
        void deleteLocalReferenceImage(result.token, workspaceToken).catch(() => undefined);
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
    const submissionKind = currentSubmissionKind;
    const isImageSubmission = submissionKind === "image" || submissionKind === "mflux";
    const isPaidSubmission = submissionKind === "image" || submissionKind === "openrouter";
    if (
      generationControllers.current.has(submissionKind) ||
      currentSubmissionUncertain ||
      readingImageReference ||
      (workflow === "image" && imageProvider === "mflux" && selectedMfluxModel.requiresReference && !imageReference) ||
      (clearingWorkspace && workflow === "video" && form.provider === "local") ||
      (localCleanupFailed && workflow === "video" && form.provider === "local") ||
      (workflow === "video" && currentVideoLocked)
    ) return;

    const requestController = new AbortController();
    generationControllers.current.set(submissionKind, requestController);
    const pendingRemoteSubmission = `__motio_pending_submission_${crypto.randomUUID()}__`;
    const paidRemoteWork = submissionKind === "image" ? remoteImageWork.current : remoteVideoWork.current;
    if (isPaidSubmission) paidRemoteWork.add(pendingRemoteSubmission);
    const version = workspaceVersion.current;
    let submittedSelectionVersion = selectionVersion.current;
    if (!isImageSubmission) {
      leaveJobView();
      submittedSelectionVersion = selectionVersion.current;
      if (submissionKind === "openrouter") {
        setOpenRouterSubmitting(true);
        setOpenRouterSubmissionFailure(null);
      } else {
        setLocalSubmitting(true);
        setLocalSubmissionFailure(null);
      }
      setJobAnnouncement(`${submissionKind === "openrouter" ? "OpenRouter" : "Local h3.c"} video submission started.`);
    } else if (submissionKind === "image") {
      setImageSubmitting(true);
      setImageFailure(null);
      setJobAnnouncement("Meta Muse image started.");
    } else {
      mfluxStartedAt.current = Date.now();
      setMfluxElapsedSeconds(0);
      setMfluxProgress({ phase: "loading", step: 0, total: mfluxSteps, percent: 0 });
      setMfluxImageSubmitting(true);
      setMfluxImageFailure(null);
      setJobAnnouncement("Local MFLUX image started.");
    }
    setError(null);

    try {
      const key = sessionApiKey.trim();
      if (isImageSubmission) {
        const isMflux = submissionKind === "mflux";
        if (isMflux) setMfluxImageResult(null);
        else setImageResult(null);
        const result = isMflux
          ? await generateImage({
              provider: "mflux",
              prompt: imagePrompt,
              model: selectedMfluxModel.id,
              resolution: mfluxResolution,
              steps: mfluxSteps,
              quantization: mfluxQuantization,
              seed: mfluxSeed ? Number(mfluxSeed) : undefined,
              lowRam: mfluxLowRam,
              vaeTiling: mfluxVaeTiling,
              vaeTileSize: mfluxVaeTileSize,
              guidance: selectedMfluxModel.id === "qwen-image-edit" ? mfluxGuidance : undefined,
              imageStrength: mfluxImageStrength,
              inputReference: imageReference?.dataUrl,
            }, undefined, requestController.signal, (progress) => {
              if (version === workspaceVersion.current) setMfluxProgress(progress);
            })
          : await generateImage({
              provider: "openrouter",
              prompt: imagePrompt,
              model: MUSE_IMAGE_MODEL.id,
              inputReference: imageReference?.dataUrl,
            }, key || undefined, requestController.signal);
        if (version !== workspaceVersion.current) return;
        if (isPaidSubmission) paidRemoteWork.delete(pendingRemoteSubmission);
        if (isMflux) setMfluxImageResult(result);
        else setImageResult(result);
        setJobAnnouncement(`${isMflux ? "Local MFLUX" : "Meta Muse"} image completed.`);
        return;
      }

      const nextJob = form.provider === "local"
        ? await generateVideo({
            provider: "local",
            prompt: form.prompt,
            resolution: form.localResolution,
            frames: form.localFrames,
            quality: form.localQuality,
            acceleration: form.localAcceleration,
            seed: form.localSeed,
            firstFramePath: form.localFirstFramePath || undefined,
            lastFramePath: form.localLastFramePath || undefined,
            frameFit: form.localFrameFit,
            ssdStreaming: form.localSsdStreaming,
          }, undefined, requestController.signal, localWorkspaceToken.current)
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
      paidRemoteWork.delete(pendingRemoteSubmission);
      if (
        nextJob.provider === "openrouter" &&
        (nextJob.status === "queued" || nextJob.status === "processing")
      ) remoteVideoWork.current.add(nextJob.id);
      const trackedJob: DisplayJob = {
        ...nextJob,
        temporaryApiKey:
          nextJob.provider === "openrouter" && nextJob.status !== "failed"
            ? key || undefined
            : undefined,
        aspectRatio:
          form.provider === "local"
            ? selectedLocalResolution.aspectRatio
            : form.aspectRatio,
      };
      setJobs((current) => [trackedJob, ...current.filter((existing) => existing.id !== trackedJob.id)]);
      if (
        submittedSelectionVersion === selectionVersion.current &&
        currentSubmissionKindRef.current === submissionKind
      ) setSelectedJobId(trackedJob.id);
      setJobAnnouncement(`${trackedJob.provider === "local" ? "Local h3.c" : "OpenRouter"} job ${trackedJob.id.slice(0, 12)} ${trackedJob.status}.`);
    } catch (submitError) {
      if (version !== workspaceVersion.current) return;
      if (requestController.signal.aborted && cancelledSubmissions.current.delete(submissionKind)) {
        if (submissionKind === "mflux") {
          setMfluxImageResult(null);
          setMfluxImageFailure(uncertainMfluxSubmissionMessage);
          setMfluxProgress(null);
          setMfluxElapsedSeconds(0);
          setError(uncertainMfluxSubmissionMessage);
          setJobAnnouncement("Local MFLUX stop requested; status unknown until Clear.");
        }
        return;
      }
      const apiError = submitError instanceof ApiError ? submitError : null;
      const outcomeIsUnknown = (
        apiError?.status === 0 ||
        Boolean(apiError?.type && uncertainSubmissionErrors.has(apiError.type))
      );
      const submissionIsUncertain = isPaidSubmission && outcomeIsUnknown;
      const mfluxSubmissionIsUncertain = submissionKind === "mflux" && outcomeIsUnknown;
      const localSubmissionIsUncertain = submissionKind === "local" && outcomeIsUnknown;
      if (submissionIsUncertain) {
        if (submissionKind === "image") {
          setOpenRouterImageUncertain(true);
          setImageFailure(uncertainSubmissionMessage);
        } else {
          setOpenRouterVideoUncertain(true);
          setOpenRouterSubmissionFailure(uncertainSubmissionMessage);
        }
        if (currentSubmissionKindRef.current === submissionKind) setError(uncertainSubmissionMessage);
      } else if (mfluxSubmissionIsUncertain) {
        setMfluxImageFailure(uncertainMfluxSubmissionMessage);
        if (currentSubmissionKindRef.current === submissionKind) setError(uncertainMfluxSubmissionMessage);
      } else if (localSubmissionIsUncertain) {
        setLocalSubmissionFailure(uncertainLocalSubmissionMessage);
        if (currentSubmissionKindRef.current === submissionKind) setError(uncertainLocalSubmissionMessage);
      } else {
        if (isPaidSubmission) paidRemoteWork.delete(pendingRemoteSubmission);
        const message = messageFrom(submitError);
        if (submissionKind === "image") setImageFailure(message);
        else if (submissionKind === "mflux") setMfluxImageFailure(message);
        else if (submissionKind === "openrouter") setOpenRouterSubmissionFailure(message);
        else setLocalSubmissionFailure(message);
        if (currentSubmissionKindRef.current === submissionKind) setError(message);
      }
      const submissionLabel = submissionKind === "image"
        ? "Meta Muse image"
        : submissionKind === "mflux"
          ? "Local MFLUX image"
        : submissionKind === "openrouter"
          ? "OpenRouter video submission"
          : "Local h3.c submission";
      setJobAnnouncement(`${submissionLabel} ${submissionIsUncertain || mfluxSubmissionIsUncertain || localSubmissionIsUncertain ? "status unknown" : "failed"}.`);
    } finally {
      if (generationControllers.current.get(submissionKind) === requestController) {
        generationControllers.current.delete(submissionKind);
        cancelledSubmissions.current.delete(submissionKind);
        if (version === workspaceVersion.current) {
          if (submissionKind === "image") setImageSubmitting(false);
          else if (submissionKind === "mflux") setMfluxImageSubmitting(false);
          else if (submissionKind === "openrouter") setOpenRouterSubmitting(false);
          else setLocalSubmitting(false);
        }
      }
    }
  };

  const stopMfluxImage = () => {
    const controller = generationControllers.current.get("mflux");
    if (!controller || !window.confirm("Abort this local MFLUX generation?")) return;
    cancelledSubmissions.current.add("mflux");
    controller.abort();
    setJobAnnouncement("Stopping local MFLUX image.");
  };

  const deleteImageTask = () => {
    if (!currentImageResult || !window.confirm("Delete this completed image from the session?")) return;
    if (imageProvider === "mflux") {
      setMfluxImageResult(null);
      setMfluxImageFailure(null);
      setMfluxProgress(null);
      setMfluxElapsedSeconds(0);
    } else {
      setImageResult(null);
      setImageFailure(null);
    }
    setError(null);
    setJobAnnouncement(`${imageProvider === "mflux" ? "Local MFLUX" : "Meta Muse"} image deleted.`);
  };

  const removeVideoJob = async (target: DisplayJob) => {
    const active = target.status === "queued" || target.status === "processing";
    if (removingJobIdRef.current || (active && target.provider !== "local") || (target.status !== "completed" && !active)) return;
    const action = active ? "Abort this local h3.c job?" : "Delete this completed video job?";
    if (!window.confirm(action)) return;

    const version = workspaceVersion.current;
    removingJobIdRef.current = target.id;
    setRemovingJobId(target.id);
    try {
      if (target.provider === "local") await deleteLocalVideoJob(target.id, localWorkspaceToken.current);
      if (version !== workspaceVersion.current) return;
      remoteVideoWork.current.delete(target.id);
      setJobs((current) => current.filter((candidate) => candidate.id !== target.id));
      if (selectedJobIdRef.current === target.id) {
        leaveJobView();
        setError(null);
      }
      setJobAnnouncement(`${target.provider === "local" ? "Local h3.c" : "OpenRouter"} job ${active ? "aborted" : "deleted"}.`);
    } catch (removeError) {
      if (version === workspaceVersion.current && selectedJobIdRef.current === target.id) setError(messageFrom(removeError));
    } finally {
      if (removingJobIdRef.current === target.id) removingJobIdRef.current = null;
      if (version === workspaceVersion.current) setRemovingJobId(null);
    }
  };

  const clear = () => {
    if (submitting || clearingWorkspace || removingJobId || uploadingReference !== null || readingImageReference) return;
    if (
      (openRouterImageUncertain || openRouterVideoUncertain) &&
      !window.confirm("OpenRouter may already be processing this request. Check OpenRouter Activity first. Unlock another paid submission anyway?")
    ) return;
    if (
      hasActiveJobs &&
      !window.confirm(`Clear the workspace and stop watching ${activeJobCount} active ${activeJobCount === 1 ? "job" : "jobs"}?${hasActiveOpenRouterJob ? " OpenRouter work may continue in the background." : ""}`)
    ) {
      return;
    }
    const selectedWorkflow = workflow;
    const selectedProvider = form.provider;
    const selectedImageProvider = imageProvider;
    resetWorkspace(false, false);
    setWorkflow(selectedWorkflow);
    setForm((current) => ({ ...current, provider: selectedProvider }));
    setImageProvider(selectedImageProvider);
    const version = workspaceVersion.current;
    setClearingWorkspace(true);
    void discardLocalWorkspace(localWorkspaceToken.current)
      .then(() => {
        if (version === workspaceVersion.current) localWorkspaceToken.current = crypto.randomUUID();
      })
      .catch(() => {
        if (version === workspaceVersion.current) {
          setLocalCleanupFailed(true);
          setError("Local workspace cleanup could not be confirmed. Clear again or restart the service before starting another local job.");
        }
      })
      .finally(() => {
        if (version === workspaceVersion.current) setClearingWorkspace(false);
      });
  };

  const copyVideoUrl = async () => {
    const source = videoSource;
    const version = workspaceVersion.current;
    const selectedVersion = selectionVersion.current;
    if (!source) return;
    const videoUrl = new URL(source, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(videoUrl);
    } catch {
      if (version !== workspaceVersion.current || selectedVersion !== selectionVersion.current) return;
      setError("The browser could not copy the video URL to the clipboard.");
      return;
    }
    if (version !== workspaceVersion.current || selectedVersion !== selectionVersion.current) return;
    setError(null);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <main className="min-h-screen bg-[#0c0d0c] text-[#191b18]">
      {jobs
        .filter((trackedJob) =>
          (trackedJob.status === "queued" || trackedJob.status === "processing") &&
          !trackedJob.pollingStopped)
        .map((trackedJob) => (
          <JobPoller
            job={trackedJob}
            key={trackedJob.id}
            localWorkspaceToken={localWorkspaceToken.current}
            remoteWork={remoteVideoWork}
            setAnnouncement={setJobAnnouncement}
            setJobs={setJobs}
            workspaceVersion={workspaceVersion}
          />
        ))}
      <p aria-live="polite" className="sr-only" role="status">{jobAnnouncement}</p>
      <header className="border-b border-white/10 bg-[#0c0d0c] text-white">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-4 sm:px-8 lg:px-10">
          <div className="flex items-center gap-3">
            <img alt="" className="size-8 object-contain" src="/logo.png" />
            <p className="font-display text-sm uppercase tracking-[-0.02em]">Motio</p>
          </div>
          <div className="flex items-center gap-2">
            {sessionItemCount > 0 && (
              <details className="group relative">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[9px] uppercase tracking-[0.15em] text-white/70 transition hover:border-[#d9ff72]/50 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d9ff72] [&::-webkit-details-marker]:hidden">
                  <Icon name="film" className="size-3 text-[#d9ff72]" />
                  Jobs
                  <span aria-label={`${activeJobCount} active, ${sessionItemCount} total`} className="flex min-w-5 items-center justify-center rounded-full bg-[#d9ff72] px-1.5 py-0.5 text-[8px] font-bold text-black">
                    {sessionItemCount}
                  </span>
                </summary>
                <div className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2.5rem))] border border-white/15 bg-[#171917] shadow-2xl">
                  <div className="border-b border-white/10 px-4 py-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em]">Session jobs</p>
                    <p className="mt-1 text-[9px] leading-4 text-white/40">Private to this tab and cleared on reload or service restart.</p>
                  </div>
                  <div className="max-h-[60vh] overflow-y-auto p-2">
                    {([
                      ["openrouter", openRouterImageTaskStatus, "Meta Muse Image"],
                      ["mflux", mfluxImageTaskStatus, "Local MFLUX"],
                    ] as const).map(([provider, status, label]) => status && (
                      <button
                        aria-current={workflow === "image" && imageProvider === provider ? "true" : undefined}
                        className={`flex w-full items-center justify-between gap-3 border px-3 py-3 text-left transition ${workflow === "image" && imageProvider === provider ? "border-[#d9ff72]/60 bg-[#d9ff72]/5" : "border-transparent hover:border-white/15 hover:bg-white/5"}`}
                        key={provider}
                        onClick={(event) => {
                          viewImageTask(provider);
                          const details = event.currentTarget.closest("details");
                          details?.removeAttribute("open");
                          details?.querySelector("summary")?.focus();
                        }}
                        type="button"
                      >
                        <span className="min-w-0">
                          <span className="block text-[10px] font-bold uppercase tracking-[0.12em]">{label}</span>
                          <span className="mt-1 block font-mono text-[9px] text-white/40">Text to image request</span>
                        </span>
                        <span className={`shrink-0 text-[9px] font-bold uppercase tracking-[0.12em] ${status === "failed" ? "text-[#ff826e]" : status === "completed" ? "text-white/55" : "text-[#d9ff72]"}`}>
                          {status}
                        </span>
                      </button>
                    ))}
                    {([
                      ["openrouter", openRouterSubmissionStatus, openRouterSubmitting],
                      ["local", localSubmissionStatus, localSubmitting],
                    ] as const).map(([provider, status, providerSubmitting]) => status && (
                      <button
                        aria-current={workflow === "video" && form.provider === provider && !selectedJobId ? "true" : undefined}
                        className={`flex w-full items-center justify-between gap-3 border px-3 py-3 text-left transition ${workflow === "video" && form.provider === provider && !selectedJobId ? "border-[#d9ff72]/60 bg-[#d9ff72]/5" : "border-transparent hover:border-white/15 hover:bg-white/5"}`}
                        key={provider}
                        onClick={(event) => {
                          viewVideoSubmission(provider);
                          const details = event.currentTarget.closest("details");
                          details?.removeAttribute("open");
                          details?.querySelector("summary")?.focus();
                        }}
                        type="button"
                      >
                        <span className="min-w-0">
                          <span className="block text-[10px] font-bold uppercase tracking-[0.12em]">{provider === "openrouter" ? "OpenRouter video" : "Local h3.c"}</span>
                          <span className="mt-1 block font-mono text-[9px] text-white/40">{providerSubmitting ? "Waiting for job ID" : "No job was returned"}</span>
                        </span>
                        <span className={`shrink-0 text-[9px] font-bold uppercase tracking-[0.12em] ${status === "failed" ? "text-[#ff826e]" : "text-[#d9ff72]"}`}>{status}</span>
                      </button>
                    ))}
                    {jobs.map((trackedJob) => {
                      const active = trackedJob.status === "queued" || trackedJob.status === "processing";
                      return (
                        <button
                          aria-current={selectedJobId === trackedJob.id ? "true" : undefined}
                          className={`flex w-full items-center justify-between gap-3 border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${selectedJobId === trackedJob.id ? "border-[#d9ff72]/60 bg-[#d9ff72]/5" : "border-transparent hover:border-white/15 hover:bg-white/5"}`}
                          disabled={uploadingReference !== null || readingImageReference}
                          key={trackedJob.id}
                          onClick={(event) => {
                            viewJob(trackedJob);
                            const details = event.currentTarget.closest("details");
                            details?.removeAttribute("open");
                            details?.querySelector("summary")?.focus();
                          }}
                          type="button"
                        >
                          <span className="min-w-0">
                            <span className="block text-[10px] font-bold uppercase tracking-[0.12em]">{trackedJob.provider === "local" ? "Local h3.c" : "OpenRouter"}</span>
                            <span className="mt-1 block truncate font-mono text-[9px] text-white/40">{trackedJob.id}</span>
                          </span>
                          <span className={`shrink-0 text-[9px] font-bold uppercase tracking-[0.12em] ${trackedJob.status === "failed" ? "text-[#ff826e]" : active ? "text-[#d9ff72]" : "text-white/55"}`}>
                            {trackedJob.status}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </details>
            )}
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
          <div className="mb-7 grid grid-cols-2 gap-1.5 bg-black/5 p-1.5" aria-label="Generation workflow" role="group">
            {(["video", "image"] as const).map((option) => (
              <button
                aria-pressed={workflow === option}
                className={`h-12 text-xs font-bold uppercase tracking-[0.12em] transition disabled:cursor-not-allowed disabled:opacity-40 ${workflow === option ? "bg-black text-[#d9ff72]" : "text-stone-500 hover:bg-white/60 hover:text-black"}`}
                disabled={uploadingReference !== null || readingImageReference}
                key={option}
                onClick={() => {
                  leaveJobView();
                  setWorkflow(option);
                  setError(option === "image"
                    ? currentImageFailure
                    : form.provider === "openrouter"
                      ? openRouterSubmissionFailure
                      : localSubmissionFailure);
                }}
                type="button"
              >
                {option === "video" ? "Text to video" : "Text to image"}
              </button>
            ))}
          </div>

          {workflow === "image" && (
          <>
          <div className="mb-7 grid grid-cols-2 gap-1.5 border border-black/10 p-1.5" aria-label="Image generation provider">
            {(["openrouter", "mflux"] as const).map((provider) => (
              <button
                aria-pressed={imageProvider === provider}
                className={`h-11 text-[10px] font-bold uppercase tracking-[0.12em] transition disabled:cursor-not-allowed disabled:opacity-40 ${imageProvider === provider ? "bg-black text-[#d9ff72]" : "text-stone-500 hover:bg-white/60 hover:text-black"}`}
                disabled={provider === "mflux" && appConfig?.localMflux.supported !== true}
                key={provider}
                onClick={() => {
                  leaveJobView();
                  setImageProvider(provider);
                  setError(provider === "openrouter" ? imageFailure : mfluxImageFailure);
                }}
                type="button"
              >
                {provider === "openrouter" ? "OpenRouter" : "MFLUX"}
              </button>
            ))}
          </div>
          {appConfig?.localMflux.supported === false && (
            <p className="-mt-5 mb-7 text-[11px] leading-4 text-stone-500">
              Local MFLUX requires macOS on Apple Silicon and is unavailable in Docker.
            </p>
          )}
          </>
          )}

          {workflow === "video" && (
          <>
          <div className="mb-7 grid grid-cols-2 gap-1.5 border border-black/10 p-1.5" aria-label="Video generation provider">
            {(["openrouter", "local"] as const).map((provider) => (
              <button
                aria-pressed={form.provider === provider}
                className={`h-11 text-[10px] font-bold uppercase tracking-[0.12em] transition disabled:cursor-not-allowed disabled:opacity-40 ${form.provider === provider ? "bg-black text-[#d9ff72]" : "text-stone-500 hover:bg-white/60 hover:text-black"}`}
                disabled={uploadingReference !== null || (provider === "local" && appConfig?.localH3.supported !== true)}
                key={provider}
                onClick={() => {
                  leaveJobView();
                  setForm((current) => ({ ...current, provider }));
                  setError(provider === "openrouter" ? openRouterSubmissionFailure : localSubmissionFailure);
                }}
                type="button"
              >
                {provider === "openrouter" ? "OpenRouter" : "h3.c"}
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

          {((workflow === "image" && imageProvider === "openrouter") || (workflow === "video" && form.provider === "openrouter")) && (
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
                    disabled={currentSubmitting}
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
                      disabled={currentSubmitting}
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
          <fieldset disabled={currentSubmitting || readingImageReference}>
            {imageProvider === "mflux" && (
              <div className="mb-5 border border-black/12 bg-[#e7e5dc] px-3 py-2.5 sm:px-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-7 shrink-0 items-center justify-center bg-[#d9ff72] text-black"><Icon name="spark" /></div>
                  <h3 className="flex-1 text-xs font-bold uppercase tracking-[0.12em]">Local engine</h3>
                  <a
                    className="border border-black/20 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] transition hover:border-black hover:bg-black hover:text-[#d9ff72]"
                    href="https://github.com/SimaxLabs/motio#local-image-generation-with-mflux"
                    rel="noreferrer"
                    target="_blank"
                  >
                    Info
                  </a>
                </div>
                {!selectedMfluxModelAvailable && (
                  <p className="mt-2 border-t border-black/10 pt-2 text-[11px] leading-4 text-stone-500">
                    Install {selectedMfluxModel.executable} or set {selectedMfluxModel.environmentVariable} to its absolute path on the backend.
                  </p>
                )}
              </div>
            )}
            <div>
              <FieldLabel htmlFor="image-prompt">{imageProvider === "mflux" && selectedMfluxModel.requiresReference ? "Edit instruction" : "Image prompt"}</FieldLabel>
              <div className="relative">
                <textarea
                  autoFocus
                  className="min-h-40 w-full resize-y border border-black/15 bg-[#faf9f3] px-4 py-4 text-[15px] leading-6 outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                  id="image-prompt"
                  maxLength={10_000}
                  onChange={(event) => setImagePrompt(event.target.value)}
                  placeholder={imageProvider === "mflux" && selectedMfluxModel.requiresReference
                    ? "Replace the background with a rain-soaked night market while preserving the subject..."
                    : "The opening frame of a rain-soaked night market, cinematic lighting, reflections rippling across the pavement..."}
                  required
                  value={imagePrompt}
                />
                <span className="absolute bottom-3 right-3 font-mono text-[9px] text-stone-400">{imagePrompt.length} / 10K</span>
              </div>
            </div>
            {imageProvider === "mflux" && (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Recommended setup</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {mfluxRecommendedSetups.map((setup) => {
                    const selected =
                      mfluxResolution === setup.resolution &&
                      mfluxSteps === setup.steps &&
                      mfluxQuantization === setup.quantization &&
                      mfluxSeed === "" &&
                      mfluxLowRam === setup.lowRam &&
                      mfluxVaeTiling === setup.vaeTiling &&
                      mfluxVaeTileSize === setup.vaeTileSize &&
                      mfluxGuidance === setup.guidance &&
                      mfluxImageStrength === setup.imageStrength;
                    return (
                      <button
                        aria-pressed={selected}
                        className={`min-h-14 border px-3 py-2 text-left transition ${selected ? "border-black bg-black text-[#d9ff72]" : "border-black/15 bg-[#faf9f3] hover:border-black/50"}`}
                        key={setup.id}
                        onClick={() => applyMfluxSetup(setup)}
                        type="button"
                      >
                        <span className="block text-[10px] font-bold uppercase tracking-[0.12em]">{setup.label}</span>
                        <span className={`mt-1 block text-[10px] ${selected ? "text-white/65" : "text-stone-500"}`}>{setup.note}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="mt-6">
              {imageProvider === "mflux" ? (
                <>
                  <FieldLabel htmlFor="mflux-model">Model</FieldLabel>
                  <select
                    className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="mflux-model"
                    onChange={(event) => {
                      const model = getMfluxImageModel(event.target.value);
                      const setup = MFLUX_IMAGE_RECOMMENDED_SETUPS.find((candidate) => (candidate.models as readonly string[]).includes(event.target.value));
                      if (!model || !setup) return;
                      setMfluxModel(model.id);
                      applyMfluxSetup(setup);
                    }}
                    value={selectedMfluxModel.id}
                  >
                    {MFLUX_IMAGE_MODELS.map((model) => (
                      <option disabled={!appConfig?.localMflux.models.includes(model.id)} key={model.id} value={model.id}>{model.name}</option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Model</p>
                  <p className="flex h-12 items-center border border-black/15 bg-[#faf9f3] px-3 text-sm text-stone-700">{currentImageModel.name}</p>
                </>
              )}
              {imageProvider === "openrouter" && (
                <p className="mt-2 font-mono text-[10px] text-stone-600">OpenRouter price: {MUSE_IMAGE_MODEL.price}</p>
              )}
              <p className="mt-2 text-[11px] leading-4 text-stone-500">
                {imageProvider === "openrouter"
                  ? "The reference is sent through OpenRouter's documented input_references field."
                  : `MFLUX uses ${mfluxSteps} steps and ${mfluxQuantization === null ? "no on-load quantization" : `${mfluxQuantization}-bit quantization`}.`}
              </p>
            </div>
            {imageProvider === "mflux" && (
              <div className="mt-6 grid gap-5 sm:grid-cols-[0.8fr_1.2fr]">
                <div>
                  <FieldLabel htmlFor="mflux-resolution">Resolution</FieldLabel>
                  <select
                    className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="mflux-resolution"
                    onChange={(event) => {
                      const resolution = mfluxResolutionOptions.find((option) => option.label === event.target.value);
                      if (resolution) setMfluxResolution(resolution.id);
                    }}
                    value={selectedMfluxResolution.label}
                  >
                    {mfluxResolutionOptions.map((resolution) => (
                      <option key={resolution.label} value={resolution.label}>{resolution.label}</option>
                    ))}
                  </select>
                </div>
                <fieldset>
                  <legend className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Aspect ratio</legend>
                  <div className="grid grid-cols-4 gap-1.5">
                    {mfluxAspectRatioOptions.map((option) => {
                      const resolution = MFLUX_IMAGE_RESOLUTIONS.find((candidate) =>
                        candidate.label === selectedMfluxResolution.label && candidate.aspectRatio === option.aspectRatio);
                      const tooltipId = `mflux-${selectedMfluxResolution.label}-${option.aspectRatio.replace(":", "-")}-unsupported`;
                      return (
                        <div className="group relative" key={option.aspectRatio}>
                          <button
                            aria-describedby={resolution ? undefined : tooltipId}
                            aria-disabled={!resolution}
                            aria-pressed={selectedMfluxResolution.id === resolution?.id}
                            className={`h-12 w-full border text-xs font-bold transition ${selectedMfluxResolution.id === resolution?.id ? "border-black bg-black text-[#d9ff72]" : resolution ? "border-black/15 bg-[#faf9f3] hover:border-black/50" : "cursor-not-allowed border-black/10 bg-black/5 text-stone-400"}`}
                            onClick={() => { if (resolution) setMfluxResolution(resolution.id); }}
                            type="button"
                          >
                            {option.aspectRatio}
                          </button>
                          {!resolution && (
                            <span
                              className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-44 -translate-x-1/2 bg-black px-2 py-1.5 text-center text-[9px] leading-3 text-white group-focus-within:block group-hover:block"
                              id={tooltipId}
                              role="tooltip"
                            >
                              {option.aspectRatio} is unavailable at {selectedMfluxResolution.label}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </fieldset>
              </div>
            )}
            <div className="mt-6 border border-black/12 bg-[#e7e5dc] p-4 sm:p-5">
              <div className="mb-4 flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center bg-white/70"><Icon name="image" /></div>
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em]">Reference image</h3>
                  <p className="mt-1 text-[11px] leading-4 text-stone-500">
                    {imageProvider === "mflux" && selectedMfluxModel.requiresReference
                      ? "Qwen Image Edit requires one PNG, JPEG, or WebP image up to 10 MB."
                      : "Add one optional PNG, JPEG, or WebP image up to 10 MB."}
                  </p>
                </div>
              </div>
              <FieldLabel htmlFor="image-reference" optional={!(imageProvider === "mflux" && selectedMfluxModel.requiresReference)}>Image file</FieldLabel>
              <input
                accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                className="h-11 w-full cursor-pointer text-[0] outline-none file:h-11 file:w-full file:cursor-pointer file:border file:border-black/15 file:bg-[#faf9f3] file:px-3 file:text-[10px] file:font-bold file:uppercase file:tracking-[0.12em] hover:file:border-black focus-visible:ring-2 focus-visible:ring-black"
                id="image-reference"
                onChange={(event) => void selectImageReference(event)}
                aria-required={imageProvider === "mflux" && selectedMfluxModel.requiresReference}
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
            {imageProvider === "mflux" && (
              <>
                <p aria-live="polite" className="sr-only" role="status">{mfluxAdvancedStatus}</p>
                <details className="group mt-6 border border-black/12 bg-[#e7e5dc]">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-4 text-xs font-bold uppercase tracking-[0.12em] hover:bg-white/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black [&::-webkit-details-marker]:hidden">
                    Advanced
                    <span className="flex items-center gap-2 font-mono text-[9px] font-normal text-stone-500">
                      Steps, quantization, VAE, memory
                      <Icon name="arrow" className="size-3 transition group-open:rotate-90" />
                    </span>
                  </summary>
                  <div className="border-t border-black/10 p-4 sm:p-5">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <FieldLabel htmlFor="mflux-steps">Steps</FieldLabel>
                        <select
                          className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                          id="mflux-steps"
                          onChange={(event) => setMfluxSteps(Number(event.target.value))}
                          value={mfluxSteps}
                        >
                          {selectedMfluxModel.steps.map((steps) => <option key={steps} value={steps}>{steps}</option>)}
                        </select>
                        <p className="mt-1.5 text-[10px] leading-4 text-stone-500">{selectedMfluxModel.id === "qwen-image-edit" ? "Twenty is the MFLUX default." : "Four is recommended."}</p>
                      </div>
                      <div>
                        <FieldLabel htmlFor="mflux-quantization">Quantization</FieldLabel>
                        <select
                          className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                          id="mflux-quantization"
                          onChange={(event) => setMfluxQuantization(event.target.value === "off" ? null : Number(event.target.value))}
                          value={mfluxQuantization ?? "off"}
                        >
                          {MFLUX_IMAGE_QUANTIZATIONS.map((quantization) => <option key={quantization ?? "off"} value={quantization ?? "off"}>{quantization === null ? "Off" : `${quantization}-bit`}</option>)}
                        </select>
                        <p className="mt-1.5 text-[10px] leading-4 text-stone-500">{selectedMfluxModel.id === "qwen-image-edit" ? "Six-bit or lower can noticeably degrade edits." : "Lower bits use less memory."}</p>
                      </div>
                    </div>

                    {selectedMfluxModel.id === "qwen-image-edit" && (
                      <div className="mt-6">
                        <FieldLabel htmlFor="mflux-guidance">Guidance</FieldLabel>
                        <input
                          className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 font-mono text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                          id="mflux-guidance"
                          max={20}
                          min={0}
                          onChange={(event) => setMfluxGuidance(Number(event.target.value))}
                          step={0.1}
                          type="number"
                          value={mfluxGuidance}
                        />
                        <p className="mt-1.5 text-[10px] leading-4 text-stone-500">Controls how strongly the result follows the edit instruction; higher values push harder toward the prompt. 2.5 is the MFLUX default.</p>
                      </div>
                    )}

                    <div className="mt-6 grid gap-5 sm:grid-cols-2">
                      <label className={`flex items-center justify-between border-y border-black/10 py-4 sm:border-t-0 sm:pt-0 ${mfluxLowRam ? "cursor-not-allowed" : "cursor-pointer"}`}>
                        <span>
                          <span className="block text-xs font-bold uppercase tracking-[0.12em]">VAE tiling</span>
                          <span className="mt-1 block text-[11px] text-stone-500">Use smaller tiles to reduce peak memory.</span>
                        </span>
                        <span className={`relative h-7 w-12 shrink-0 rounded-full transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-black has-[:focus-visible]:ring-offset-2 ${mfluxVaeTilingEnabled ? "bg-black" : "bg-stone-300"}`}>
                          <input
                            checked={mfluxVaeTilingEnabled}
                            className="sr-only"
                            disabled={mfluxLowRam}
                            onChange={(event) => setMfluxVaeTiling(event.target.checked)}
                            type="checkbox"
                          />
                          <span className={`absolute top-1 size-5 rounded-full transition ${mfluxVaeTilingEnabled ? "left-6 bg-[#d9ff72]" : "left-1 bg-white"}`} />
                        </span>
                      </label>
                      <div>
                        <FieldLabel htmlFor="mflux-vae-tile-size">VAE tile size</FieldLabel>
                        <select
                          className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72] disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={!mfluxVaeTilingEnabled}
                          id="mflux-vae-tile-size"
                          onChange={(event) => setMfluxVaeTileSize(Number(event.target.value))}
                          value={mfluxVaeTileSize}
                        >
                          {MFLUX_VAE_TILE_SIZES.map((size) => <option key={size} value={size}>{size}px</option>)}
                        </select>
                      </div>
                      <p className="text-[10px] leading-4 text-stone-500 sm:col-span-2">
                        {selectedMfluxModel.id === "qwen-image-edit"
                          ? "VAE tiling reduces peak memory during final decoding."
                          : "MFLUX 0.19.1 applies VAE tiling to reference encoding, not final decoding."}
                      </p>
                    </div>

                    <div className="mt-6 grid gap-5 sm:grid-cols-2">
                      <div>
                        <FieldLabel htmlFor="mflux-seed" optional>Seed / variation</FieldLabel>
                        <input
                          className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 font-mono text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                          id="mflux-seed"
                          max={4_294_967_295}
                          min={0}
                          onChange={(event) => setMfluxSeed(event.target.value)}
                          placeholder="Random"
                          type="number"
                          value={mfluxSeed}
                        />
                        <p className="mt-1.5 text-[10px] leading-4 text-stone-500">Leave empty for a time-based seed.</p>
                      </div>

                      <label className="flex cursor-pointer items-center justify-between border-y border-black/10 py-4 sm:border-t-0 sm:pt-0">
                        <span>
                          <span className="block text-xs font-bold uppercase tracking-[0.12em]">Low RAM</span>
                          <span className="mt-1 block text-[11px] text-stone-500">Reduce peak memory use and enable VAE tiling.</span>
                        </span>
                        <span className={`relative h-7 w-12 shrink-0 rounded-full transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-black has-[:focus-visible]:ring-offset-2 ${mfluxLowRam ? "bg-black" : "bg-stone-300"}`}>
                          <input
                            checked={mfluxLowRam}
                            className="sr-only"
                            onChange={(event) => setMfluxLowRam(event.target.checked)}
                            type="checkbox"
                          />
                          <span className={`absolute top-1 size-5 rounded-full transition ${mfluxLowRam ? "left-6 bg-[#d9ff72]" : "left-1 bg-white"}`} />
                        </span>
                      </label>
                    </div>

                    {imageReference && selectedMfluxModel.supportsImageStrength && (
                      <div className="mt-6">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <label className="text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700" htmlFor="mflux-image-strength">Reference strength</label>
                          <output className="font-mono text-xs text-stone-600" htmlFor="mflux-image-strength">{mfluxImageStrength.toFixed(1)}</output>
                        </div>
                        <input
                          className="w-full accent-black"
                          id="mflux-image-strength"
                          max={1}
                          min={0}
                          onChange={(event) => setMfluxImageStrength(Number(event.target.value))}
                          step={0.1}
                          type="range"
                          value={mfluxImageStrength}
                        />
                        <p className="mt-1.5 text-[10px] leading-4 text-stone-500">Higher values preserve more of the reference image.</p>
                      </div>
                    )}
                  </div>
                </details>
              </>
            )}
          </fieldset>
          ) : (
          <fieldset disabled={currentSubmitting || currentVideoLocked || uploadingReference !== null || ((clearingWorkspace || localCleanupFailed) && form.provider === "local")}>
            {form.provider === "local" && (
              <div className="mb-5 border border-black/12 bg-[#e7e5dc] px-3 py-2.5 sm:px-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-7 shrink-0 items-center justify-center bg-[#d9ff72] text-black"><Icon name="spark" /></div>
                  <h3 className="flex-1 text-xs font-bold uppercase tracking-[0.12em]">Local engine</h3>
                  <a
                    className="border border-black/20 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] transition hover:border-black hover:bg-black hover:text-[#d9ff72]"
                    href="https://github.com/SimaxLabs/motio#local-generation-with-h3c"
                    rel="noreferrer"
                    target="_blank"
                  >
                    Info
                  </a>
                </div>
                {!appConfig?.localH3.configured && (
                  <p className="mt-2 border-t border-black/10 pt-2 text-[11px] leading-4 text-stone-500">
                    Set H3_BINARY and H3_MODEL_DIR on the backend. The h3.c binary, model snapshot, and FFmpeg are required.
                  </p>
                )}
              </div>
            )}
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

          {form.provider === "local" && (
            <div className="mt-5">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Recommended setup</p>
              <div className="grid grid-cols-2 gap-1.5">
                {LOCAL_H3_RECOMMENDED_SETUPS.map((setup) => {
                  const selected =
                    form.localResolution === setup.resolution &&
                    form.localFrames === setup.frames &&
                    form.localQuality === setup.quality &&
                    form.localAcceleration === setup.acceleration &&
                    form.localSeed === setup.seed &&
                    form.localSsdStreaming === setup.ssdStreaming;
                  return (
                    <button
                      aria-pressed={selected}
                      className={`min-h-14 border px-3 py-2 text-left transition ${selected ? "border-black bg-black text-[#d9ff72]" : "border-black/15 bg-[#faf9f3] hover:border-black/50"}`}
                      key={setup.id}
                      onClick={() => {
                        setForm((current) => ({
                          ...current,
                          localResolution: setup.resolution,
                          localFrames: setup.frames,
                          localQuality: setup.quality,
                          localAcceleration: setup.acceleration,
                          localSeed: setup.seed,
                          localSsdStreaming: setup.ssdStreaming,
                        }));
                        setLocalAdvancedStatus(`${setup.label} setup applied.`);
                      }}
                      type="button"
                    >
                      <span className="block text-[10px] font-bold uppercase tracking-[0.12em]">{setup.label}</span>
                      <span className={`mt-1 block text-[10px] ${selected ? "text-white/65" : "text-stone-500"}`}>{setup.note}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

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
          </div>

          <div className="mt-6 grid gap-5 sm:grid-cols-[0.7fr_1.3fr]">
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
                  <p className="flex h-12 items-center border border-black/15 bg-[#faf9f3] px-3 text-sm text-stone-700">MiniMax H3</p>
                </div>
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
              </div>

              <div className="mt-6 grid gap-5 sm:grid-cols-[0.7fr_1.3fr]">
                <div>
                  <FieldLabel htmlFor="local-resolution">Resolution</FieldLabel>
                  <select
                    className="h-12 w-full border border-black/15 bg-[#faf9f3] px-3 text-sm outline-none transition focus:border-black focus:ring-2 focus:ring-[#d9ff72]"
                    id="local-resolution"
                    onChange={(event) => {
                      const resolution = localResolutionOptions.find((option) => option.label === event.target.value);
                      if (resolution) selectLocalResolution(resolution.id);
                    }}
                    value={selectedLocalResolution.label}
                  >
                    {localResolutionOptions.map((resolution) => (
                      <option key={resolution.label} value={resolution.label}>{resolution.label}</option>
                    ))}
                  </select>
                </div>
                <fieldset>
                  <legend className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Aspect ratio</legend>
                  <div className="grid grid-cols-3 gap-1.5">
                    {localAspectRatioOptions.map((option) => {
                      const resolution = LOCAL_H3_RESOLUTIONS.find((candidate) =>
                        candidate.label === selectedLocalResolution.label && candidate.aspectRatio === option.aspectRatio);
                      const tooltipId = `local-${selectedLocalResolution.label}-${option.aspectRatio.replace(":", "-")}-unsupported`;
                      return (
                        <div className="group relative" key={option.aspectRatio}>
                          <button
                            aria-describedby={resolution ? undefined : tooltipId}
                            aria-disabled={!resolution}
                            aria-pressed={form.localResolution === resolution?.id}
                            className={`h-12 w-full border text-xs font-bold transition ${form.localResolution === resolution?.id ? "border-black bg-black text-[#d9ff72]" : resolution ? "border-black/15 bg-[#faf9f3] hover:border-black/50" : "cursor-not-allowed border-black/10 bg-black/5 text-stone-400"}`}
                            onClick={() => { if (resolution) selectLocalResolution(resolution.id); }}
                            type="button"
                          >
                            {option.aspectRatio}
                          </button>
                          {!resolution && (
                            <span
                              className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-44 -translate-x-1/2 bg-black px-2 py-1.5 text-center text-[9px] leading-3 text-white group-focus-within:block group-hover:block"
                              id={tooltipId}
                              role="tooltip"
                            >
                              {option.aspectRatio} is unavailable at {selectedLocalResolution.label}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
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

              <p aria-live="polite" className="sr-only" role="status">{localAdvancedStatus}</p>
              <details className="group mt-6 border border-black/12 bg-[#e7e5dc]">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-4 text-xs font-bold uppercase tracking-[0.12em] hover:bg-white/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black [&::-webkit-details-marker]:hidden">
                  Advanced
                  <span className="flex items-center gap-2 font-mono text-[9px] font-normal text-stone-500">
                    Quality, acceleration, seed, memory
                    <Icon name="arrow" className="size-3 transition group-open:rotate-90" />
                  </span>
                </summary>
                <div className="border-t border-black/10 p-4 sm:p-5">
                  <fieldset>
                    <legend className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Quality</legend>
                    <div className="grid grid-cols-3 gap-1.5">
                      {LOCAL_H3_QUALITY_PRESETS.map((quality) => (
                        <button
                          aria-pressed={form.localQuality === quality.id}
                          className={`h-12 border text-xs font-bold transition ${form.localQuality === quality.id ? "border-black bg-black text-[#d9ff72]" : "border-black/15 bg-[#faf9f3] hover:border-black/50"}`}
                          key={quality.id}
                          onClick={() => {
                            const resetAcceleration = !isLocalH3AccelerationAvailable(form.localAcceleration, form.localResolution, quality.id);
                            setForm((current) => ({
                              ...current,
                              localQuality: quality.id,
                              localAcceleration: resetAcceleration ? "standard" : current.localAcceleration,
                            }));
                            setLocalAdvancedStatus(resetAcceleration ? "Acceleration reset to Standard for the selected quality." : "");
                          }}
                          type="button"
                        >
                          {quality.label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[10px] leading-4 text-stone-500">{selectedLocalQuality?.note}</p>
                  </fieldset>

                  <fieldset className="mt-6">
                    <legend className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-stone-700">Acceleration</legend>
                    <div className="grid grid-cols-3 gap-1.5">
                      {LOCAL_H3_ACCELERATION_PRESETS.map((preset) => {
                        const available = isLocalH3AccelerationAvailable(preset.id, form.localResolution, form.localQuality);
                        return (
                          <button
                            aria-pressed={form.localAcceleration === preset.id}
                            aria-describedby={`local-acceleration-${preset.id}-description`}
                            className={`min-h-12 border px-2 text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-35 ${form.localAcceleration === preset.id ? "border-black bg-black text-[#d9ff72]" : "border-black/15 bg-[#faf9f3] hover:border-black/50"}`}
                            disabled={!available}
                            key={preset.id}
                            onClick={() => {
                              setForm((current) => ({ ...current, localAcceleration: preset.id }));
                              setLocalAdvancedStatus("");
                            }}
                            title={available ? preset.note : "Requires 512p / 1:1 / Balanced mode"}
                            type="button"
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-3 space-y-1 text-[10px] leading-4 text-stone-600">
                      {LOCAL_H3_ACCELERATION_PRESETS.map((preset) => (
                        <p id={`local-acceleration-${preset.id}-description`} key={preset.id}>
                          <strong>{preset.label}:</strong> {preset.note}{preset.id === "standard" ? "" : " Requires 512p / 1:1 / Balanced mode."}
                        </p>
                      ))}
                    </div>
                  </fieldset>

                  <div className="mt-6 grid gap-5 sm:grid-cols-2">
                    <div>
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
                      <p className="mt-1.5 text-[10px] leading-4 text-stone-500">Change the seed for another variation.</p>
                    </div>

                    <label className="flex cursor-pointer items-center justify-between border-y border-black/10 py-4 sm:border-t-0 sm:pt-0">
                      <span>
                        <span className="block text-xs font-bold uppercase tracking-[0.12em]">SSD streaming</span>
                        <span className="mt-1 block text-[11px] leading-4 text-stone-500">Lower memory use with slower generation.</span>
                      </span>
                      <span className={`relative h-7 w-12 shrink-0 rounded-full transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-black has-[:focus-visible]:ring-offset-2 ${form.localSsdStreaming ? "bg-black" : "bg-stone-300"}`}>
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
                </div>
              </details>

            </>
          )}
          </fieldset>
          )}

          {(currentSubmissionUncertain || error) && (
            <div className="mt-5 border-l-4 border-[#e44d38] bg-[#f9dfd9] px-4 py-3 text-sm leading-5 text-[#712519]" role="alert">
              {currentSubmissionUncertain
                ? currentSubmissionKind === "mflux" ? uncertainMfluxSubmissionMessage : uncertainSubmissionMessage
                : error}
            </div>
          )}

          <div className="mt-7 flex gap-3">
            <button
              className="group flex h-14 flex-1 items-center justify-between bg-black px-5 font-display text-sm uppercase tracking-[0.02em] text-white transition hover:bg-[#242722] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={
                currentSubmitting ||
                readingImageReference ||
                currentSubmissionUncertain ||
                ((clearingWorkspace || localCleanupFailed) && workflow === "video" && form.provider === "local") ||
                (workflow === "video" && (currentVideoLocked || uploadingReference !== null || !form.prompt.trim())) ||
                (workflow === "image" && (!imagePrompt.trim() || (imageProvider === "mflux" && (!selectedMfluxModelAvailable || (selectedMfluxModel.requiresReference && !imageReference)))))
              }
              type="submit"
            >
              <span>
                {currentSubmitting
                  ? "Submitting..."
                  : workflow === "image"
                    ? imageProvider === "mflux" ? "Generate locally" : "Text to image"
                    : currentVideoUnknown
                      ? "Submission status unknown"
                      : currentVideoActive
                      ? "Generation active"
                      : form.provider === "local"
                        ? "Generate locally"
                        : currentSubmissionUncertain
                          ? "Submission status unknown"
                          : "Generate video"}
              </span>
              <span className="flex size-8 items-center justify-center rounded-full bg-[#d9ff72] text-black transition group-hover:translate-x-1"><Icon name="arrow" /></span>
            </button>
            <button
              className="h-14 border border-black/20 px-4 text-[10px] font-bold uppercase tracking-[0.12em] hover:border-black disabled:cursor-not-allowed disabled:opacity-45"
              disabled={submitting || clearingWorkspace || Boolean(removingJobId) || uploadingReference !== null || readingImageReference}
              onClick={clear}
              type="button"
            >
              {hasUnknownSubmission ? "Unlock retry" : "Clear"}
            </button>
          </div>
        </form>

        <section className="flex min-h-[620px] flex-col bg-[#171917] text-white lg:min-h-full">
          {workflow === "image" ? (
          <>
          <div className="flex items-center justify-between px-5 py-5 sm:px-8">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/60">Output monitor</p>
              <h2 className="mt-1 font-display text-lg uppercase">
                {imageTaskStatus ? currentImageModel.name : "No active reel"}
              </h2>
            </div>
            {imageTaskStatus && (
              <span className={`rounded-full border px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] ${imageTaskStatus === "failed" ? "border-[#ff826e]/30 text-[#ff826e]" : "border-[#d9ff72]/30 text-[#d9ff72]"}`}>
                {imageTaskStatus}
              </span>
            )}
          </div>

          <StatusRail status={imageTaskStatus === "unknown" ? undefined : imageTaskStatus ?? undefined} />

          <div className="flex flex-1 items-center p-5 sm:p-8">
            <div className="relative flex min-h-72 w-full items-center justify-center overflow-hidden bg-[#171917]">
              {currentSubmitting ? (
                <div className="relative flex min-h-96 w-full items-center justify-center overflow-hidden bg-[#111310]">
                  <div className="absolute inset-0 preview-grid opacity-35" />
                  <div className="relative w-full max-w-lg px-6 text-center">
                    <div className="mx-auto mb-5 size-12 animate-spin rounded-full border border-white/15 border-t-[#d9ff72]" />
                    <p className="font-display text-2xl uppercase text-white" aria-live="polite">
                      {imageProvider === "mflux"
                        ? mfluxProgress?.phase === "decoding"
                          ? "Decoding image"
                          : mfluxProgress?.phase === "generating"
                            ? "Generating image"
                            : "Loading model"
                        : "Rendering first frame"}
                    </p>
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/60">
                      {imageProvider === "mflux" ? "MFLUX is composing the image" : "Muse is composing the image"}
                    </p>
                    {imageProvider === "mflux" && (
                      <div className="mt-8 border border-white/10 bg-black/20 p-4 text-left">
                        <div
                          aria-label="MFLUX generation progress"
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={mfluxProgress?.percent ?? 0}
                          className="h-1.5 overflow-hidden bg-white/10"
                          role="progressbar"
                        >
                          <div className="h-full bg-[#d9ff72] transition-[width]" style={{ width: `${mfluxProgress?.percent ?? 0}%` }} />
                        </div>
                        <div className="mt-4 grid grid-cols-3 gap-3">
                          <div>
                            <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/45">Progress</p>
                            <p className="mt-1 font-mono text-xs text-white">{mfluxProgress?.step ?? 0} / {mfluxProgress?.total ?? mfluxSteps}</p>
                          </div>
                          <div>
                            <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/45">Elapsed</p>
                            <p className="mt-1 font-mono text-xs text-white">{formatSeconds(mfluxElapsedSeconds)}</p>
                          </div>
                          <div>
                            <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/45">Step ETA</p>
                            <p className="mt-1 font-mono text-xs text-white">{formatSeconds(mfluxProgress?.etaSeconds)}</p>
                          </div>
                        </div>
                        <p className="mt-4 font-mono text-[9px] leading-4 text-white/50">
                          {mfluxProgress?.secondsPerStep
                            ? `${mfluxProgress.secondsPerStep.toFixed(1)} seconds per step. ETA covers inference; final decoding may add time.`
                            : "Timing appears after the first inference step."}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ) : imageSource ? (
                <img
                  alt="Generated first frame"
                  className="max-h-[760px] w-full object-contain"
                  src={imageSource}
                />
              ) : (
                <p className="px-6 text-center font-mono text-[10px] uppercase tracking-[0.15em] text-white/60">
                  Generated image preview will appear here
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-white/10 px-5 py-5 sm:px-8">
            {currentImageResult && imageSource ? (
              <>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <a
                    className="flex h-12 flex-1 items-center justify-center gap-2 bg-[#d9ff72] text-xs font-bold uppercase tracking-[0.12em] text-black transition hover:bg-white"
                    download={`${imageProvider === "mflux" ? "mflux" : "muse"}-image.${imageExtension}`}
                    href={imageSource}
                  >
                    <Icon name="download" /> Download first frame
                  </a>
                  <button
                    className="flex h-12 flex-1 items-center justify-center border border-white/15 text-xs font-bold uppercase tracking-[0.12em] text-white transition hover:border-[#ff826e]/70 hover:text-[#ff826e]"
                    onClick={deleteImageTask}
                    type="button"
                  >
                    Delete result
                  </button>
                </div>
                {typeof currentImageResult.cost === "number" && (
                  <p className="mt-3 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-white/60">
                    OpenRouter cost ${currentImageResult.cost.toFixed(4)}
                  </p>
                )}
              </>
            ) : imageProvider === "mflux" && mfluxImageSubmitting ? (
              <button
                className="flex h-12 w-full items-center justify-center border border-[#ff826e]/40 text-xs font-bold uppercase tracking-[0.12em] text-[#ff826e] transition hover:border-[#ff826e] hover:bg-[#ff826e]/5"
                onClick={stopMfluxImage}
                type="button"
              >
                Abort local generation
              </button>
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
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/60">Output monitor</p>
              <h2 className="mt-1 font-display text-lg uppercase">{job ? `Job ${job.id.slice(0, 12)}` : currentVideoSubmissionStatus ? "Video submission" : "No active reel"}</h2>
            </div>
            {(job || currentVideoSubmissionStatus) && (
              <span className={`rounded-full border px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] ${job?.status === "failed" || currentVideoSubmissionStatus === "failed" ? "border-[#ff826e]/30 text-[#ff826e]" : "border-[#d9ff72]/30 text-[#d9ff72]"}`}>
                {job?.status || currentVideoSubmissionStatus}
              </span>
            )}
          </div>

          <StatusRail status={job?.status} />

          <div className="flex flex-1 items-center p-5 sm:p-8">
            <div className="min-h-72 w-full overflow-hidden bg-[#171917]">
              <Preview
                aspectRatio={job?.aspectRatio || (form.provider === "local" ? selectedLocalResolution.aspectRatio : form.aspectRatio)}
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
            {job?.status === "completed" ? (
              <div className="flex flex-col gap-3 sm:flex-row">
                {downloadSource && (
                  <>
                    <a
                      className="flex h-12 flex-1 items-center justify-center gap-2 bg-[#d9ff72] text-xs font-bold uppercase tracking-[0.12em] text-black transition hover:bg-white"
                      download={usesSessionMedia
                        ? job.provider === "local" ? "h3-local-video.mp4" : "openrouter-video.mp4"
                        : undefined}
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
                  </>
                )}
                <button
                  className="flex h-12 flex-1 items-center justify-center border border-white/15 text-xs font-bold uppercase tracking-[0.12em] text-white transition hover:border-[#ff826e]/70 hover:text-[#ff826e] disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={Boolean(removingJobId)}
                  onClick={() => void removeVideoJob(job)}
                  type="button"
                >
                  {removingJobId === job.id ? "Deleting..." : "Delete job"}
                </button>
              </div>
            ) : job?.provider === "local" && isActive ? (
              <button
                className="flex h-12 w-full items-center justify-center border border-[#ff826e]/40 text-xs font-bold uppercase tracking-[0.12em] text-[#ff826e] transition hover:border-[#ff826e] hover:bg-[#ff826e]/5 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={Boolean(removingJobId)}
                onClick={() => void removeVideoJob(job)}
                type="button"
              >
                {removingJobId === job.id ? "Stopping..." : "Abort local job"}
              </button>
            ) : (
              <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.15em] text-white/60">
                <span>{currentVideoSubmissionStatus && !job ? currentSubmitting ? "Waiting for provider job ID" : "Submission did not create a provider job" : pollingStopped ? "Automatic polling stopped" : isActive ? "Polling every 10 seconds" : "Output controls unlock on completion"}</span>
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
