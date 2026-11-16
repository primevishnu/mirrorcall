"""Build CameraFlip.exe with Visual Studio C++ Build Tools + a Windows 10/11 SDK.

No downloads and no driver/registry changes are performed. /MT links the C++ runtime
statically, so the output needs neither Python nor .NET nor a VC runtime installer.
"""
from pathlib import Path
import os
import subprocess
import hashlib
import json
import zipfile
import shutil
import re

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / 'build'
BUILD.mkdir(exist_ok=True)
VERSION = (ROOT / 'VERSION').read_text(encoding='ascii').strip()
if not re.fullmatch(r'\d+\.\d+\.\d+', VERSION):
    raise SystemExit('VERSION must contain major.minor.patch.')
EXE_NAME = f'CameraFlip-{VERSION}.exe'
(BUILD / 'app_version.h').write_text(f'#pragma once\n#define CAMERA_FLIP_VERSION L"{VERSION}"\n', encoding='ascii')
vswhere = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
if not vswhere.exists():
    raise SystemExit('Install Visual Studio C++ Build Tools with the Windows SDK first.')
result = subprocess.run([str(vswhere), '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'], capture_output=True, text=True, check=True)
installations = json.loads(result.stdout)
if not installations:
    raise SystemExit('No Visual Studio C++ compiler installation found.')
vcvars = Path(installations[0]['installationPath']) / 'VC/Auxiliary/Build/vcvars64.bat'
environment_script = BUILD / 'environment.cmd'
environment_script.write_text(f'@echo off\ncall "{vcvars}" >nul\nif errorlevel 1 exit /b 1\nset\n', encoding='utf-8')
result = subprocess.run(['cmd.exe', '/d', '/c', str(environment_script)], capture_output=True, text=True, errors='replace', check=True)
env = os.environ.copy()
for line in result.stdout.splitlines():
    if '=' in line and not line.startswith('='):
        key, value = line.split('=', 1)
        env[key.upper()] = value

def run(args):
    command = [str(x) for x in args]
    if command[0] in ('cl.exe', 'link.exe'):
        command[0] = str(Path(env['VCTOOLSINSTALLDIR']) / 'bin/Hostx64/x64' / command[0])
    elif command[0] == 'rc.exe':
        command[0] = str(Path(env['WINDOWSSDKDIR']) / 'bin' / env['WINDOWSSDKVERSION'].rstrip('\\/') / 'x64/rc.exe')
    subprocess.run(command, cwd=BUILD, env=env, check=True)

common = ['/nologo', '/O2', '/MT', '/guard:cf', '/DUNICODE', '/D_UNICODE', '/DNOMINMAX', '/DWIN32_LEAN_AND_MEAN', '/D_WIN32_WINNT=0x0A00', '/D_CRT_SECURE_NO_WARNINGS', '/utf-8', '/I' + str(BUILD)]
vendor = ROOT / 'vendor/obs'
for name in ['shared-memory-queue', 'tiny-nv12-scale']:
    run(['cl.exe', *common, '/std:c17', '/TC', '/c', '/FIstdlib.h', '/FIstring.h', vendor / (name + '.c'), '/Fo' + str(BUILD / (name + '.obj'))])
for name in ['capture', 'main']:
    run(['cl.exe', *common, '/EHsc', '/std:c++17', '/W4', '/permissive-', '/c', ROOT / 'src' / (name + '.cpp'), '/Fo' + str(BUILD / (name + '.obj'))])
