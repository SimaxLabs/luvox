#!/usr/bin/python3
"""Fake MFLUX environment: executes Luvox's real worker without loading weights."""
import argparse
import base64
import errno
from functools import partial
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time
import types

events = Path(__file__).with_suffix(".events")
cache = Path(__file__).with_suffix(".cache")
mode_file = Path(__file__).with_suffix(".mode")


def record(event, **values):
    with events.open("a") as output:
        output.write(json.dumps(dict(event=event, pid=os.getpid(), **values)) + "\n")


def module(name, **values):
    result = types.ModuleType(name)
    result.__dict__.update(values)
    sys.modules[name] = result
    if "." in name:
        parent, attribute = name.rsplit(".", 1)
        if parent not in sys.modules:
            module(parent)
        setattr(sys.modules[parent], attribute, result)
    return result


def build_parser():
    parser = argparse.ArgumentParser()
    for name in ["model", "prompt-file", "output", "image-paths", "image-path"]:
        parser.add_argument("--" + name)
    for name in ["steps", "width", "height", "quantize", "vae-tile-size"]:
        parser.add_argument("--" + name, type=int)
    parser.add_argument("--seed", type=int, nargs="+", default=[123])
    parser.add_argument("--guidance", type=float)
    parser.add_argument("--image-strength", type=float, default=0.4)
    parser.add_argument("--lora-paths", nargs="*")
    parser.add_argument("--lora-scales", nargs="*", type=float)
    parser.add_argument("--low-ram", action="store_true")
    parser.add_argument("--vae-tiling", action="store_true")
    parser.set_defaults(battery_percentage_stop_limit=10, scheduler="linear")
    original_parse = parser.parse_args

    def parse_args():
        args = original_parse()
        if args.image_paths:
            args.image_paths = [args.image_paths]
        if args.lora_paths:
            import huggingface_hub as hub
            resolved = []
            for source in args.lora_paths:
                if Path(source).is_absolute():
                    resolved.append(source)
                else:
                    resource = "lora-" + source.replace("/", "-").replace(":", "-")
                    try:
                        resolved.append(hub.snapshot_download(resource, local_files_only=True))
                    except LocalEntryNotFoundError:
                        resolved.append(hub.snapshot_download(resource))
            args.lora_paths = resolved
        return args

    parser.parse_args = parse_args
    return parser


class Image:
    def __init__(self, options):
        self.options = options

    def save(self, path, export_json_metadata):
        assert not export_json_metadata
        output = Path(path)
        if self.options["prompt"] == "invalid output":
            output.write_text("invalid")
            return
        output.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
        subprocess.run(["/usr/bin/sips", "-z", str(self.options["height"]), str(self.options["width"]), str(output)], check=True, stdout=subprocess.DEVNULL)


