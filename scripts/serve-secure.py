#!/usr/bin/env python3
"""Launch KIRA with a credential held only in this process and its child env."""
import argparse
import getpass
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--production", action="store_true", help="Serve the built app and API together")
    args = parser.parse_args()
    node = shutil.which("node")
    if not node:
        parser.error("Node.js 22.14 or newer is required.")
    environment = os.environ.copy()
    if not environment.get("GEMINI_API_KEY", "").strip():
        if not sys.stdin.isatty():
            parser.error("Set GEMINI_API_KEY in the process environment, or run from an interactive terminal for a hidden prompt.")
        credential = getpass.getpass("Gemini API key (hidden, never saved): ").strip()
        if not credential:
            parser.error("A Gemini API key is required. No credential was saved.")
        environment["GEMINI_API_KEY"] = credential
    root = Path(__file__).resolve().parent.parent
    command = [node, "server/dev.mjs"]
    if args.production:
        command.append("--production")
    try:
        process = subprocess.Popen(command, cwd=root, env=environment)
        try:
            return process.wait()
        except KeyboardInterrupt:
            process.terminate()
            return process.wait()
    finally:
        environment.pop("GEMINI_API_KEY", None)


if __name__ == "__main__":
    raise SystemExit(main())
