import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('reconcile', Path(__file__).parents[1] / 'gateway-reconcile.py')
reconcile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reconcile)


class KernelProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.proc = Path(self.temp.name)
        self.slot = {'task_id': 'BR#6992', 'session': 'dispatch-BR-6992-one', 'attempt_id': '100-123', 'generation': 1}

    def tearDown(self):
        self.temp.cleanup()

    def process(self, data=b'', cwd='/tmp', fd=None):
        process = self.proc / '200'
        process.mkdir()
        (process / 'environ').write_bytes(data)
        (process / 'cmdline').write_bytes(b'unrelated')
        (process / 'cwd').symlink_to(cwd)
        (process / 'fd').mkdir()
        if fd:
            (process / 'fd/3').symlink_to(fd)
        return process

    def proof(self):
        return reconcile.stopped_writer_proof(self.slot, self.proc, os.getuid(), 9999)

    def test_expired_slot_is_not_proof_while_original_daemon_exists(self):
        (self.proc / '100').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'daemon still exists'):
            self.proof()

    def test_full_census_refuses_environment_cwd_and_open_file_scopes(self):
        for kwargs in ({'data': b'attempt=100-123'}, {'cwd': '/work/BR-6992'}, {'fd': '/work/BR-6992/source'}):
            with self.subTest(kwargs=kwargs):
                p = self.process(**kwargs)
                with self.assertRaisesRegex(RuntimeError, 'retains this task scope'):
                    self.proof()
                import shutil
                shutil.rmtree(p)

    def test_incomplete_live_process_scan_never_frees_capacity(self):
        p = self.process()
        (p / 'environ').unlink()
        with self.assertRaisesRegex(RuntimeError, 'fully inspected'):
            self.proof()

    def test_only_complete_absent_scope_census_proves_stopped(self):
        self.process()
        self.assertEqual(self.proof()['processes_inspected'], 1)


if __name__ == '__main__':
    unittest.main()
