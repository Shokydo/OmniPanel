/*
 * OmniPanel — установщик и запускалка в одном exe.
 *
 * Вид — как у консоли (чёрное окно, моноширинный шрифт), но управление
 * обычное: кнопки внизу окна, мышь и клавиатура (Enter — главная, Esc — выход).
 *
 * Первый запуск:  распаковывает панель в %LOCALAPPDATA%\OmniPanel, делает ярлыки,
 *                 включает автообновление. Запуск панели — кнопкой.
 * Дальше:         тот же exe показывает, что панель уже стоит, и предлагает
 *                 запустить её, переустановить или закрыть окно.
 *
 * Внутри exe лежит zip с панелью: он дописан в конец файла и помечен
 * трейлером "OMNIUPD1" + размер (8 байт, little-endian).
 *
 * Сборка для Windows:
 *   x86_64-w64-mingw32-windres -c 65001 omni.rc -O coff -o omni.res.o
 *   x86_64-w64-mingw32-gcc -O2 -mwindows -o OmniPanel-Setup.exe installer.c omni.res.o \
 *     -lgdi32 -lshell32 -lole32 -luuid
 * Проверка на Linux:   gcc -DPOSIX_TEST -o selftest installer.c && ./selftest --selftest <exe> <куда>
 */
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define TRAILER_MAGIC "OMNIUPD1"
#define TRAILER_LEN 16          /* 8 байт магии + 8 байт длины */
#define APP_FOLDER "OmniPanel"
#define APP_EXE "OmniPanel.exe"
#define UPDATE_REPO "Shokydo/OmniPanel"
#define UPDATE_BRANCH "main"
#define APP_VERSION "1.14.0"

/* ─────────────────────────── переносимое: полезная нагрузка ─────────────────────────── */

/* Читает трейлер: смещение и длину встроенного архива. 0 — успех. */
static int payload_offset(const char *self, long *offset, long *length) {
  FILE *f = fopen(self, "rb");
  if (!f) return 1;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return 1; }
  long total = ftell(f);
  if (total < TRAILER_LEN) { fclose(f); return 1; }
  if (fseek(f, total - TRAILER_LEN, SEEK_SET) != 0) { fclose(f); return 1; }
  unsigned char tr[TRAILER_LEN];
  if (fread(tr, 1, TRAILER_LEN, f) != TRAILER_LEN) { fclose(f); return 1; }
  fclose(f);
  if (memcmp(tr, TRAILER_MAGIC, 8) != 0) return 2;
  unsigned long long size = 0;
  for (int i = 7; i >= 0; i -= 1) size = (size << 8) | tr[8 + i];
  if (size == 0 || (long long)size > total - TRAILER_LEN) return 3;
  *offset = (long)(total - TRAILER_LEN - (long long)size);
  *length = (long)size;
  return 0;
}

/* Вырезает встроенный архив в отдельный файл. 0 — успех. */
static int payload_write(const char *self, const char *dest, long *written) {
  long offset = 0, length = 0;
  int rc = payload_offset(self, &offset, &length);
  if (rc != 0) return rc;
  FILE *in = fopen(self, "rb");
  if (!in) return 4;
  FILE *out = fopen(dest, "wb");
  if (!out) { fclose(in); return 5; }
  if (fseek(in, offset, SEEK_SET) != 0) { fclose(in); fclose(out); return 4; }
  char buf[65536];
  long left = length;
  while (left > 0) {
    size_t want = left > (long)sizeof(buf) ? sizeof(buf) : (size_t)left;
    size_t got = fread(buf, 1, want, in);
    if (got == 0) break;
    if (fwrite(buf, 1, got, out) != got) { fclose(in); fclose(out); return 5; }
    left -= (long)got;
  }
  fclose(in);
  fclose(out);
  if (written) *written = length - left;
  return (left == 0) ? 0 : 5;
}

/* ─────────────────────────── Windows ─────────────────────────── */

#ifdef _WIN32

#include <windows.h>
#include <windowsx.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <ole2.h>

/* ── оформление в духе консоли ── */
#define BG_COLOR      RGB(10, 10, 10)
#define TEXT_COLOR    RGB(226, 226, 226)
#define DIM_COLOR     RGB(138, 138, 138)
#define LINE_COLOR    RGB(58, 58, 58)
#define BTN_LINE      RGB(150, 150, 150)
#define BTN_LINE_HOT  RGB(255, 255, 255)
#define BTN_LINE_OFF  RGB(62, 62, 62)
#define BTN_FILL_HOT  RGB(240, 240, 240)
#define BTN_TEXT_OFF  RGB(96, 96, 96)

#define MAX_LINES 600
#define MAX_BTN 4
#define LINE_CHARS 400

#define MARGIN      18
#define LINE_H      20
#define BTN_H       32
#define BAR_H       54
#define PROGRESS_H  6

enum { ST_WELCOME = 1, ST_ALREADY, ST_INSTALLING, ST_QUESTION, ST_DONE, ST_ERROR };
enum { B_INSTALL = 1, B_CANCEL, B_RUN, B_REINSTALL, B_CLOSE, B_OPEN, B_MOVE, B_FRESH, B_PATH };

#define WM_APP_LOG   (WM_APP + 1)
#define WM_APP_STATE (WM_APP + 2)
#define WM_APP_ASK   (WM_APP + 3)

typedef struct Btn { int id; char label[48]; int enabled; RECT rc; } Btn;

static char g_lines[MAX_LINES][LINE_CHARS];
static int g_lineCount;
static CRITICAL_SECTION g_lock;

static HWND g_wnd;
static HFONT g_font;
static int g_state = ST_WELCOME;
static int g_progress = -1;
static int g_scale = 1;          /* 1 = 96 dpi, дальше по масштабу Windows */
static int g_btnCount;
static int g_hoverId = -1, g_pressedId = -1, g_focus = 0;
static Btn g_btn[MAX_BTN];
static HANDLE g_evtAnswer;
static int g_answer;
static int g_started;            /* установка уже запускалась в этом окне */
static int g_force;              /* --reinstall: ставим даже если панель уже есть */

