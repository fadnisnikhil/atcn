"""Release guard for the Python package: a version of `atcn` that is already on PyPI must contain exactly the
repository's sources (src/atcn, pyproject.toml, README.md, LICENSE); otherwise the version needs a bump.

Wheels are not byte-reproducible, so this compares the files inside the published sdist. With --strict, a
difference fails instead of warning. Run from the repository root with Python 3.11 or later.
"""

import io
import json
import os
import sys
import tarfile
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

PACKAGE_DIR = Path("packages/sdk-python")
TOP_LEVEL_FILES = ["pyproject.toml", "README.md", "LICENSE"]


def local_files() -> dict[str, bytes]:
    files = {name: (PACKAGE_DIR / name).read_bytes() for name in TOP_LEVEL_FILES}
    for path in sorted((PACKAGE_DIR / "src/atcn").rglob("*.py")):
        files[path.relative_to(PACKAGE_DIR).as_posix()] = path.read_bytes()
    return files


def published_files(release: dict, version: str) -> dict[str, bytes]:
    sdist = next(f for f in release["urls"] if f["packagetype"] == "sdist")
    with urllib.request.urlopen(sdist["url"]) as response:
        archive = tarfile.open(fileobj=io.BytesIO(response.read()), mode="r:gz")
    prefix = f"atcn-{version}/"
    files = {}
    for member in archive.getmembers():
        name = member.name.removeprefix(prefix)
        if member.isfile() and (name in TOP_LEVEL_FILES or (name.startswith("src/atcn/") and name.endswith(".py"))):
            files[name] = archive.extractfile(member).read()
    return files


def main() -> int:
    strict = "--strict" in sys.argv
    level = ("::error::" if strict else "::warning::") if os.environ.get("GITHUB_ACTIONS") == "true" else ("error: " if strict else "warning: ")
    version = tomllib.loads((PACKAGE_DIR / "pyproject.toml").read_text())["project"]["version"]
    try:
        with urllib.request.urlopen(f"https://pypi.org/pypi/atcn/{version}/json") as response:
            release = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            print(f"atcn {version}: not on PyPI yet; it will be published")
            return 0
        raise

    local, published = local_files(), published_files(release, version)
    changed = sorted(name for name in local.keys() | published.keys() if local.get(name) != published.get(name))
    if not changed:
        print(f"atcn {version}: unchanged since it was published")
        return 0
    print(f"{level}atcn {version}: {', '.join(changed)} differ from the published atcn {version}. Bump the version in {PACKAGE_DIR}/pyproject.toml.")
    return 1 if strict else 0


if __name__ == "__main__":
    sys.exit(main())
