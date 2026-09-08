import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare_update', Path(__file__).with_name('prepare-update.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ReleaseValidation(unittest.TestCase):
    def test_numeric_order_and_prerelease_exclusion(self):
        self.assertGreater(prepare.stable_version('0.10.0'), prepare.stable_version('0.9.9'))
        for value in ('0.7.0-beta.1', 'v0.7.0', '0.7', 'latest', '0.07.0'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                prepare.stable_version(value)

    def test_rejects_downgrade_wrong_identity_key_and_unverified_archives(self):
        expected = dict(CFBundleIdentifier='journalist', SUPublicEDKey='key', SUFeedURL='https://feed')
        info = dict(expected, CFBundleVersion='0.8.0', CFBundleShortVersionString='0.8.0', SUVerifyUpdateBeforeExtraction=True)
        with tempfile.TemporaryDirectory() as temp:
            feed = Path(temp) / 'appcast.xml'
            feed.write_text('<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>0.7.0</sparkle:version></item></channel></rss>')
            self.assertEqual(prepare.validate_info(info, expected, feed), '0.8.0')
            for changes in ({'CFBundleVersion': '0.7.0', 'CFBundleShortVersionString': '0.7.0'},
                            {'SUPublicEDKey': 'wrong'}, {'CFBundleIdentifier': 'another-app'},
                            {'SUVerifyUpdateBeforeExtraction': False}, {'SUFeedURL': 'http://test-feed'},
                            {'CFBundleShortVersionString': '0.9.0'}):
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    prepare.validate_info(dict(info, **changes), expected, feed)


if __name__ == '__main__':
    unittest.main()