static char g_self[MAX_PATH];
static char g_base[MAX_PATH];
static char g_install[MAX_PATH];
static char g_exe[MAX_PATH];
static char g_version[32] = APP_VERSION;

/* ── мелкие помощники ── */

static int S(int v) { return (int)((double)v * g_scale + 0.5); }

static void to_wide(const char *s, wchar_t *out, int n) {
  if (n <= 0) return;
  int got = MultiByteToWideChar(CP_UTF8, 0, s, -1, out, n);
  if (got <= 0) { out[0] = 0; return; }
  out[n - 1] = 0;
}

static void to_utf8(const wchar_t *w, char *out, int n) {
  if (n <= 0) return;
  int got = WideCharToMultiByte(CP_UTF8, 0, w, -1, out, n, NULL, NULL);
  if (got <= 0) { out[0] = 0; return; }
  out[n - 1] = 0;
}

static int path_join(char *out, size_t n, const char *a, const char *b) {
  return snprintf(out, n, "%s\\%s", a, b) > 0;
}

static int local_appdata(char *out, size_t n) {
  const char *p = getenv("LOCALAPPDATA");
  if (p && *p) { snprintf(out, n, "%s", p); return 0; }
  char buf[MAX_PATH];
  if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, buf))) {
    snprintf(out, n, "%s", buf);
    return 0;
  }
  return 1;
}

static int file_exists(const char *path) {
  DWORD a = GetFileAttributesA(path);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static int dir_exists(const char *path) {
  DWORD a = GetFileAttributesA(path);
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

static int make_dir(const char *path) {
  if (dir_exists(path)) return 0;
  if (CreateDirectoryA(path, NULL)) return 0;
  return 1;
}

/* ── выбранный путь установки запоминается между запусками ── */

static void setup_state_file(char *out, size_t n) {
  char base[MAX_PATH], dir[MAX_PATH];
  out[0] = 0;
  if (local_appdata(base, sizeof(base)) != 0) return;
  path_join(dir, sizeof(dir), base, "OmniPanel-setup");
  make_dir(dir);
  path_join(out, n, dir, "install-path.txt");
}

static int remember_load(char *out, size_t n) {
  char file[MAX_PATH];
  setup_state_file(file, sizeof(file));
  if (!file[0] || !file_exists(file)) return 1;
  FILE *f = fopen(file, "rb");
  if (!f) return 1;
  char buf[MAX_PATH];
  size_t got = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  buf[got] = 0;
  while (got > 0 && (buf[got - 1] == '\n' || buf[got - 1] == '\r' || buf[got - 1] == ' ')) buf[--got] = 0;
  if (!buf[0]) return 1;
  snprintf(out, n, "%s", buf);
  return 0;
}

static void remember_save(const char *dir) {
  char file[MAX_PATH];
  setup_state_file(file, sizeof(file));
  if (!file[0]) return;
  FILE *f = fopen(file, "wb");
  if (!f) return;
  fprintf(f, "%s\n", dir);
  fclose(f);
}

/* Дописывает подпапку OmniPanel, если её ещё нет в конце пути. */
static void with_app_folder(const char *chosen, char *out, size_t n) {
  const char *tail = strrchr(chosen, '\\');
  tail = tail ? tail + 1 : chosen;
  if (_stricmp(tail, APP_FOLDER) == 0) {
    snprintf(out, n, "%s", chosen);                 /* уже папка OmniPanel — ставим прямо в неё */
    return;
  }
  size_t len = strlen(chosen);
  if (len && chosen[len - 1] == '\\') snprintf(out, n, "%s%s", chosen, APP_FOLDER);
  else snprintf(out, n, "%s\\%s", chosen, APP_FOLDER);
}

/* Системный диалог «выбери папку»: современный (Unicode), с запасным старым. */
static int pick_folder(char *out, size_t n) {
  static const CLSID clsid_file_open_dialog =
    { 0xDC1C5A9C, 0xE88A, 0x4DDE, { 0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7 } };
  static const IID iid_file_open_dialog =
    { 0xD57C7288, 0xD4AD, 0x4768, { 0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60 } };

  IFileOpenDialog *dlg = NULL;
  if (SUCCEEDED(CoCreateInstance(&clsid_file_open_dialog, NULL, CLSCTX_INPROC_SERVER,
                                 &iid_file_open_dialog, (void **)&dlg)) && dlg) {
    DWORD opts = 0;
    if (SUCCEEDED(dlg->lpVtbl->GetOptions(dlg, &opts))) {
      dlg->lpVtbl->SetOptions(dlg, opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM |
                                    FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
    }
    wchar_t title[160];
    MultiByteToWideChar(CP_UTF8, 0, "Куда установить OmniPanel — выбери папку", -1, title, 160);
    dlg->lpVtbl->SetTitle(dlg, title);
    dlg->lpVtbl->SetOkButtonLabel(dlg, L"Установить сюда");

    HRESULT hr = dlg->lpVtbl->Show(dlg, g_wnd);
    if (SUCCEEDED(hr)) {
      IShellItem *item = NULL;
      if (SUCCEEDED(dlg->lpVtbl->GetResult(dlg, &item)) && item) {
        PWSTR wpath = NULL;
        if (SUCCEEDED(item->lpVtbl->GetDisplayName(item, SIGDN_FILESYSPATH, &wpath)) && wpath) {
          char chosen[MAX_PATH];
          to_utf8(wpath, chosen, sizeof(chosen));
          CoTaskMemFree(wpath);
          item->lpVtbl->Release(item);
          dlg->lpVtbl->Release(dlg);
          if (chosen[0]) { with_app_folder(chosen, out, n); return 0; }
          return 1;
        }
        item->lpVtbl->Release(item);
      }
    }
    dlg->lpVtbl->Release(dlg);
    return 1;                       /* отмена — путь не меняем */
  }

  /* запасной путь для очень старых систем */
  BROWSEINFOA bi;
  memset(&bi, 0, sizeof(bi));
  bi.hwndOwner = g_wnd;
  PCSTR title_a = "Куда установить OmniPanel - выбери папку";
  bi.lpszTitle = title_a;
  bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
  LPITEMIDLIST pidl = SHBrowseForFolderA(&bi);
  if (!pidl) return 1;
  char path[MAX_PATH];
  int got = SHGetPathFromIDListA(pidl, path);
  CoTaskMemFree(pidl);
  if (!got || !path[0]) return 1;
  with_app_folder(path, out, n);
  return 0;
}

/* Путь, где нужны права администратора — предупреждаем заранее. */
static int needs_admin(const char *dir) {
  const char *keys[] = { "\\Program Files", "\\Program Files (x86)", "\\Windows" };
  for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i += 1) {
    if (strstr(dir, keys[i]) != NULL) return 1;
  }
  return 0;
}


static int run_wait(const char *cmdline, int hidden) {
  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si));
  memset(&pi, 0, sizeof(pi));
  si.cb = sizeof(si);
  if (hidden) {
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
  }
  char cmd[4096];
  snprintf(cmd, sizeof(cmd), "%s", cmdline);
  if (!CreateProcessA(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) return 1;
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  return (int)code;
}

static void run_detached(const char *cmdline) {
  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si));
  memset(&pi, 0, sizeof(pi));
  si.cb = sizeof(si);
  char cmd[4096];
  snprintf(cmd, sizeof(cmd), "%s", cmdline);
  if (CreateProcessA(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }
}

