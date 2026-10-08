#!/usr/bin/python3
"""Fake MFLUX environment: executes Luvox's real worker without loading weights."""
import argparse
import base64
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time
import types

events = Path(__file__).with_suffix(".events")


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
    parser.add_argument("--low-ram", action="store_true")
    parser.add_argument("--vae-tiling", action="store_true")
    parser.set_defaults(battery_percentage_stop_limit=10, scheduler="linear")
    original_parse = parser.parse_args

    def parse_args():
        args = original_parse()
        if args.image_paths:
            args.image_paths = [args.image_paths]
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
        self.callbacks = types.SimpleNamespace(register=lambda callback: self.registered.append(callback))
        self.registered = []
        self.tiling_config = None
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
    module("mflux.models." + name, build_parser=build_parser, **{class_name: type(class_name, (Model,), {})})

if sys.argv[1] == "-u":
    sys.argv = sys.argv[3:]
    runpy.run_path(sys.argv[0], run_name="__main__")
else:
    args = build_parser().parse_args()
    record("cli", low_ram=args.low_ram)
    Image(dict(prompt=Path(args.prompt_file).read_text(), width=args.width, height=args.height)).save(args.output, False)
