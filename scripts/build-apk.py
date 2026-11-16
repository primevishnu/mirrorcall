"""Build and sign MirrorCall with pinned native WebRTC using official Android SDK tools.

Requires Python 3.10+, JDK 17+, Android SDK platform 36 and build-tools 36.0.0.
The signing key stays in .signing/; keep that directory to sign future updates.
"""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import zipfile
import hashlib
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
VERSION_NAME = '2.1.0'
VERSION_CODE = '11'  # must increase for every release so phones accept it as an update
parser = argparse.ArgumentParser()
parser.add_argument('--sdk', default=os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or ('C:/Android/Sdk' if os.name == 'nt' else str(Path.home() / 'Android/Sdk')))
parser.add_argument('--java-home', default=os.environ.get('JAVA_HOME') or '')
parser.add_argument('--test', action='store_true', help='debuggable emulator build (adds x86_64, WebView debugging) written to build/; never for release')
args = parser.parse_args()
sdk = Path(args.sdk)
tools = sdk / 'build-tools/36.0.0'
platform = sdk / 'platforms/android-36/android.jar'
build = ROOT / 'build/apk'
build.mkdir(parents=True, exist_ok=True)
dist = ROOT / 'dist'
dist.mkdir(exist_ok=True)
signing = ROOT / '.signing'
signing.mkdir(exist_ok=True)
env = os.environ.copy()
if args.java_home:
    env['JAVA_HOME'] = args.java_home
    env['PATH'] = str(Path(args.java_home) / 'bin') + os.pathsep + env['PATH']
else:
    # A blank JAVA_HOME breaks the SDK's .bat launchers on Windows.
    env.pop('JAVA_HOME', None)

def java_tool(name):
    executable = name + ('.exe' if os.name == 'nt' else '')
    result = shutil.which(executable, path=env['PATH'])
    if not result:
        raise SystemExit(f'{name} not found. Install a JDK and set JAVA_HOME.')
    return result

def sdk_tool(name):
    suffix = '.exe' if name in ('aapt2', 'zipalign') else '.bat'
    return str(tools / (name + (suffix if os.name == 'nt' else '')))

def run(command):
    subprocess.run([str(x) for x in command], cwd=ROOT, env=env, check=True)

if not platform.is_file() or not tools.is_dir():
    raise SystemExit('Install Android SDK platforms;android-36 and build-tools;36.0.0 first. See README.md.')

# Native call engine: Google's libwebrtc (BSD-3-Clause), maintained build from webrtc-sdk.
WEBRTC_VERSION = '150.7871.04'
WEBRTC_SHA256 = '1872dda4e3bf7d6ea6f7c6e11861332081c57081a1e62fc82fab72415c69c84c'
WEBRTC_ABIS = ['arm64-v8a', 'armeabi-v7a']  # practically every phone; x86 builds are emulator-only
if args.test:
    WEBRTC_ABIS = WEBRTC_ABIS + ['x86_64']
aar = ROOT / '.tools/webrtc' / f'android-{WEBRTC_VERSION}.aar'
if not aar.exists():
    aar.parent.mkdir(parents=True, exist_ok=True)
    url = f'https://repo1.maven.org/maven2/io/github/webrtc-sdk/android/{WEBRTC_VERSION}/android-{WEBRTC_VERSION}.aar'
    print(f'Downloading {url}')
    urllib.request.urlretrieve(url, aar)
if hashlib.sha256(aar.read_bytes()).hexdigest() != WEBRTC_SHA256:
    raise SystemExit(f'{aar} does not match the pinned SHA-256; delete it and rebuild.')
webrtc = build / 'webrtc'
shutil.rmtree(webrtc, ignore_errors=True)
webrtc.mkdir()
with zipfile.ZipFile(aar) as archive:
    archive.extract('classes.jar', webrtc)
    for abi in WEBRTC_ABIS:
        archive.extract(f'jni/{abi}/libjingle_peerconnection_so.so', webrtc)
webrtc_jar = webrtc / 'classes.jar'