static int extract_zip(const char *zip, const char *dest) {
  char cmd[4096];
  snprintf(cmd, sizeof(cmd), "tar.exe -x -f \"%s\" -C \"%s\"", zip, dest);
  int rc = run_wait(cmd, 1);
  if (rc != 0) {
    snprintf(cmd, sizeof(cmd),
             "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
             "\"Expand-Archive -LiteralPath '%s' -DestinationPath '%s' -Force\"", zip, dest);
    rc = run_wait(cmd, 1);
  }
  return rc;
}

static void make_shortcut(const char *lnk, const char *target, const char *workdir) {
  char cmd[4096];
  snprintf(cmd, sizeof(cmd),
           "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
           "\"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');"
           "$s.TargetPath='%s';$s.WorkingDirectory='%s';$s.IconLocation='%s,0';$s.Save()\"",
           lnk, target, workdir, target);
  run_wait(cmd, 1);
}

static void desktop_dir(char *out, size_t n) {
  char buf[MAX_PATH];
  out[0] = 0;
  if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, buf))) snprintf(out, n, "%s", buf);
}

static void programs_dir(char *out, size_t n) {
  char buf[MAX_PATH];
  out[0] = 0;
  if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_PROGRAMS, NULL, 0, buf))) snprintf(out, n, "%s", buf);
}

/* Ищет прежние данные панели рядом с установщиком и в папках по соседству. */
static int find_old_data(const char *self, char *out, size_t n) {
  char dir[MAX_PATH];
  snprintf(dir, sizeof(dir), "%s", self);
  char *slash = strrchr(dir, '\\');
  if (slash) *slash = 0;
  else snprintf(dir, sizeof(dir), ".");

  static const char *variants[] = {
    "OmniPanelData",
    "OmniPanel\\OmniPanelData",
    "LocalPanelData",
    "OmniPanel\\LocalPanelData",
  };
  for (size_t i = 0; i < sizeof(variants) / sizeof(variants[0]); i += 1) {
    char candidate[MAX_PATH], probe[MAX_PATH];
    snprintf(candidate, sizeof(candidate), "%s\\%s", dir, variants[i]);
    snprintf(probe, sizeof(probe), "%s\\servers.json", candidate);
    if (file_exists(probe)) {
      snprintf(out, n, "%s", candidate);
      return 0;
    }
  }
  return 1;
}

static int copy_tree(const char *from, const char *to) {
  char cmd[4096];
  snprintf(cmd, sizeof(cmd), "xcopy \"%s\" \"%s\" /E /I /H /Y /Q", from, to);
  int rc = run_wait(cmd, 1);
  if (rc != 0) {
    snprintf(cmd, sizeof(cmd),
             "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
             "\"New-Item -ItemType Directory -Force -Path '%s' | Out-Null;"
             "Copy-Item -LiteralPath '%s\\*' -Destination '%s' -Recurse -Force\"", to, from, to);
    rc = run_wait(cmd, 1);
  }
  return rc;
}

/* ── автообновление: настройки по умолчанию ── */
static void seed_settings(const char *install_dir) {
  char data[MAX_PATH], cfg[MAX_PATH];
  path_join(data, sizeof(data), install_dir, "OmniPanelData");
  make_dir(data);
  path_join(cfg, sizeof(cfg), data, "panel.json");
  if (file_exists(cfg)) return;   /* настройки пользователя не трогаем */
  FILE *f = fopen(cfg, "wb");
  if (!f) return;
  fprintf(f,
          "{\n"
          "  \"updateRepo\": \"%s\",\n"
          "  \"updateBranch\": \"%s\",\n"
          "  \"updateAuto\": true,\n"
          "  \"updateAutoInstall\": true,\n"
          "  \"startMode\": \"window\"\n"
          "}\n",
          UPDATE_REPO, UPDATE_BRANCH);
  fclose(f);
}

/* ── журнал как в консоли ── */

