import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("updater", Path(__file__).parents[1] / "update-ephor.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = os.getcwd()
        os.chdir(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.write("wrangler.jsonc", '{"name":"template","database_id":"placeholder"}')
        self.write("app.txt", "first\nsecond\nthird\n")
        self.write("removed.txt", "obsolete")
        self.write("packages/api/migrations/0001.sql", "CREATE TABLE test(id);")
        self.base = self.commit()
        self.write("app.txt", "updated\nsecond\nthird\n")
        Path("removed.txt").unlink()
        self.write("packages/api/migrations/0002.sql", "CREATE TABLE next(id);")
        self.write(".github/workflows/new.yml", "must not install automatically")
        self.target = self.commit()
        self.git("checkout", "--orphan", "installation")
        self.git("read-tree", "--reset", "-u", self.base)
        self.write("wrangler.jsonc", '{"name":"private-host","database_id":"real-id","route":"panel.example.com"}')
        self.write("private.txt", "host customization")
        self.write(".github/workflows/local.yml", "host workflow")
        self.write(".ephor-upstream.json", json.dumps({"commit": self.base}))
        self.commit()

    def tearDown(self):
        os.chdir(self.old)
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL).decode().strip()

    def write(self, name, value):
        path = Path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def test_unrelated_private_copy_preserves_settings_and_removes_obsolete_files(self):
        config = Path("wrangler.jsonc").read_bytes()
        self.assertTrue(updater.prepare(self.target))
        self.assertEqual(Path("wrangler.jsonc").read_bytes(), config)
        self.assertEqual(Path("private.txt").read_text(), "host customization")
        self.assertEqual(Path("app.txt").read_text(), "updated\nsecond\nthird\n")
        self.assertFalse(Path("removed.txt").exists())
        self.assertTrue(Path("packages/api/migrations/0002.sql").exists())
        self.assertFalse(Path(".github/workflows/new.yml").exists())
        self.assertTrue(Path(".github/workflows/local.yml").exists())
        self.commit()
        self.assertFalse(updater.prepare(self.target))

    def test_conflict_leaves_installation_untouched(self):
        self.write("app.txt", "host edit\nsecond\nthird\n")
        self.commit()
        with self.assertRaisesRegex(ValueError, "conflict"):
            updater.prepare(self.target)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(Path("app.txt").read_text(), "host edit\nsecond\nthird\n")

    def changed_target(self, path):
        self.git("checkout", "--detach", self.target)
        self.write(path, "incompatible change")
        target = self.commit()
        self.git("checkout", "installation")
        return target

    def test_configuration_change_requires_manual_migration(self):
        with self.assertRaisesRegex(ValueError, "configuration migration"):
            updater.prepare(self.changed_target("wrangler.jsonc"))
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_existing_migrations_cannot_be_rewritten(self):
        with self.assertRaisesRegex(ValueError, "Existing migration"):
            updater.prepare(self.changed_target("packages/api/migrations/0001.sql"))
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_dirty_tree_is_rejected(self):
        self.write("private.txt", "unsaved")
        with self.assertRaisesRegex(ValueError, "clean"):
            updater.prepare(self.target)

    def test_repeated_update_preserves_version_and_workflow_customizations(self):
        updater.prepare(self.target)
        self.commit()
        self.git("checkout", "--detach", self.target)
        self.write("new-feature.txt", "second update")
        self.write(".github/workflows/new.yml", "new workflow revision")
        next_target = self.commit()
        self.git("checkout", "installation")
        self.assertTrue(updater.prepare(next_target))
        self.assertTrue(Path("new-feature.txt").exists())
        self.assertFalse(Path(".github/workflows/new.yml").exists())
        self.assertEqual(json.loads(Path(".ephor-upstream.json").read_text())["commit"], next_target)
        self.assertIn("real-id", Path("wrangler.jsonc").read_text())

    def test_compatible_local_edits_survive(self):
        self.write("private.txt", "updated local customization")
        self.commit()
        self.assertTrue(updater.prepare(self.target))
        self.assertEqual(Path("private.txt").read_text(), "updated local customization")

    def test_downgrade_rejected(self):
        updater.prepare(self.target)
        self.commit()
        with self.assertRaises(subprocess.CalledProcessError):
            updater.prepare(self.base)
        self.assertEqual(self.git("status", "--porcelain"), "")
