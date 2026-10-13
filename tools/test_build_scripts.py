"""Exercise the build CLI without installing tools or cross-compiling binaries."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "linux" and shutil.which("bash"), "requires Linux Bash")
class BuildScriptsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.studio = self.root / "studio"
        self.studio.mkdir()
        for name in ("run.sh", "build-desktop.sh", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "slot.ref"):
            shutil.copyfile(ROOT / name, self.studio / name)
        for name in ("run.sh", "build-desktop.sh"):
            (self.studio / name).chmod(0o755)
        for name in ("src", "shim", "tests"):
            shutil.copytree(ROOT / name, self.studio / name)
        self.slot = self.root / "slot checkout"
        for crate in ("slot-ui", "slot-store"):
            directory = self.slot / "crates" / crate
            directory.mkdir(parents=True)
            (directory / "Cargo.toml").write_text("[package]\n")
        source = self.slot / "crates/slot-ui/src"
        source.mkdir()
        for name in ("cart", "shell", "silhouette", "text"):
            (source / f"{name}.rs").write_text(f"// selected checkout's {name}\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands.jsonl"
        self.env = {
            **os.environ,
            "HOME": str(self.root / "home"),
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "TMPDIR": str(self.root),
            "BUILD_TEST_LOG": str(self.log),
        }
        self.env.pop("CARGO_TARGET_DIR", None)
        self.env.pop("SLOT", None)
        self.stub("node", "#!/bin/sh\nexit 0\n")
        self.stub("npm", "#!/bin/sh\nexit 0\n")
        self.stub("zig", "#!/bin/sh\nexit 0\n")
        self.stub("cargo-zigbuild", "#!/bin/sh\nexit 0\n")
        self.stub("rustup", "#!/bin/sh\nexit 0\n")
        self.stub("cargo", """#!/usr/bin/python3
import os
from pathlib import Path
import sys
target = sys.argv[sys.argv.index('--target') + 1]
directory = Path(os.environ.get('CARGO_TARGET_DIR', 'desktop/target')) / target / 'release'
directory.mkdir(parents=True, exist_ok=True)
(directory / ('cart-studio.exe' if 'windows' in target else 'cart-studio')).write_bytes(b'binary')
""")
        self.stub("wasm-pack", """#!/usr/bin/python3
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
crate = Path(args[1]) if len(args) > 1 and not args[1].startswith('--') else Path.cwd()
out = Path(args[args.index('--out-dir') + 1])
if not out.is_absolute():
    out = crate / out
slot = (crate / '../slot-b').resolve()
with open(os.environ['BUILD_TEST_LOG'], 'a') as log:
    log.write(json.dumps({'crate': str(crate), 'slot': str(slot), 'out': str(out),
                         'target': os.environ.get('CARGO_TARGET_DIR')}) + '\\n')
# Resolve the two Cargo dependencies and all renderer imports from the build tree.
assert (crate / 'shim/slot-store/../../../slot-b/crates/slot-store/Cargo.toml').is_file()
assert (crate / '../slot-b/crates/slot-ui/Cargo.toml').is_file()
for name in ('cart', 'shell', 'silhouette', 'text'):
    assert (crate / f'src/../../slot-b/crates/slot-ui/src/{name}.rs').is_file()
assert (crate / 'tests/fixtures/gba-excerpt.dat').is_file()
if os.environ.get('BUILD_TEST_FAIL'):
    sys.exit(7)
out.mkdir(parents=True, exist_ok=True)
(out / 'slot_cart_studio_bg.wasm').write_bytes(b'wasm')
""")

    def stub(self, name, text):
        path = self.bin / name
        path.write_text(text)
        path.chmod(0o755)

    def run_script(self, name, *args, cwd=None):
        return subprocess.run(
            [str(self.studio / name), *args], cwd=cwd or self.studio,
            env=self.env, text=True, capture_output=True, timeout=20,
        )

    def read_build(self):
        return json.loads(self.log.read_text().splitlines()[-1])

    def test_help_and_bad_arguments_without_dependencies(self):
        for name in ("run.sh", "build-desktop.sh"):
            with self.subTest(script=name):
                help_result = self.run_script(name, "--help")
                self.assertEqual(help_result.returncode, 0, help_result.stderr)
                self.assertIn("--slot-dir PATH", help_result.stdout)
                for args in (("--slot-dir",), ("--slot-dir", ""), ("--slot-dir", "--help"), ("--typo",)):
                    result = self.run_script(name, *args)
                    self.assertNotEqual(result.returncode, 0)
                result = self.run_script(name, "--slot-dir", "missing")
                self.assertIn("slot directory does not exist", result.stderr)
        self.assertFalse(self.log.exists())

    def test_wrong_directory_is_rejected(self):
        result = self.run_script("run.sh", "--slot-dir", str(self.root), "--build-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no slot checkout", result.stderr)
        self.assertFalse(self.log.exists())

    def test_relative_path_with_spaces_from_another_directory(self):
        original_manifest = (self.studio / "Cargo.toml").read_bytes()
        self.env["CARGO_TARGET_DIR"] = "target cache"
        result = self.run_script("run.sh", "--slot-dir", "slot checkout", "--build-only", cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        build = self.read_build()
        self.assertEqual(build["slot"], str(self.slot))
        self.assertEqual(build["target"], str(self.studio / "target cache"))
        self.assertEqual(build["out"], str(self.studio / "web/pkg"))
        self.assertFalse(Path(build["crate"]).exists())
        self.assertFalse((self.root / "slot-b").exists())
        self.assertEqual((self.studio / "Cargo.toml").read_bytes(), original_manifest)
        self.assertTrue((self.studio / "web/pkg/slot_cart_studio_bg.wasm").is_file())

    def test_default_checkout_remains_supported(self):
        (self.root / "slot-b").symlink_to(self.slot, target_is_directory=True)
        result = self.run_script("run.sh", "--build-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_build()["crate"], str(self.studio))
        self.assertEqual(self.read_build()["slot"], str(self.slot))

    def test_custom_checkout_leaves_existing_default_alone(self):
        default = self.root / "slot-b"
        default.mkdir()
        marker = default / "keep.txt"
        marker.write_text("existing checkout")
        result = self.run_script("run.sh", "--build-only", "--slot-dir", str(self.slot))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_build()["slot"], str(self.slot))
        self.assertEqual(marker.read_text(), "existing checkout")

    def test_temporary_tree_is_removed_on_build_failure(self):
        self.env["BUILD_TEST_FAIL"] = "1"
        result = self.run_script("run.sh", "--build-only", "--slot-dir", str(self.slot))
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertFalse(Path(self.read_build()["crate"]).exists())
        self.assertTrue(self.slot.is_dir())

    def test_desktop_forwards_checkout_and_packages_both_platforms(self):
        # Git records run.sh as non-executable; Linux CI must invoke it through Bash.
        (self.studio / "run.sh").chmod(0o644)
        result = self.run_script("build-desktop.sh", "--slot-dir", "slot checkout", cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_build()["slot"], str(self.slot))
        self.assertFalse(Path(self.read_build()["crate"]).exists())
        self.assertTrue((self.studio / "dist/windows-x64/cart-studio.exe").is_file())
        self.assertTrue((self.studio / "dist/macos-arm64/cart-studio").is_file())
        self.assertTrue((self.studio / "dist/macos-arm64/first-run.sh").is_file())


if __name__ == "__main__":
    unittest.main()