static void ui_log(const char *fmt, ...) {
  char buf[LINE_CHARS];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);

  EnterCriticalSection(&g_lock);
  if (g_lineCount >= MAX_LINES) {
    memmove(g_lines[0], g_lines[1], (size_t)(MAX_LINES - 1) * LINE_CHARS);
    g_lineCount = MAX_LINES - 1;
  }
  snprintf(g_lines[g_lineCount], LINE_CHARS, "%s", buf);
  g_lineCount += 1;
  LeaveCriticalSection(&g_lock);

  if (g_wnd) PostMessageA(g_wnd, WM_APP_LOG, 0, 0);
}

static void ui_progress(int value) {
  g_progress = value;
  if (g_wnd) PostMessageA(g_wnd, WM_APP_LOG, 0, 0);
}

/* ── кнопки ── */

static void set_buttons(const Btn *list, int count) {
  g_btnCount = count > MAX_BTN ? MAX_BTN : count;
  for (int i = 0; i < g_btnCount; i += 1) {
    g_btn[i] = list[i];
    SetRect(&g_btn[i].rc, 0, 0, 0, 0);
  }
  g_hoverId = -1;
  g_pressedId = -1;
  g_focus = 0;
}

static int text_width(const char *utf8) {
  if (!g_wnd) return S(120);
  wchar_t w[96];
  to_wide(utf8, w, 96);
  HDC dc = GetDC(g_wnd);
  HGDIOBJ old = SelectObject(dc, g_font);
  SIZE sz = { 0, 0 };
  GetTextExtentPoint32W(dc, w, (int)wcslen(w), &sz);
  SelectObject(dc, old);
  ReleaseDC(g_wnd, dc);
  return sz.cx;
}

static void layout_buttons(void) {
  RECT rc;
  if (!g_wnd) return;
  GetClientRect(g_wnd, &rc);
  int total = 0;
  for (int i = 0; i < g_btnCount; i += 1) total += text_width(g_btn[i].label) + S(34) + S(10);
  int x = rc.right - MARGIN;
  if (x - total < MARGIN) x = MARGIN + total;         /* окно узкое — прижимаем влево */
  int y = rc.bottom - (BAR_H + BTN_H) / 2 * g_scale - S(2);
  for (int i = 0; i < g_btnCount; i += 1) {
    int bw = text_width(g_btn[i].label) + S(34);
    g_btn[i].rc.left = x - bw;
    g_btn[i].rc.right = x;
    g_btn[i].rc.top = y;
    g_btn[i].rc.bottom = y + S(BTN_H);
    x -= bw + S(10);
  }
}

static int hit_button(int x, int y) {
  for (int i = 0; i < g_btnCount; i += 1) {
    if (x >= g_btn[i].rc.left && x < g_btn[i].rc.right && y >= g_btn[i].rc.top && y < g_btn[i].rc.bottom)
      return g_btn[i].id;
  }
  return -1;
}

static Btn *button_by_id(int id) {
  for (int i = 0; i < g_btnCount; i += 1) if (g_btn[i].id == id) return &g_btn[i];
  return NULL;
}

static int default_button_id(void) {
  for (int i = 0; i < g_btnCount; i += 1) if (g_btn[i].enabled) return g_btn[i].id;
  return -1;
}

/* ── установка (в отдельном потоке, чтобы окно не подвисало) ── */

static int ask_move_old_data(void) {
  PostMessageA(g_wnd, WM_APP_ASK, 0, 0);
  WaitForSingleObject(g_evtAnswer, INFINITE);
  ResetEvent(g_evtAnswer);
  return g_answer;
}

