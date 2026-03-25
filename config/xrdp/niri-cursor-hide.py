#!/usr/bin/env python3
"""Hide the hardware X11 cursor on niri's window via the XFixes extension.

Called from startwm-niri.sh with the niri window ID as argv[1].
Blocks forever (signal.pause) so the cursor stays hidden until the session ends.
"""
import ctypes
import ctypes.util
import signal
import sys


def main():
    if len(sys.argv) < 2:
        return
    wid = int(sys.argv[1])

    libX11 = ctypes.CDLL("libX11.so.6")
    libX11.XOpenDisplay.restype = ctypes.c_void_p

    xfixes_name = ctypes.util.find_library("Xfixes")
    if not xfixes_name:
        return

    libXfixes = ctypes.CDLL(xfixes_name)
    dpy = libX11.XOpenDisplay(None)
    if not dpy:
        return

    libXfixes.XFixesHideCursor(dpy, wid)
    libX11.XFlush(dpy)
    signal.pause()


main()
