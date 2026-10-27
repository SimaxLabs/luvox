#!/usr/bin/python3
"""Fake MFLUX environment: executes Luvox's real worker without loading weights."""
import argparse
import base64
import errno
from dataclasses import asdict, dataclass, replace
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
    for name in ["model", "prompt-file", "output"]:
        parser.add_argument("--" + name)
    parser.add_argument("--image-paths", nargs="+")
    for name in ["steps", "width", "height", "quantize", "vae-tile-size"]:
        parser.add_argument("--" + name, type=int)
    parser.add_argument("--seed", type=int, nargs="+", default=[123])
    parser.add_argument("--guidance", type=float)
    parser.add_argument("--low-ram", action="store_true")
    parser.add_argument("--vae-tiling", action="store_true")
    parser.set_defaults(battery_percentage_stop_limit=10)
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


@dataclass(frozen=True)
class TilingConfig:
    vae_decode_tile_size: int = 512
    vae_encode_tile_size: int = 512


class CallbackManager:
    @staticmethod
    def _apply_vae_tiling(args, model):
        # Match MFLUX 0.19.1: the CLI changes decoding, leaving encoding at its default.
        if args.vae_tiling or args.vae_tile_size is not None:
            model.tiling_config = replace(model.tiling_config or TilingConfig(), vae_decode_tile_size=args.vae_tile_size or 512)


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
        record("load", pipeline=type(self).__name__, **options)

    def generate_image(self, **options):
        assert "OPENROUTER_API_KEY" not in os.environ
        assert len(self.registered) == 1
        assert options["guidance"] == 1
        for reference in options.get("image_paths", []):
            assert Path(reference).is_file()
            assert not any(Path(reference).parent.glob("reference.*"))
        record("generate", tile=asdict(self.tiling_config) if self.tiling_config else None, **{key: [str(p) for p in value] if key == "image_paths" else value for key, value in options.items()})
        if options["prompt"] == "fail":
            raise ValueError("private prompt must not escape")
        if options["prompt"] == "exit":
            os._exit(0)
        steps = options["num_inference_steps"]
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


def snapshot_download(repo_id, *, local_files_only=False, tqdm_class=FakeProgress):
    repo_id = repo_id.replace("/", "-")
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
    model = model_class(quantize=args.quantize, model_config=args.model)
    CallbackManager._apply_vae_tiling(args, model)
    model.callbacks.register(5)
    options = dict(seed=args.seed[0], prompt=Path(args.prompt_file).read_text(), width=args.width,
                   height=args.height, num_inference_steps=args.steps,
                   guidance=1, scheduler="flow_match_euler_discrete")
    if args.image_paths:
        options["image_paths"] = args.image_paths
    model.generate_image(**options).save(args.output, False)
    record("cli", low_ram=args.low_ram)


def resolve_restricted(model, registry_key):
    if model != registry_key:
        raise ValueError("Model does not match the restricted registry entry")
    return model


module("huggingface_hub", snapshot_download=snapshot_download, hf_hub_download=snapshot_download)
module("huggingface_hub.errors", LocalEntryNotFoundError=LocalEntryNotFoundError)
module("tqdm.auto", tqdm=FakeProgress)
module("mlx.core", clear_cache=lambda: None)
module("mflux.callbacks.instances.battery_saver", BatterySaver=lambda limit: limit)
module("mflux.callbacks.callback_manager", CallbackManager=CallbackManager)
module("mflux.models.common.resolution.config_resolution", ConfigResolution=types.SimpleNamespace(resolve_restricted=resolve_restricted))
module("mflux.models.common.vae.tiling_config", TilingConfig=TilingConfig)
module("mflux.utils.prompt_util", PromptUtil=types.SimpleNamespace(read_prompt=lambda args: Path(args.prompt_file).read_text()))
for name, class_name in [
    ("flux2.cli.flux2_generate", "Flux2Klein"),
    ("flux2.cli.flux2_edit_generate", "Flux2KleinEdit"),
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