static DWORD WINAPI install_thread(LPVOID unused) {
  (void)unused;
  char install[MAX_PATH], exe[MAX_PATH];
  snprintf(install, sizeof(install), "%s", g_install);
  snprintf(exe, sizeof(exe), "%s", g_exe);

  ui_log("");
  ui_log(" === установка ==================================================");
  remember_save(install);          /* следующий запуск откроет эту же папку */
  ui_log("  Куда: %s", install);
  ui_progress(1);

  long offset = 0, length = 0;
  int rc = payload_offset(g_self, &offset, &length);
  if (rc != 0) {
    ui_log("");
    ui_log("  ! Внутри exe не найден архив панели (код %d).", rc);
    ui_log("    Похоже, файл скачался не целиком — скачай установщик заново.");
    ui_progress(-1);
    PostMessageA(g_wnd, WM_APP_STATE, ST_ERROR, 0);
    return 0;
  }
  ui_log("  Архив внутри: %.1f МБ", (double)length / 1048576.0);

  char tempdir[MAX_PATH], tempzip[MAX_PATH];
  if (!GetTempPathA(MAX_PATH, tempdir)) snprintf(tempdir, sizeof(tempdir), "%s", g_base);
  snprintf(tempzip, sizeof(tempzip), "%somnipanel-install-%lu.zip",
           tempdir, (unsigned long)GetCurrentProcessId());

  ui_log("  Готовлю файлы…");
  long written = 0;
  rc = payload_write(g_self, tempzip, &written);
  if (rc != 0) {
    ui_log("");
    ui_log("  ! Не смог записать временный файл: %s (код %d)", tempzip, rc);
    ui_progress(-1);
    PostMessageA(g_wnd, WM_APP_STATE, ST_ERROR, 0);
    return 0;
  }
  ui_log("    записано %.1f МБ", (double)written / 1048576.0);
  ui_progress(12);

  make_dir(g_base);
  if (dir_exists(install)) ui_log("  Прежняя версия на месте — файлы панели обновятся, данные останутся.");
  make_dir(install);

  ui_log("  Распаковываю панель в %s", install);
  int unpacked = (extract_zip(tempzip, install) == 0);
  if (!unpacked) ui_log("  Первый способ не сработал — пробую второй…");

  /* поднимаем файлы, если архив собран с верхней папкой OmniPanel */
  for (int attempt = 0; attempt < 2 && !file_exists(exe); attempt += 1) {
    if (attempt == 1) {
      ui_log("  Распаковываю вторым способом…");
      char cmd[4096];
      snprintf(cmd, sizeof(cmd),
               "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
               "\"Expand-Archive -LiteralPath '%s' -DestinationPath '%s' -Force\"", tempzip, install);
      run_wait(cmd, 1);
    }
    char nested[MAX_PATH], nestedExe[MAX_PATH];
    path_join(nested, sizeof(nested), install, APP_FOLDER);
    path_join(nestedExe, sizeof(nestedExe), nested, APP_EXE);
    if (file_exists(nestedExe)) {
      ui_log("  Достаю файлы из вложенной папки…");
      char cmd[4096];
      snprintf(cmd, sizeof(cmd),
               "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
               "\"Get-ChildItem -LiteralPath '%s' -Force | Move-Item -Destination '%s' -Force;"
               "Remove-Item -LiteralPath '%s' -Recurse -Force\"",
               nested, install, nested);
      run_wait(cmd, 1);
    }
  }
  DeleteFileA(tempzip);

  if (file_exists(exe)) {
    ui_log("    готово");
  } else {
    ui_log("");
    ui_log("  ! Панель распаковалась, но OmniPanel.exe не найден.");
    ui_log("    Папка: %s", install);
    ui_log("    Проверь, что места на диске хватает и папка не защищена.");
    ui_progress(-1);
    PostMessageA(g_wnd, WM_APP_STATE, ST_ERROR, 0);
    return 0;
  }
  ui_progress(64);

  ui_log("  Включаю автообновление из GitHub…");
  seed_settings(install);
  ui_progress(70);

  /* прежние данные пользователя (если панель раньше работала из другой папки) */
  {
    char oldData[MAX_PATH];
    if (find_old_data(g_self, oldData, sizeof(oldData)) == 0) {
      char newData[MAX_PATH], probe[MAX_PATH];
      path_join(newData, sizeof(newData), install, "OmniPanelData");
      snprintf(probe, sizeof(probe), "%s\\servers.json", newData);
      if (!file_exists(probe)) {
        ui_log("");
        ui_log("  Нашёл прежние настройки и серверы:");
        ui_log("    %s", oldData);
        ui_progress(-1);
        if (ask_move_old_data()) {
          ui_log("  Переношу данные…");
          ui_progress(78);
          if (copy_tree(oldData, newData) == 0) ui_log("    готово");
          else ui_log("    не вышло (можно скопировать папку вручную)");
        } else {
          ui_log("  Хорошо, начну с чистых настроек. Старые данные остались на месте.");
        }
        ui_progress(84);
      }
    }
  }

  ui_log("  Создаю ярлыки на рабочем столе и в меню «Пуск»…");
  {
    char desk[MAX_PATH], lnk[MAX_PATH], prog[MAX_PATH], plnk[MAX_PATH];
    desktop_dir(desk, sizeof(desk));
    if (desk[0]) {
      path_join(lnk, sizeof(lnk), desk, "OmniPanel.lnk");
      make_shortcut(lnk, exe, install);
    }
    programs_dir(prog, sizeof(prog));
    if (prog[0]) {
      char folder[MAX_PATH];
      path_join(folder, sizeof(folder), prog, "OmniPanel");
      make_dir(folder);
      path_join(plnk, sizeof(plnk), folder, "OmniPanel.lnk");
      make_shortcut(plnk, exe, install);
    }
  }
  ui_progress(100);

  ui_log("    готово");
  ui_log("");
  ui_log(" === готово ====================================================");
  ui_log("  OmniPanel %s установлен.", g_version);
  ui_log("  Папка: %s", install);
  ui_log("  Ярлык на рабочем столе и в меню «Пуск».");
  ui_log("  Этот файл-установщик можно удалить — панель уже на месте.");
  ui_log("  Дальше панель обновляется сама, как Discord.");
  ui_progress(-1);
  PostMessageA(g_wnd, WM_APP_STATE, ST_DONE, 0);
  return 0;
}

/* ── состояние и кнопки под него ── */

static void apply_state(int state) {
  g_state = state;
  Btn list[MAX_BTN];
  int n = 0;
  memset(list, 0, sizeof(list));

  if (state == ST_WELCOME) {
    list[n].id = B_INSTALL; snprintf(list[n].label, sizeof(list[n].label), "Установить");        list[n].enabled = 1; n += 1;
    list[n].id = B_PATH;    snprintf(list[n].label, sizeof(list[n].label), "Изменить путь…");   list[n].enabled = 1; n += 1;
    list[n].id = B_CANCEL;  snprintf(list[n].label, sizeof(list[n].label), "Отмена");            list[n].enabled = 1; n += 1;
  } else if (state == ST_ALREADY) {
    list[n].id = B_RUN;       snprintf(list[n].label, sizeof(list[n].label), "Запустить панель"); list[n].enabled = 1; n += 1;
    list[n].id = B_PATH;      snprintf(list[n].label, sizeof(list[n].label), "Изменить путь…");  list[n].enabled = 1; n += 1;
    list[n].id = B_REINSTALL; snprintf(list[n].label, sizeof(list[n].label), "Переустановить");   list[n].enabled = 1; n += 1;
    list[n].id = B_CLOSE;     snprintf(list[n].label, sizeof(list[n].label), "Закрыть");          list[n].enabled = 1; n += 1;
  } else if (state == ST_INSTALLING) {
    n = 0;                       /* во время установки кнопок нет */
  } else if (state == ST_QUESTION) {
    list[n].id = B_MOVE;  snprintf(list[n].label, sizeof(list[n].label), "Перенести данные");        list[n].enabled = 1; n += 1;
    list[n].id = B_FRESH; snprintf(list[n].label, sizeof(list[n].label), "Начать с чистых настроек"); list[n].enabled = 1; n += 1;
  } else if (state == ST_DONE) {
    list[n].id = B_RUN;   snprintf(list[n].label, sizeof(list[n].label), "Запустить панель"); list[n].enabled = 1; n += 1;
    list[n].id = B_OPEN;  snprintf(list[n].label, sizeof(list[n].label), "Открыть папку");    list[n].enabled = 1; n += 1;
    list[n].id = B_CLOSE; snprintf(list[n].label, sizeof(list[n].label), "Закрыть");          list[n].enabled = 1; n += 1;
  } else { /* ST_ERROR */
    list[n].id = B_OPEN;  snprintf(list[n].label, sizeof(list[n].label), "Открыть папку"); list[n].enabled = 1; n += 1;
    list[n].id = B_CLOSE; snprintf(list[n].label, sizeof(list[n].label), "Закрыть");       list[n].enabled = 1; n += 1;
  }

  set_buttons(list, n);
  layout_buttons();
  InvalidateRect(g_wnd, NULL, TRUE);
}

