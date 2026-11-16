"""Smoke-test only this app's Win32 controls, in a hidden window.

Uses a separate test executable and synthetic frames, without opening the physical
camera. No other windows are inspected or controlled. Run after build.py.
"""
import ctypes
from ctypes import wintypes
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
user32 = ctypes.WinDLL('user32', use_last_error=True)
user32.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetDlgItem.restype = wintypes.HWND
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]

startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = 0
process = subprocess.Popen([str(ROOT / 'build/CameraFlipGuiTests.exe')], startupinfo=startup)
window = None

def wait(predicate, message, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        if process.poll() is not None:
            raise RuntimeError(f'App exited before the check: {process.returncode}')
        time.sleep(0.05)
    raise RuntimeError(message)

def find_window():
    global window
    @callback_type
    def each(hwnd, _):
        global window
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == process.pid:
            name = ctypes.create_unicode_buffer(128)
            user32.GetWindowTextW(hwnd, name, len(name))
            if name.value.startswith('Camera Flip '):
                window = hwnd
                return False
        return True
    user32.EnumWindows(each, 0)
    return window is not None

def text(hwnd):
    value = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, value, len(value))
    return value.value

try:
    wait(find_window, 'The main window did not initialize.')
    start_button = user32.GetDlgItem(window, 100)
    assert start_button and user32.GetDlgItem(window, 101) and user32.GetDlgItem(window, 102), 'Expected controls are missing'
    assert text(start_button) == 'Start camera', 'Camera should not start automatically'
    assert not user32.IsWindowVisible(window), 'Smoke-test window must stay hidden'
    user32.PostMessageW(window, 0x111, 100, 0)  # WM_COMMAND / Start camera
    wait(lambda: text(start_button) == 'Stop camera', 'Start did not complete.')
    time.sleep(2)
    user32.PostMessageW(window, 0x111, 100, 0)
    wait(lambda: text(start_button) == 'Start camera', 'Stop did not complete.')
    user32.PostMessageW(window, 0x10, 0, 0)  # WM_CLOSE
    assert process.wait(timeout=10) == 0
    print('PASS: isolated native GUI initializes, starts synthetic capture, stops, and closes cleanly (hidden window).')
finally:
    if process.poll() is None:
        if window:
            user32.PostMessageW(window, 0x10, 0, 0)
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)