manifest = ET.parse(ROOT / 'app/src/main/AndroidManifest.xml')
ET.register_namespace('android', 'http://schemas.android.com/apk/res/android')
manifest.getroot().set('package', 'app.mirrorcall.android')
manifest.write(build / 'AndroidManifest.xml', encoding='utf-8', xml_declaration=True)
run([sdk_tool('aapt2'), 'compile', '--dir', ROOT / 'app/src/main/res', '-o', build / 'resources.zip'])
run([sdk_tool('aapt2'), 'link', '-I', platform, '--manifest', build / 'AndroidManifest.xml', '--min-sdk-version', '26', '--target-sdk-version', '36', '--version-code', VERSION_CODE, '--version-name', VERSION_NAME, *(['--debug-mode'] if args.test else []), '-A', ROOT / 'web', '-o', build / 'unsigned.apk', build / 'resources.zip'])
classes = build / 'classes'
shutil.rmtree(classes, ignore_errors=True)
classes.mkdir()
sources = list((ROOT / 'app/src/main/java').rglob('*.java'))
run([java_tool('javac'), '-encoding', 'UTF-8', '--release', '8', '-Xlint:-options', '-classpath', f'{platform}{os.pathsep}{webrtc_jar}', '-d', classes, *sources])
jar = build / 'classes.jar'
with zipfile.ZipFile(jar, 'w', zipfile.ZIP_DEFLATED) as archive:
    for item in classes.rglob('*.class'):
        archive.write(item, item.relative_to(classes).as_posix())
dex = build / 'dex'
shutil.rmtree(dex, ignore_errors=True)
dex.mkdir()
run([sdk_tool('d8'), '--release', '--lib', platform, '--min-api', '26', '--output', dex, jar, webrtc_jar])
with zipfile.ZipFile(build / 'unsigned.apk', 'a', zipfile.ZIP_DEFLATED) as archive:
    for item in dex.glob('*.dex'):
        archive.write(item, item.name)
    for abi in WEBRTC_ABIS:
        archive.write(webrtc / 'jni' / abi / 'libjingle_peerconnection_so.so', f'lib/{abi}/libjingle_peerconnection_so.so')
run([sdk_tool('zipalign'), '-f', '-p', '4', build / 'unsigned.apk', build / 'aligned.apk'])
password_file = signing / 'password'
keystore = signing / 'mirrorcall.p12'
if not keystore.exists():
    password_file.write_text(secrets.token_urlsafe(32), encoding='utf-8')
    if os.name != 'nt':
        signing.chmod(0o700)
        password_file.chmod(0o600)
    env['MIRRORCALL_BUILD_KEY_PASS'] = password_file.read_text(encoding='utf-8').strip()
    run([java_tool('keytool'), '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'mirrorcall', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=MirrorCall Personal, O=Private Application, C=IN', '-storepass:env', 'MIRRORCALL_BUILD_KEY_PASS', '-keypass:env', 'MIRRORCALL_BUILD_KEY_PASS'])
else:
    if not password_file.exists():
        raise SystemExit('Existing signing key has no password file. Restore .signing/password from your private backup.')
output = (build / 'MirrorCall-test.apk') if args.test else (dist / f'MirrorCall-{VERSION_NAME}.apk')
env['MIRRORCALL_BUILD_KEY_PASS'] = password_file.read_text(encoding='utf-8').strip()
run([sdk_tool('apksigner'), 'sign', '--ks', keystore, '--ks-key-alias', 'mirrorcall', '--ks-pass', 'env:MIRRORCALL_BUILD_KEY_PASS', '--key-pass', 'env:MIRRORCALL_BUILD_KEY_PASS', '--v4-signing-enabled', 'false', '--out', output, build / 'aligned.apk'])
run([sdk_tool('apksigner'), 'verify', '--verbose', output])
output.with_suffix('.apk.sha256').write_text(f'{hashlib.sha256(output.read_bytes()).hexdigest()}  {output.name}\n', encoding='ascii')
print(f'Installable signed APK: {output}')