static void welcome_lines(int already);

static void reset_log(void) {
  EnterCriticalSection(&g_lock);
  g_lineCount = 0;
  LeaveCriticalSection(&g_lock);
}

/* Перерисовать стартовый экран под текущий путь (он же после смены папки). */
static void show_start_screen(void) {
  reset_log();
  int already = !g_force && file_exists(g_exe);
  welcome_lines(already);
  apply_state(already ? ST_ALREADY : ST_WELCOME);
  InvalidateRect(g_wnd, NULL, TRUE);
}

/* Запомнить выбранный путь и обновить окно под него. */
static void set_install_dir(const char *dir) {
  snprintf(g_install, sizeof(g_install), "%s", dir);
  path_join(g_exe, sizeof(g_exe), g_install, APP_EXE);
  g_started = 0;
}

static void start_install(void) {
  if (g_started) return;
  g_started = 1;
  apply_state(ST_INSTALLING);
  HANDLE th = CreateThread(NULL, 0, install_thread, NULL, 0, NULL);
  if (th) CloseHandle(th);
}

static void open_install_folder(void) {
  ShellExecuteA(NULL, "open", g_install, NULL, NULL, SW_SHOWNORMAL);
}

static void launch_panel(void) {
  char cmd[MAX_PATH + 16];
  snprintf(cmd, sizeof(cmd), "\"%s\"", g_exe);
  run_detached(cmd);
  Sleep(300);
  DestroyWindow(g_wnd);
}

static void on_button(int id) {
  switch (id) {
    case B_INSTALL:
    case B_REINSTALL:
      start_install();
      break;
    case B_CANCEL:
    case B_CLOSE:
      DestroyWindow(g_wnd);
      break;
    case B_RUN:
      launch_panel();
      break;
    case B_OPEN:
      open_install_folder();
      break;
    case B_PATH: {
      char picked[MAX_PATH];
      if (pick_folder(picked, sizeof(picked)) == 0) {
        set_install_dir(picked);
        g_force = 0;
        show_start_screen();
      }
      break;
    }
    case B_MOVE:
      g_answer = 1;
      apply_state(ST_INSTALLING);
      SetEvent(g_evtAnswer);
      break;
    case B_FRESH:
      g_answer = 0;
      apply_state(ST_INSTALLING);
      SetEvent(g_evtAnswer);
      break;
    default:
      break;
  }
}

/* ── рисование ── */

static HFONT make_font(int px, int bold) {
  return CreateFontA(-px, 0, 0, 0, bold ? FW_BOLD : FW_NORMAL, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                     FIXED_PITCH | FF_MODERN, "Consolas");
}

static void draw_text_line(HDC dc, const char *utf8, int x, int y, int wide, int limitRight, COLORREF color) {
  wchar_t w[LINE_CHARS];
  to_wide(utf8, w, LINE_CHARS);
  RECT rc;
  SetRect(&rc, x, y, limitRight, y + S(LINE_H) + S(2));
  SetTextColor(dc, color);
  DrawTextW(dc, w, -1, &rc, DT_SINGLELINE | DT_NOPREFIX | DT_LEFT | DT_VCENTER | DT_END_ELLIPSIS);
  (void)wide;
}

static void draw_button(HDC dc, Btn *b) {
  int hot = (b->id == g_hoverId && b->enabled);
  int down = (b->id == g_pressedId && b->enabled);
  COLORREF line = !b->enabled ? BTN_LINE_OFF : (hot || down ? BTN_LINE_HOT : BTN_LINE);
  COLORREF fill = down ? RGB(30, 30, 30) : (hot ? BTN_FILL_HOT : BG_COLOR);
  COLORREF text = !b->enabled ? BTN_TEXT_OFF : (hot && !down ? BG_COLOR : TEXT_COLOR);

  HBRUSH br = CreateSolidBrush(fill);
  FillRect(dc, &b->rc, br);
  DeleteObject(br);

  RECT edge = b->rc;
  HBRUSH lb = CreateSolidBrush(line);
  FrameRect(dc, &edge, lb);
  if (g_focus >= 0 && g_focus < g_btnCount && b->id == g_btn[g_focus].id && b->enabled) {
    RECT inner = b->rc;
    InflateRect(&inner, -S(2), -S(2));
    FrameRect(dc, &inner, lb);
  }
  DeleteObject(lb);

  wchar_t w[64];
  to_wide(b->label, w, 64);
  SetTextColor(dc, text);
  RECT tr = b->rc;
  DrawTextW(dc, w, -1, &tr, DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOPREFIX);
}

