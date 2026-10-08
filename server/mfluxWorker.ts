// Embedded so the compiled server needs no source files or separate Python install.
export const MFLUX_WORKER_SOURCE = String.raw`
import gc
import errno
import importlib
import inspect
import json
import os
from pathlib import Path
import sys
import threading
import time

binary, pipeline, parent = sys.argv[1:4]
parent = int(parent)
one_shot = "--once" in sys.argv[4:]
protocol = sys.stdout
sys.stdout = sys.stderr
protocol_lock = threading.Lock()
resource_error = None

def emit(event_type, **values):
    with protocol_lock:
        protocol.write(json.dumps(dict(type=event_type, **values)) + "\n")
        protocol.flush()

def error_code(error):
    for _ in range(8):
        if error is None:
            break
        name = type(error).__name__
        status = getattr(getattr(error, "response", None), "status_code", None)
        if getattr(error, "errno", None) == errno.ENOSPC:
            return "disk_full"
        if isinstance(error, PermissionError) or getattr(error, "errno", None) == errno.EROFS:
            return "cache_permission"
        if name in ("GatedRepoError", "LocalTokenNotFoundError") or status in (401, 403):
            return "access"
        if name in ("RepositoryNotFoundError", "RevisionNotFoundError", "RemoteEntryNotFoundError") or status == 404:
            return "resource_missing"
        if isinstance(error, (ConnectionError, TimeoutError)) or name in (
            "ConnectError", "ReadError", "ConnectTimeout", "ReadTimeout", "ProxyError",
            "LocalEntryNotFoundError", "IncompleteSnapshotError", "OfflineModeIsEnabled",
        ):
            return "network"
        if isinstance(error, ImportError):
            return "dependencies"
        error = error.__cause__ or error.__context__
    return None

def observe_downloads():
    import huggingface_hub as hub
    from tqdm.auto import tqdm

    def observe(function):
        supports_progress = "tqdm_class" in inspect.signature(function).parameters

        def download(*args, **kwargs):
            global resource_error
            # MFLUX owns cache checks and resource selection. Do not turn an offline probe into a download.
            if kwargs.get("local_files_only") or kwargs.get("dry_run"):
                return function(*args, **kwargs)
            emit("checking")
            has_bytes = False
            last_update = None

            class DownloadProgress(tqdm):
                def __init__(self, *args, **kwargs):
                    kwargs.pop("name", None)
                    kwargs["disable"] = False
                    super().__init__(*args, **kwargs)

                def display(self, *args, **kwargs):
                    nonlocal has_bytes, last_update
                    total = getattr(self, "total", 0) or 0
                    completed = getattr(self, "n", 0)
                    is_bytes = getattr(self, "unit", None) == "B"
                    # Recent Hub versions show transfer and reconstruction bars; use reconstructed bytes once.
                    if getattr(self, "desc", "") == "Downloading bytes":
                        return
                    if is_bytes and total > 0:
                        has_bytes = True
                    if (has_bytes and not is_bytes) or total <= 0:
                        return
                    now = time.monotonic()
                    if last_update is not None and now - last_update < 0.2 and completed < total:
                        return
                    last_update = now
                    emit("downloading", completed=min(int(total), max(0, int(completed))), total=int(total), unit="bytes" if is_bytes else "files")

            if supports_progress:
                kwargs["tqdm_class"] = DownloadProgress
            try:
                result = function(*args, **kwargs)
                resource_error = None
                return result
            except Exception as error:
                resource_error = error_code(error) or "download"
                raise
            finally:
                emit("loading")

        return download

    # Install before importing MFLUX/Transformers so their imports use these observers.
    hub.snapshot_download = observe(hub.snapshot_download)
    hub.hf_hub_download = observe(hub.hf_hub_download)

def watch_parent():
    while True:
        time.sleep(1)
        if os.getppid() != parent:
            os._exit(1)

threading.Thread(target=watch_parent, daemon=True).start()

def main():
    observe_downloads()
    import mlx.core as mx
    from mflux.callbacks.instances.battery_saver import BatterySaver
    from mflux.models.common.resolution.config_resolution import ConfigResolution
    from mflux.models.common.vae.tiling_config import TilingConfig
    from mflux.utils.prompt_util import PromptUtil

    module_name, class_name = {
        "flux2": ("mflux.models.flux2.cli.flux2_generate", "Flux2Klein"),
        "flux2-edit": ("mflux.models.flux2.cli.flux2_edit_generate", "Flux2KleinEdit"),
        "z-image-turbo": ("mflux.models.z_image.cli.z_image_turbo_generate", "ZImage"),
    }[pipeline]
    command = importlib.import_module(module_name)
    model = None

    def generate(arguments):
        global resource_error
        nonlocal model
        resource_error = None
        sys.argv = [binary, *arguments]
        if one_shot:
            # Keep the CLI's Low RAM callbacks and encoder cleanup in one-shot mode.
            command.main()
            return
        args = command.build_parser().parse_args()
        if model is None:
            options = {
                "quantize": args.quantize,
                "model_config": ConfigResolution.resolve_restricted(args.model, "z-image-turbo" if pipeline == "z-image-turbo" else "flux2-klein-4b"),
            }
            model = getattr(command, class_name)(**options)
            model.callbacks.register(BatterySaver(args.battery_percentage_stop_limit))
            # ponytail: one model per worker; Node restarts it when load settings change.
            # CLI MemorySaver deletes encoders, so do not register it in warm mode.
            model.tiling_config = TilingConfig(vae_decode_tile_size=args.vae_tile_size or 512) if args.vae_tiling else None

        resource_error = None
        emit("loading")
        options = {
            "seed": args.seed[0],
            "prompt": PromptUtil.read_prompt(args),
            "width": args.width,
            "height": args.height,
            "num_inference_steps": args.steps,
            "guidance": 0.0 if pipeline == "z-image-turbo" else 1.0,
            "scheduler": args.scheduler if pipeline == "z-image-turbo" else "flow_match_euler_discrete",
        }
        if pipeline == "z-image-turbo":
            options["image_path"] = args.image_path
            options["image_strength"] = args.image_strength
        elif pipeline == "flux2-edit":
            options["image_paths"] = [Path(p) for p in args.image_paths]
        image = model.generate_image(**options)
        image.save(path=args.output, export_json_metadata=False)

    while True:
        line = sys.stdin.readline(65536)
        if not line:
            return
        if not line.endswith("\n"):
            raise ValueError("Oversized worker request")
        try:
            generate(json.loads(line))
        finally:
            sys.argv = [binary]
            del line
            gc.collect()
            mx.clear_cache()
        emit("done")
        if one_shot:
            return

try:
    main()
except BaseException as error:
    # Only allowlisted codes cross the pipe; exceptions can contain prompts, paths, and credentials.
    emit("error", code=error_code(error) or resource_error or "engine")
    sys.exit(1)
`;
