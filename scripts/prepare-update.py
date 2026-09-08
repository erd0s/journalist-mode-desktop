#!/usr/bin/env python3
"""Prepare a stable Sparkle feed locally; does not upload or publish anything."""
import argparse
import html
import json
import plistlib
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPARKLE = '{http://www.andymatuschak.org/xml-namespaces/sparkle}'


def read_plist(data):
    # The Wails source plist starts at DOCTYPE, without an XML declaration.
    return plistlib.loads(data, fmt=plistlib.FMT_BINARY if data.startswith(b'bplist') else plistlib.FMT_XML)


def stable_version(value):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('Only stable x.y.z releases belong in this feed')
    return tuple(map(int, value.split('.')))


def validate_info(info, expected, feed):
    version = info['CFBundleVersion']
    numeric = stable_version(version)
    if info['CFBundleShortVersionString'] != version:
        raise ValueError('Build and display versions must match')
    for key in ('CFBundleIdentifier', 'SUPublicEDKey', 'SUFeedURL'):
        if info.get(key) != expected[key]:
            raise ValueError(f'Archive has an unexpected {key}')
    if not info.get('SUVerifyUpdateBeforeExtraction'):
        raise ValueError('Archive must require signature verification before extraction')
    for item in ET.parse(feed).findall('./channel/item'):
        previous = item.findtext(f'{SPARKLE}version')
        if previous and numeric <= stable_version(previous):
            raise ValueError('Release version must be newer than every published stable version')
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('notes', type=Path, help='Plain-text release notes')
    parser.add_argument('--output', required=True, type=Path, help='New staging directory')
    args = parser.parse_args()
    archive = args.archive.resolve()
    expected = read_plist((ROOT / 'build/darwin/Info.plist').read_bytes())
    with zipfile.ZipFile(archive) as source:
        info = read_plist(source.read('Journalist Mode.app/Contents/Info.plist'))
    version = validate_info(info, expected, ROOT / 'updates/appcast.xml')
    if version != expected['CFBundleVersion']:
        raise ValueError('Archive version differs from the checked-out release source')
    for name in ('package.json', 'package-lock.json'):
        if json.loads((ROOT / 'frontend' / name).read_text())['version'] != version:
            raise ValueError(f'{name} version differs from the archive')
    if read_plist((ROOT / 'build/darwin/Info.dev.plist').read_bytes())['CFBundleVersion'] != version:
        raise ValueError('Development bundle version differs from the archive')
    with tempfile.TemporaryDirectory(prefix='jm-verify-release-') as temp:
        subprocess.run(['ditto', '-x', '-k', str(archive), temp], check=True)
        app = str(Path(temp) / 'Journalist Mode.app')
        subprocess.run(['codesign', '--verify', '--deep', '--strict', app], check=True)
        subprocess.run(['spctl', '--assess', '--type', 'execute', app], check=True)
    subprocess.run(['bash', str(ROOT / 'scripts/fetch-sparkle.sh')], check=True)
    args.output.mkdir(parents=True, exist_ok=False)
    shutil.copy2(archive, args.output / archive.name)
    shutil.copy2(ROOT / 'updates/appcast.xml', args.output / 'appcast.xml')
    (args.output / f'{archive.stem}.html').write_text(
        '<p>' + '</p><p>'.join(html.escape(p).replace('\n', '<br>') for p in args.notes.read_text().strip().split('\n\n')) + '</p>\n'
    )
    subprocess.run([
        str(ROOT / 'build/sparkle/bin/generate_appcast'), '--account', 'journalist-mode-updates',
        '--download-url-prefix', f'https://github.com/erd0s/journalist-mode-desktop/releases/download/v{version}/',
        '--link', 'https://github.com/erd0s/journalist-mode-desktop/releases',
        '--embed-release-notes', '--maximum-deltas', '0', str(args.output.resolve()),
    ], check=True)
    feed = ET.parse(args.output / 'appcast.xml')
    enclosure = next(item.find('enclosure') for item in feed.findall('./channel/item')
                     if item.findtext(f'{SPARKLE}version') == version)
    if not enclosure.get(f'{SPARKLE}edSignature'):
        raise ValueError('Generated update has no Ed25519 signature')
    subprocess.run([str(ROOT / 'build/sparkle/bin/sign_update'), '--account', 'journalist-mode-updates',
                    '--verify', str(archive), enclosure.get(f'{SPARKLE}edSignature')], check=True)
    print(f'Prepared {args.output / "appcast.xml"}. Upload the unchanged ZIP first, then publish the feed.')


if __name__ == '__main__':
    main()