run(['cl.exe', *common, '/EHsc', '/std:c++17', '/W4', '/permissive-', '/c', ROOT / 'tests/native_tests.cpp', '/Fo' + str(BUILD / 'native_tests.obj')])
run(['cl.exe', *common, '/DCAMERA_FLIP_GUI_TEST', '/EHsc', '/std:c++17', '/W4', '/permissive-', '/c', ROOT / 'src/main.cpp', '/Fo' + str(BUILD / 'main_gui_test.obj')])
version_tuple = VERSION.replace('.', ',') + ',0'
(BUILD / 'version.rc').write_text(f'''#include <windows.h>
1 VERSIONINFO
FILEVERSION {version_tuple}
PRODUCTVERSION {version_tuple}
FILEFLAGSMASK 0x3fL
FILEOS VOS_NT_WINDOWS32
FILETYPE VFT_APP
BEGIN
 BLOCK "StringFileInfo"
 BEGIN
  BLOCK "040904B0"
  BEGIN
   VALUE "FileDescription", "Camera Flip"
   VALUE "FileVersion", "{VERSION}"
   VALUE "ProductName", "Camera Flip"
   VALUE "ProductVersion", "{VERSION}"
   VALUE "OriginalFilename", "{EXE_NAME}"
  END
 END
 BLOCK "VarFileInfo"
 BEGIN
  VALUE "Translation", 0x0409, 1200
 END
END
''', encoding='ascii')
run(['rc.exe', '/nologo', '/fo', BUILD / 'version.res', BUILD / 'version.rc'])
objects = [BUILD / (name + '.obj') for name in ['capture', 'shared-memory-queue', 'tiny-nv12-scale']]
libraries = ['mfplat.lib', 'mf.lib', 'mfreadwrite.lib', 'mfuuid.lib', 'ole32.lib', 'oleaut32.lib', 'strmiids.lib', 'user32.lib', 'gdi32.lib', 'shell32.lib', 'comctl32.lib']
link = ['/nologo', '/DYNAMICBASE', '/NXCOMPAT', '/GUARD:CF', '/OPT:REF', '/OPT:ICF']
run(['link.exe', *link, '/SUBSYSTEM:WINDOWS', '/MANIFEST:EMBED', '/MANIFESTINPUT:' + str(ROOT / 'src/app.manifest'), '/OUT:' + str(ROOT / EXE_NAME), BUILD / 'main.obj', BUILD / 'version.res', *objects, *libraries])
run(['link.exe', *link, '/SUBSYSTEM:WINDOWS', '/MANIFEST:EMBED', '/MANIFESTINPUT:' + str(ROOT / 'src/app.manifest'), '/OUT:' + str(BUILD / 'CameraFlipGuiTests.exe'), BUILD / 'main_gui_test.obj', *objects, *libraries])
run(['link.exe', *link, '/SUBSYSTEM:CONSOLE', '/OUT:' + str(BUILD / 'CameraFlipTests.exe'), BUILD / 'native_tests.obj', *objects, *libraries])
run([BUILD / 'CameraFlipTests.exe'])
run([BUILD / 'CameraFlipTests.exe', '--list'])
exe = ROOT / EXE_NAME
digest = hashlib.sha256(exe.read_bytes()).hexdigest()
exe.with_suffix('.exe.sha256').write_text(f'{digest}  {exe.name}\n', encoding='ascii')
print(f'Built {exe} ({exe.stat().st_size:,} bytes)')
try:
    shutil.copy2(exe, ROOT / 'CameraFlip.exe')
    (ROOT / 'CameraFlip.exe.sha256').write_text(f'{digest}  CameraFlip.exe\n', encoding='ascii')
except PermissionError:
    print(f'The old CameraFlip.exe is open. Close it, then launch {EXE_NAME} to use the update.')
bundle = ROOT / 'CameraFlip-Windows-x64.zip'
with zipfile.ZipFile(bundle, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in [EXE_NAME, EXE_NAME + '.sha256', 'README.md', 'VALIDATION.md', 'CHANGELOG.md', 'VERSION', 'build.py']:
        file = ROOT / name
        archive.write(file, 'CameraFlip/' + name)
    for directory in ['src', 'tests', 'vendor']:
        for file in (ROOT / directory).rglob('*'):
            if file.is_file():
                archive.write(file, 'CameraFlip/' + file.relative_to(ROOT).as_posix())
print(f'Portable app + complete GPL source: {bundle}')
