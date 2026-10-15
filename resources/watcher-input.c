/**
 * Watcher fork helper (spec O3-O6): Backspace x N and user-input tracking.
 *
 * Long-running. Args: --ignore <vk,vk,...>  virtual keys that never count as user
 * input (the Watcher's hotkeys arrive as real HID keys, not injected ones).
 *
 * stdin commands (one per line)        stdout replies
 *   IDLE                                 IDLE <ms since last real input | -1>
 *   FG                                   FG <foreground hwnd, %p>
 *   BS <n> <hwnd hex>                    OK <sent> | ERR focus [sent] | ERR modifiers | ERR send <sent> | ERR args
 *   ENTER                                OK | ERR modifiers | ERR send   (Watcher "send", O14)
 *   MASK                                 OK | ERR send   (mask a held Alt/Win, see SendMask)
 *   QUIT                                 (exits)
 *
 * Only key-down, mouse button and wheel events count as input; injected events
 * (ours, or other apps' SendInput) are ignored. No key codes are ever printed.
 *
 * Compile: clang -O2 watcher-input.c -o watcher-input.exe -luser32
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_IGNORE 32
#define MAX_BACKSPACE 4000

static DWORD g_ignore[MAX_IGNORE];
static int g_ignoreCount = 0;
static volatile LONGLONG g_lastInput = -1; /* GetTickCount64 of last real input */
static HHOOK g_kbHook = NULL;
static HHOOK g_mouseHook = NULL;
static DWORD g_mainThreadId = 0;

static BOOL IsIgnored(DWORD vk) {
    for (int i = 0; i < g_ignoreCount; i++) {
        if (g_ignore[i] == vk) return TRUE;
    }
    /* Ctrl/Alt/Shift generic vs left/right variants */
    if (vk == VK_LCONTROL || vk == VK_RCONTROL) return IsIgnored(VK_CONTROL);
    if (vk == VK_LMENU || vk == VK_RMENU) return IsIgnored(VK_MENU);
    if (vk == VK_LSHIFT || vk == VK_RSHIFT) return IsIgnored(VK_SHIFT);
    return FALSE;
}

static LRESULT CALLBACK KeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
        const KBDLLHOOKSTRUCT *k = (const KBDLLHOOKSTRUCT *)lParam;
        if (!(k->flags & LLKHF_INJECTED) && !IsIgnored(k->vkCode)) {
            InterlockedExchange64(&g_lastInput, (LONGLONG)GetTickCount64());
        }
    }
    return CallNextHookEx(g_kbHook, nCode, wParam, lParam);
}

static LRESULT CALLBACK MouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && wParam != WM_MOUSEMOVE &&
        wParam != WM_LBUTTONUP && wParam != WM_RBUTTONUP && wParam != WM_MBUTTONUP &&
        wParam != WM_XBUTTONUP) {
        const MSLLHOOKSTRUCT *m = (const MSLLHOOKSTRUCT *)lParam;
        if (!(m->flags & LLMHF_INJECTED)) {
            InterlockedExchange64(&g_lastInput, (LONGLONG)GetTickCount64());
        }
    }
    return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
}