static void paint(HDC dc) {
  RECT rc;
  GetClientRect(g_wnd, &rc);

  HBRUSH bg = CreateSolidBrush(BG_COLOR);
  FillRect(dc, &rc, bg);
  DeleteObject(bg);

  HGDIOBJ oldFont = SelectObject(dc, g_font);
  SetBkMode(dc, TRANSPARENT);

  int contentRight = rc.right - MARGIN;
  int bottomLimit = rc.bottom - S(BAR_H);
  int progressTop = (g_progress >= 0) ? bottomLimit - S(PROGRESS_H) - S(12) : bottomLimit;
  int linesTop = S(14);
  int linesBottom = progressTop - S(6);
  int capacity = (linesBottom - linesTop) / S(LINE_H);
  if (capacity < 1) capacity = 1;

  EnterCriticalSection(&g_lock);
  int total = g_lineCount;
  int first = total > capacity ? total - capacity : 0;
  int y = linesTop;
  for (int i = first; i < total; i += 1) {
    const char *s = g_lines[i];
    COLORREF color = TEXT_COLOR;
    const char *p = s;
    while (*p == ' ') p += 1;
    if (*p == '=' || *p == '-') color = DIM_COLOR;
    if (s[0] == ' ' && s[1] == ' ' && s[2] == '!' ) color = RGB(255, 255, 255);
    draw_text_line(dc, s, MARGIN, y, rc.right, contentRight, color);
    y += S(LINE_H);
  }
  LeaveCriticalSection(&g_lock);

  /* полоса прогресса */
  if (g_progress >= 0) {
    RECT bar;
    SetRect(&bar, MARGIN, progressTop, contentRight, progressTop + S(PROGRESS_H));
    HBRUSH ob = CreateSolidBrush(LINE_COLOR);
    FrameRect(dc, &bar, ob);
    DeleteObject(ob);
    RECT fill = bar;
    InflateRect(&fill, -S(1), -S(1));
    fill.right = fill.left + (fill.right - fill.left) * (g_progress > 100 ? 100 : g_progress) / 100;
    HBRUSH fb = CreateSolidBrush(RGB(235, 235, 235));
    FillRect(dc, &fill, fb);
    DeleteObject(fb);
  }

  /* разделитель и кнопки */
  RECT sep;
  SetRect(&sep, MARGIN, bottomLimit, contentRight, bottomLimit + 1);
  HBRUSH sb = CreateSolidBrush(LINE_COLOR);
  FillRect(dc, &sep, sb);
  DeleteObject(sb);

  layout_buttons();
  for (int i = 0; i < g_btnCount; i += 1) draw_button(dc, &g_btn[i]);

  SelectObject(dc, oldFont);
}

/* ── окно ── */