class Model:
    def __init__(self, **options):
        import huggingface_hub as hub
        for resource in ["weights", "tokenizer"]:
            repo = options["model_config"] + "-" + resource
            download = hub.snapshot_download if resource == "weights" else hub.hf_hub_download
            try:
                download(repo, local_files_only=True)
            except LocalEntryNotFoundError:
                download(repo)
        self.callbacks = types.SimpleNamespace(register=lambda callback: self.registered.append(callback))
        self.registered = []
        self.tiling_config = None
        if options.get("lora_paths"):
            assert type(self).__name__ == "ZImage"
            assert options["bake_lora"] is True
            assert len(options["lora_paths"]) == len(options["lora_scales"])
            for file in options["lora_paths"]:
                if Path(file).read_text() == "invalid adapter":
                    raise ValueError("private adapter path must not escape: " + file)
        record("load", pipeline=type(self).__name__, **options)

    def generate_image(self, **options):
        assert "OPENROUTER_API_KEY" not in os.environ
        assert len(self.registered) == 1
        references = options.get("image_paths", []) + ([options["image_path"]] if options.get("image_path") else [])
        for reference in references:
            assert Path(reference).is_file()
            assert not any(Path(reference).parent.glob("reference.*"))
        record("generate", tile=self.tiling_config, **{key: [str(p) for p in value] if key == "image_paths" else value for key, value in options.items()})
        if options["prompt"] == "fail":
            raise ValueError("private prompt must not escape")
        if options["prompt"] == "exit":
            os._exit(0)
        steps = options["num_inference_steps"]
        if type(self).__name__ == "ZImage":
            assert options["guidance"] == 0
            assert "image_paths" not in options
            if options["image_path"]:
                steps -= max(1, int(steps * options["image_strength"]))
        sys.stderr.write(" 50%%|#####     | %d/%d [00:20<00:20, 2.00s/it]\r" % (steps // 2, steps))
        sys.stderr.flush()
        while options["prompt"] == "wait":
            time.sleep(1)
        sys.stderr.write("100%%|##########| %d/%d [00:40<00:00, 2.00s/it]\r" % (steps, steps))
        sys.stderr.flush()
        return Image(options)


class LocalEntryNotFoundError(Exception):
    pass


class GatedRepoError(Exception):
    pass


class FakeProgress:
    def __init__(self, **kwargs):
        self.total = kwargs.get("total", 0)
        self.n = kwargs.get("initial", 0)
        self.unit = kwargs.get("unit", "it")
        self.desc = kwargs.get("desc", "")
        self.display()

    def display(self):
        pass

    def update(self, amount):
        self.n += amount
        self.display()


def snapshot_download(repo_id, *, filename=None, local_files_only=False, tqdm_class=FakeProgress):
    repo_id = repo_id.replace("/", "-") + ("-" + filename if filename else "")
    resource = cache / repo_id
    if resource.exists():
        record("cached", resource=repo_id)
        return str(resource)
    if local_files_only:
        raise LocalEntryNotFoundError("missing cached test resource")
    mode = mode_file.read_text() if mode_file.exists() else ""
    sensitive = "private prompt /private/cache hf_secret https://private.example/model"
    if mode == "access":
        raise GatedRepoError(sensitive)
    if mode == "network":
        raise ConnectionError(sensitive)
    if mode == "disk_full":
        raise OSError(errno.ENOSPC, sensitive)
    if mode == "cache_permission":
        raise PermissionError(sensitive)
    if mode == "resource_missing":
        error = ValueError(sensitive)
        error.response = types.SimpleNamespace(status_code=404)
        raise error
    if mode == "dependencies":
        raise ModuleNotFoundError(sensitive)
    record("download", resource=repo_id)
    cache.mkdir(exist_ok=True)
    incomplete = cache / (repo_id + ".incomplete")
    incomplete.write_text("partial test resource")
    progress = tqdm_class(total=1000000, unit="B", desc=sensitive)
    while mode == "stall":
        time.sleep(1)
    time.sleep(0.21)
    progress.update(500000)
    progress.update(500000)
    incomplete.rename(resource)
    return str(resource)


def cli(model_class):
    args = build_parser().parse_args()
    loras = dict(lora_paths=args.lora_paths, lora_scales=args.lora_scales, bake_lora=True) if args.lora_paths else {}
    model = model_class(quantize=args.quantize, model_config=args.model, **loras)
    model.callbacks.register(5)
    options = dict(seed=args.seed[0], prompt=Path(args.prompt_file).read_text(), width=args.width,
                   height=args.height, num_inference_steps=args.steps,
                   guidance=0 if model_class.__name__ == "ZImage" else 1)
    if model_class.__name__ == "ZImage":
        options.update(image_path=args.image_path, image_strength=args.image_strength)
    elif args.image_paths:
        options["image_paths"] = args.image_paths
    model.generate_image(**options).save(args.output, False)
    record("cli", low_ram=args.low_ram)


module("huggingface_hub", snapshot_download=snapshot_download, hf_hub_download=snapshot_download)
module("huggingface_hub.errors", LocalEntryNotFoundError=LocalEntryNotFoundError)
module("tqdm.auto", tqdm=FakeProgress)
module("mlx.core", clear_cache=lambda: None)
module("mflux.callbacks.instances.battery_saver", BatterySaver=lambda limit: limit)
module("mflux.models.common.resolution.config_resolution", ConfigResolution=types.SimpleNamespace(resolve_restricted=lambda model, default: model))
module("mflux.models.common.vae.tiling_config", TilingConfig=lambda **options: options)
module("mflux.utils.prompt_util", PromptUtil=types.SimpleNamespace(read_prompt=lambda args: Path(args.prompt_file).read_text()))
for name, class_name in [
    ("flux2.cli.flux2_generate", "Flux2Klein"),
    ("flux2.cli.flux2_edit_generate", "Flux2KleinEdit"),
    ("z_image.cli.z_image_turbo_generate", "ZImage"),
]:
    model_class = type(class_name, (Model,), {})
    module("mflux.models." + name, build_parser=build_parser, main=partial(cli, model_class), **{class_name: model_class})

if sys.argv[1] == "-u":
    sys.argv = sys.argv[3:]
    runpy.run_path(sys.argv[0], run_name="__main__")
else:
    args = build_parser().parse_args()
    record("cli", low_ram=args.low_ram)
    Image(dict(prompt=Path(args.prompt_file).read_text(), width=args.width, height=args.height)).save(args.output, False)