static void Reply(const char *line) {
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

/* The triggering hotkey (e.g. Ctrl+Alt+F10) may still be held; Backspace sent
   now would arrive as Ctrl+Alt+Backspace. */
static BOOL WaitModifiersReleased(DWORD timeoutMs) {
    const int mods[] = {VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN};
    ULONGLONG deadline = GetTickCount64() + timeoutMs;
    for (;;) {
        BOOL held = FALSE;
        for (size_t i = 0; i < sizeof(mods) / sizeof(mods[0]); i++) {
            if (GetAsyncKeyState(mods[i]) & 0x8000) held = TRUE;
        }
        if (!held) return TRUE;
        if (GetTickCount64() >= deadline) return FALSE;
        Sleep(10);
    }
}

/* Backspaces go out one at a time, evenly paced. Bursts are lost: Windows 11
   Notepad (a XAML island) dropped keys when 8 arrived back to back, so a discard
   stopped partway. Sleep(1) lasts a whole 15.6 ms timer tick, so pacing uses a
   high-resolution waitable timer where Windows has one. */
#define BS_GAP_US 2500
#define BS_FOCUS_EVERY 16
#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

static void WaitMicros(HANDLE timer, LONGLONG us) {
    LARGE_INTEGER due;
    due.QuadPart = -10 * us; /* relative, 100 ns units */
    if (timer && SetWaitableTimer(timer, &due, 0, NULL, NULL, FALSE)) {
        WaitForSingleObject(timer, INFINITE);
    } else {
        Sleep(1);
    }
}

/* Returns the number of Backspaces sent; stops early if the target loses focus
   (*focusLost) or SendInput fails. */
static int SendBackspaces(int n, unsigned long long target, BOOL *focusLost) {
    INPUT inputs[2];
    ZeroMemory(inputs, sizeof(inputs));
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_BACK;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_BACK;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
    HANDLE timer = CreateWaitableTimerExW(NULL, NULL, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                          TIMER_ALL_ACCESS);
    if (!timer) timer = CreateWaitableTimerExW(NULL, NULL, 0, TIMER_ALL_ACCESS);
    int sent = 0;
    *focusLost = FALSE;
    for (; sent < n; sent++) {
        if (sent % BS_FOCUS_EVERY == 0 && sent > 0 &&
            (unsigned long long)(ULONG_PTR)GetForegroundWindow() != target) {
            *focusLost = TRUE;
            break;
        }
        if (SendInput(2, inputs, sizeof(INPUT)) != 2) break;
        WaitMicros(timer, BS_GAP_US);
    }
    if (timer) CloseHandle(timer);
    return sent;
}

/* A swap hotkey with Alt (or Win) looks like a lone Alt tap to the target app,
   because RegisterHotKey eats the main key. The tap opens the menu bar (or
   switches layout on Alt+Shift), which swallows the Backspaces and the Ctrl of
   the Ctrl+V that follow. An unassigned key while the modifier is still down
   masks it (AutoHotkey's MenuMaskKey). Sent only while Alt/Win is held. */
#define VK_MASK 0xE8
static int SendMask(void) {
    if (!((GetAsyncKeyState(VK_MENU) | GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) &
          0x8000)) {
        return 1;
    }
    INPUT inputs[2];
    ZeroMemory(inputs, sizeof(inputs));
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_MASK;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_MASK;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput(2, inputs, sizeof(INPUT)) == 2;
}

static int SendEnter(void) {
    INPUT inputs[2];
    ZeroMemory(inputs, sizeof(inputs));
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_RETURN;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_RETURN;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput(2, inputs, sizeof(INPUT)) == 2;
}

static void HandleCommand(char *line) {
    char buf[64];
    line[strcspn(line, "\r\n")] = 0;
    if ((unsigned char)line[0] == 0xEF && (unsigned char)line[1] == 0xBB &&
        (unsigned char)line[2] == 0xBF) {
        memmove(line, line + 3, strlen(line + 3) + 1);
    }

    if (strcmp(line, "IDLE") == 0) {
        LONGLONG last = InterlockedCompareExchange64(&g_lastInput, 0, 0);
        if (last < 0) {
            Reply("IDLE -1");
        } else {
            snprintf(buf, sizeof(buf), "IDLE %lld", (LONGLONG)GetTickCount64() - last);
            Reply(buf);
        }
    } else if (strcmp(line, "FG") == 0) {
        snprintf(buf, sizeof(buf), "FG %p", (void *)GetForegroundWindow());
        Reply(buf);
    } else if (strncmp(line, "BS ", 3) == 0) {
        char *end = NULL;
        long n = strtol(line + 3, &end, 10);
        unsigned long long target = end ? _strtoui64(end, NULL, 16) : 0;
        if (n < 0 || n > MAX_BACKSPACE || target == 0) {
            Reply("ERR args");
        } else if (!WaitModifiersReleased(1500)) {
            Reply("ERR modifiers");
        } else if ((unsigned long long)(ULONG_PTR)GetForegroundWindow() != target) {
            Reply("ERR focus");
        } else {
            BOOL focusLost = FALSE;
            int sent = SendBackspaces((int)n, target, &focusLost);
            if (sent == n) snprintf(buf, sizeof(buf), "OK %d", sent);
            else snprintf(buf, sizeof(buf), "ERR %s %d", focusLost ? "focus" : "send", sent);
            Reply(buf);
        }
    } else if (strcmp(line, "ENTER") == 0) {
        /* A held Shift/Ctrl would turn this into Shift+Enter (newline) or Ctrl+Enter. */
        if (!WaitModifiersReleased(1500)) Reply("ERR modifiers");
        else Reply(SendEnter() ? "OK" : "ERR send");
    } else if (strcmp(line, "MASK") == 0) {
        Reply(SendMask() ? "OK" : "ERR send");
    } else if (strcmp(line, "QUIT") == 0) {
        PostThreadMessage(g_mainThreadId, WM_QUIT, 0, 0);
    } else {
        Reply("ERR unknown");
    }
}

static DWORD WINAPI StdinThread(LPVOID arg) {
    (void)arg;
    char line[256];
    while (fgets(line, sizeof(line), stdin)) {
        HandleCommand(line);
    }
    /* Parent closed stdin: exit with it. */
    PostThreadMessage(g_mainThreadId, WM_QUIT, 0, 0);
    return 0;
}

static void ParseIgnore(const char *list) {
    char copy[256];
    strncpy(copy, list, sizeof(copy) - 1);
    copy[sizeof(copy) - 1] = 0;
    for (char *tok = strtok(copy, ","); tok && g_ignoreCount < MAX_IGNORE; tok = strtok(NULL, ",")) {
        unsigned long vk = strtoul(tok, NULL, 0);
        if (vk > 0 && vk < 256) g_ignore[g_ignoreCount++] = (DWORD)vk;
    }
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc - 1; i++) {
        if (strcmp(argv[i], "--ignore") == 0) ParseIgnore(argv[i + 1]);
    }

    g_mainThreadId = GetCurrentThreadId();
    HINSTANCE inst = GetModuleHandle(NULL);
    g_kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, KeyboardProc, inst, 0);
    g_mouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProc, inst, 0);
    if (!g_kbHook || !g_mouseHook) {
        fprintf(stderr, "Failed to install hooks: %lu\n", GetLastError());
        return 1;
    }

    HANDLE reader = CreateThread(NULL, 0, StdinThread, NULL, 0, NULL);
    if (!reader) return 1;
    Reply("READY");

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    UnhookWindowsHookEx(g_kbHook);
    UnhookWindowsHookEx(g_mouseHook);
    return 0;
}