static LRESULT CALLBACK wnd_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_ERASEBKGND:
      return 1;

    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(h, &ps);
      paint(dc);
      EndPaint(h, &ps);
      return 0;
    }

    case WM_APP_LOG:
      InvalidateRect(h, NULL, FALSE);
      return 0;

    case WM_APP_STATE:
      apply_state((int)wp);
      return 0;

    case WM_APP_ASK:
      apply_state(ST_QUESTION);
      return 0;

    case WM_MOUSEMOVE: {
      int id = hit_button(GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
      if (id != g_hoverId) {
        g_hoverId = id;
        InvalidateRect(h, NULL, FALSE);
      }
      TRACKMOUSEEVENT tme;
      tme.cbSize = sizeof(tme);
      tme.dwFlags = TME_LEAVE;
      tme.hwndTrack = h;
      TrackMouseEvent(&tme);
      return 0;
    }

    case WM_MOUSELEAVE:
      if (g_hoverId != -1) { g_hoverId = -1; InvalidateRect(h, NULL, FALSE); }
      return 0;

    case WM_SETCURSOR:
      if (LOWORD(lp) == HTCLIENT) {
        POINT p;
        GetCursorPos(&p);
        ScreenToClient(h, &p);
        SetCursor(LoadCursor(NULL, hit_button(p.x, p.y) > 0 ? IDC_HAND : IDC_ARROW));
        return TRUE;
      }
      break;

    case WM_LBUTTONDOWN: {
      int id = hit_button(GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
      if (id > 0) {
        g_pressedId = id;
        for (int i = 0; i < g_btnCount; i += 1) if (g_btn[i].id == id) g_focus = i;
        InvalidateRect(h, NULL, FALSE);
      }
      return 0;
    }

    case WM_LBUTTONUP: {
      int id = hit_button(GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
      int pressed = g_pressedId;
      g_pressedId = -1;
      InvalidateRect(h, NULL, FALSE);
      if (id > 0 && id == pressed) {
        Btn *b = button_by_id(id);
        if (b && b->enabled) on_button(id);
      }
      return 0;
    }

    case WM_KEYDOWN:
      if (wp == VK_RETURN || wp == VK_SPACE) {
        int id = default_button_id();
        if (id > 0) { on_button(id); return 0; }
      } else if (wp == VK_ESCAPE) {
        if (g_state == ST_INSTALLING) return 0;
        if (g_state == ST_QUESTION) return 0;          /* ответ обязателен */
        if (g_state == ST_WELCOME) { DestroyWindow(h); return 0; }
        DestroyWindow(h);
        return 0;
      } else if (wp == VK_TAB) {
        if (g_btnCount > 0) {
          g_focus = (g_focus + 1) % g_btnCount;
          InvalidateRect(h, NULL, FALSE);
        }
        return 0;
      }
      return 0;

    case WM_CLOSE:
      if (g_state == ST_INSTALLING || g_state == ST_QUESTION) {
        ui_log("  Установка идёт — окно закроется сразу после неё.");
        return 0;
      }
      DestroyWindow(h);
      return 0;

    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;

    default:
      break;
  }
  return DefWindowProcA(h, msg, wp, lp);
}

static void dark_title_bar(HWND h) {
  HMODULE dw = LoadLibraryA("dwmapi.dll");
  if (!dw) return;
  typedef HRESULT(WINAPI * SetAttr)(HWND, DWORD, LPCVOID, DWORD);
  SetAttr f = (SetAttr)(void *)GetProcAddress(dw, "DwmSetWindowAttribute");
  if (f) {
    BOOL on = TRUE;
    f(h, 20, &on, sizeof(on));
    f(h, 19, &on, sizeof(on));
  }
  FreeLibrary(dw);
}

static void welcome_lines(int already) {
  ui_log("  =================================================================");
  ui_log("                         O m n i P a n e l");
  ui_log("             панель управления серверами · установка");
  ui_log("  =================================================================");
  ui_log("");
  ui_log("  Версия:            %s", g_version);
  ui_log("  Куда установится:  %s", g_install);
  ui_log("  Внутри:            панель целиком, ничего скачивать не нужно");
  if (needs_admin(g_install)) {
    ui_log("");
    ui_log("  ! В этой папке нужны права администратора.");
    ui_log("    Лучше выбрать другую — кнопка «Изменить путь…».");
  }
  ui_log("");
  if (!already) {
    ui_log("  Папку можно поменять: «Изменить путь…» внизу окна.");
    ui_log("");
  }
  if (already) {
    ui_log("  В этой папке панель уже стоит.");
    ui_log("  «Запустить панель» — открыть установленную версию.");
    ui_log("  «Переустановить» — разложить файлы заново: настройки,");
    ui_log("  список серверов и миры (OmniPanelData) останутся на месте.");
  } else {
    ui_log("  Что будет сделано:");
    ui_log("    1. распакуется панель в папку пользователя (права админа не нужны)");
    ui_log("    2. на рабочем столе и в меню «Пуск» появятся ярлыки");
    ui_log("    3. включится автообновление из GitHub (как в Discord, само)");
    ui_log("");
    ui_log("  Если панель уже была установлена, файлы обновятся, а настройки,");
    ui_log("  список серверов и миры серверов останутся на месте.");
  }
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR args, int show) {
  (void)prev; (void)show;
  InitializeCriticalSection(&g_lock);
  g_evtAnswer = CreateEventA(NULL, FALSE, FALSE, NULL);

  /* масштаб под DPI, чтобы текст не был мылом */
  HDC screen = GetDC(NULL);
  int dpi = screen ? GetDeviceCaps(screen, LOGPIXELSY) : 96;
  if (screen) ReleaseDC(NULL, screen);
  if (dpi <= 0) dpi = 96;
  g_scale = dpi >= 144 ? 2 : (dpi >= 120 ? 1 : 1);
  if (dpi >= 192) g_scale = 3;

  GetModuleFileNameA(NULL, g_self, MAX_PATH);
  if (local_appdata(g_base, sizeof(g_base)) != 0) {
    MessageBoxA(NULL, "Не удалось определить папку пользователя.", "OmniPanel", MB_ICONERROR | MB_OK);
    return 1;
  }
  path_join(g_install, sizeof(g_install), g_base, APP_FOLDER);
  path_join(g_exe, sizeof(g_exe), g_install, APP_EXE);

  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

  /* путь: по умолчанию %LOCALAPPDATA%\OmniPanel, иначе запомненный или --dir */
  {
    char remembered[MAX_PATH];
    if (remember_load(remembered, sizeof(remembered)) == 0) set_install_dir(remembered);
  }

  /* разбор ключей: --reinstall / --переустановить, --dir "<папка>" */
  for (char *p = args; p && *p; ) {
    while (*p == ' ') p += 1;
    if (!*p) break;
    if (strncmp(p, "--reinstall", 11) == 0) { g_force = 1; p += 11; continue; }
    if (strncmp(p, "--dir", 5) == 0) {
      p += 5;
      while (*p == ' ') p += 1;
      char dir[MAX_PATH];
      size_t k = 0;
      if (*p == '"') {
        p += 1;
        while (*p && *p != '"' && k < sizeof(dir) - 1) dir[k++] = *p++;
        if (*p == '"') p += 1;
      } else {
        while (*p && *p != ' ' && k < sizeof(dir) - 1) dir[k++] = *p++;
      }
      dir[k] = 0;
      if (k) set_install_dir(dir);
      continue;
    }
    while (*p && *p != ' ') p += 1;
  }

  g_font = make_font(S(16), 0);

  const char *cls = "OmniPanelSetupWnd";
  WNDCLASSEXA wc;
  memset(&wc, 0, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = wnd_proc;
  wc.hInstance = inst;
  wc.hIcon = LoadIconA(inst, MAKEINTRESOURCEA(1));
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(BG_COLOR);
  wc.lpszClassName = cls;
  RegisterClassExA(&wc);

  int w = S(760), hgt = S(540);
  int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
  int x = (sw - w) / 2, y = (sh - hgt) / 2;

  wchar_t title[128];
  char titleUtf8[128];
  snprintf(titleUtf8, sizeof(titleUtf8), "OmniPanel %s — установщик", g_version);
  to_wide(titleUtf8, title, 128);

  g_wnd = CreateWindowExA(0, cls, "", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                          x, y, w, hgt, NULL, NULL, inst, NULL);
  if (!g_wnd) return 1;
  SetWindowTextW(g_wnd, title);
  dark_title_bar(g_wnd);

  show_start_screen();

  ShowWindow(g_wnd, SW_SHOW);
  UpdateWindow(g_wnd);

  MSG msg;
  while (GetMessageA(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageA(&msg);
  }

  DeleteObject(g_font);
  DeleteCriticalSection(&g_lock);
  CoUninitialize();
  return 0;
}

/* ─────────────────────────── проверка на Linux ─────────────────────────── */

#else /* POSIX_TEST */

#include <unistd.h>

int main(int argc, char **argv) {
  if (argc >= 4 && strcmp(argv[1], "--selftest") == 0) {
    long offset = 0, length = 0;
    int rc = payload_offset(argv[2], &offset, &length);
    if (rc != 0) { printf("трейлер не найден (код %d)\n", rc); return 1; }
    printf("смещение=%ld длина=%ld\n", offset, length);
    long written = 0;
    rc = payload_write(argv[2], argv[3], &written);
    if (rc != 0) { printf("не записалось (код %d)\n", rc); return 2; }
    printf("записано %ld байт в %s\n", written, argv[3]);
    return 0;
  }
  printf("служебная сборка для проверки: --selftest <exe> <куда>\n");
  return 0;
}

#endif
