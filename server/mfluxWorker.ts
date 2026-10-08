// Embedded so the compiled server needs no source files or separate Python install.
export const MFLUX_WORKER_SOURCE = String.raw`
import gc
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import time

binary, pipeline, parent = sys.argv[1:4]
parent = int(parent)
protocol = sys.stdout
sys.stdout = sys.stderr

def watch_parent():
    while True:
        time.sleep(1)
        if os.getppid() != parent:
            os._exit(1)

threading.Thread(target=watch_parent, daemon=True).start()

def main():
    import mlx.core as mx
    from mflux.callbacks.instances.battery_saver import BatterySaver
    from mflux.models.common.resolution.config_resolution import ConfigResolution
    from mflux.models.common.vae.tiling_config import TilingConfig
    from mflux.utils.prompt_util import PromptUtil

    module_name, class_name = {
        "flux2": ("mflux.models.flux2.cli.flux2_generate", "Flux2Klein"),
        "flux2-edit": ("mflux.models.flux2.cli.flux2_edit_generate", "Flux2KleinEdit"),
        "qwen-edit": ("mflux.models.qwen.cli.qwen_image_edit_generate", "QwenImageEdit"),
    }[pipeline]
    command = importlib.import_module(module_name)
    model = None

    def generate(arguments):
        nonlocal model
        sys.argv = [binary, *arguments]
        args = command.build_parser().parse_args()
        if model is None:
            options = {"quantize": args.quantize}
            if pipeline != "qwen-edit":
                options["model_config"] = ConfigResolution.resolve_restricted(args.model, "flux2-klein-4b")
            model = getattr(command, class_name)(**options)
            model.callbacks.register(BatterySaver(args.battery_percentage_stop_limit))
            # ponytail: one model per worker; Node restarts it when load settings change.
            # CLI MemorySaver deletes encoders, so do not register it in warm mode.
            model.tiling_config = TilingConfig(vae_decode_tile_size=args.vae_tile_size or 512) if args.vae_tiling else None

        options = {
            "seed": args.seed[0],
            "prompt": PromptUtil.read_prompt(args),
            "width": args.width,
            "height": args.height,
            "num_inference_steps": args.steps,
            "guidance": args.guidance if args.guidance is not None else (2.5 if pipeline == "qwen-edit" else 1.0),
            "scheduler": args.scheduler if pipeline == "qwen-edit" else "flow_match_euler_discrete",
        }
        if pipeline == "qwen-edit":
            options["image_paths"] = [str(p) for p in args.image_paths]
            options["image_path"] = options["image_paths"][0]
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
        protocol.write("done\n")
        protocol.flush()

try:
    main()
except BaseException:
    # Engine errors can contain prompts and paths. The server returns a generic error.
    sys.exit(1)
`;
