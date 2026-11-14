/*
 * OmniPanel — установщик и запускалка в одном exe.
 *
 * Первый запуск:  распаковывает панель в %LOCALAPPDATA%\OmniPanel, делает ярлыки,
 *                 включает автообновление и запускает панель.
 * Дальше:         тот же exe просто запускает установленную панель.
 *
 * Внутри exe лежит zip с панелью: он дописан в конец файла и помечен
 * трейлером "OMNIUPD1" + размер (8 байт, little-endian).
 *
 * Сборка для Windows:  x86_64-w64-mingw32-gcc -O2 -o OmniPanel-Установка.exe installer.c -mwindows:no
 * Проверка на Linux:   gcc -DPOSIX_TEST -o selftest installer.c && ./selftest --selftest <exe> <куда>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define TRAILER_MAGIC "OMNIUPD1"
#define TRAILER_LEN 16          /* 8 байт магии + 8 байт длины */
#define APP_FOLDER "OmniPanel"
#define APP_EXE "OmniPanel.exe"
#define UPDATE_REPO "Shokydo/OmniPanel"
#define UPDATE_BRANCH "main"
#define APP_VERSION "1.19.1"

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
#include <shlobj.h>
#include <conio.h>

static void set_console_look(void) {
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  SetConsoleOutputCP(65001);           /* UTF-8, чтобы кириллица была кириллицей */
  SetConsoleCP(65001);
  if (h == INVALID_HANDLE_VALUE) return;
  /* чёрный фон, светло-серый текст — ч/б как в консоли */
  SetConsoleTextAttribute(h, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE);
  CONSOLE_CURSOR_INFO ci;
  if (GetConsoleCursorInfo(h, &ci)) { ci.bVisible = FALSE; SetConsoleCursorInfo(h, &ci); }
}

static void color(int bright) {
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  if (h == INVALID_HANDLE_VALUE) return;
  WORD a = FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE;
  if (bright) a |= FOREGROUND_INTENSITY;
  SetConsoleTextAttribute(h, a);
}

static void restore_cursor(void) {
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  CONSOLE_CURSOR_INFO ci;
  if (GetConsoleCursorInfo(h, &ci)) { ci.bVisible = TRUE; SetConsoleCursorInfo(h, &ci); }
}

static int path_join(char *out, size_t n, const char *a, const char *b) {
  return snprintf(out, n, "%s\\%s", a, b) > 0;
}

/* %LOCALAPPDATA% */
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
  return CreateDirectoryA(path, NULL) ? 0 : 1;
}

/* Запуск процесса и ожидание завершения; 0 — код возврата 0. */
static int run_wait(const char *cmdline, int hidden) {
  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si));
  memset(&pi, 0, sizeof(pi));
  si.cb = sizeof(si);
  if (hidden) { si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE; }
  char *buf = (char *)malloc(strlen(cmdline) + 1);
  if (!buf) return 1;
  strcpy(buf, cmdline);
  BOOL ok = CreateProcessA(NULL, buf, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi);
  free(buf);
  if (!ok) return 1;
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
  char *buf = (char *)malloc(strlen(cmdline) + 1);
  if (!buf) return;
  strcpy(buf, cmdline);
  if (CreateProcessA(NULL, buf, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }
  free(buf);
}

/* Распаковка zip: сначала встроенный tar (Windows 10+), потом PowerShell. */
static int extract_zip(const char *zip, const char *dest) {
  char cmd[4096];
  snprintf(cmd, sizeof(cmd), "tar.exe -x -f \"%s\" -C \"%s\"", zip, dest);
  if (run_wait(cmd, 1) == 0) return 0;
  snprintf(cmd, sizeof(cmd),
           "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden "
           "-Command \"Expand-Archive -LiteralPath '%s' -DestinationPath '%s' -Force\"",
           zip, dest);
  return run_wait(cmd, 1) == 0 ? 0 : 1;
}

/* Ярлык через PowerShell (WScript.Shell). */
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
  if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, buf))) snprintf(out, n, "%s", buf);
  else out[0] = 0;
}

static void programs_dir(char *out, size_t n) {
  char buf[MAX_PATH];
  if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_PROGRAMS, NULL, 0, buf))) snprintf(out, n, "%s", buf);
  else out[0] = 0;
}

/* Поиск прежних данных панели рядом с установщиком: OmniPanelData с servers.json */
static int find_old_data(const char *self, char *out, size_t n) {
  char dir[MAX_PATH];
  snprintf(dir, sizeof(dir), "%s", self);
  char *slash = strrchr(dir, '\\');
  if (slash) *slash = 0;
  else snprintf(dir, sizeof(dir), ".");

  const char *variants[] = {
    "OmniPanelData",
    "OmniPanel\\OmniPanelData",
    "LocalPanelData",
    "OmniPanel\\LocalPanelData",
  };
  for (unsigned i = 0; i < sizeof(variants) / sizeof(variants[0]); i += 1) {
    char candidate[MAX_PATH], probe[MAX_PATH];
    snprintf(candidate, sizeof(candidate), "%s\\%s", dir, variants[i]);
    snprintf(probe, sizeof(probe), "%s\\servers.json", candidate);
    if (dir_exists(candidate) && file_exists(probe)) {
      snprintf(out, n, "%s", candidate);
      return 0;
    }
  }
  return 1;
}

/* Перенос прежней папки данных: xcopy, при неудаче — PowerShell. */
static int copy_tree(const char *from, const char *to) {
  char cmd[4096];
  snprintf(cmd, sizeof(cmd), "xcopy \"%s\" \"%s\" /E /I /H /Y /Q", from, to);
  if (run_wait(cmd, 1) == 0) return 0;
  snprintf(cmd, sizeof(cmd),
           "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
           "\"Copy-Item -LiteralPath '%s' -Destination '%s' -Recurse -Force\"", from, to);
  return run_wait(cmd, 1) == 0 ? 0 : 1;
}

static void line(const char *s) { printf("%s\n", s); }

static void rule(void) {
  line("  ------------------------------------------------------------------");
}

/* Настройки автообновления: дописываем в panel.json, не теряя прежние поля. */
static void seed_settings(const char *install_dir) {
  char data[MAX_PATH], panel[MAX_PATH], cmd[4096];
  path_join(data, sizeof(data), install_dir, "OmniPanelData");
  make_dir(data);
  path_join(panel, sizeof(panel), data, "panel.json");
  if (!file_exists(panel)) {
    FILE *f = fopen(panel, "wb");
    if (f) {
      fprintf(f,
              "{\n"
              "  \"updateRepo\": \"%s\",\n"
              "  \"updateBranch\": \"%s\",\n"
              "  \"updateAuto\": true,\n"
              "  \"updateAutoInstall\": true\n"
              "}\n", UPDATE_REPO, UPDATE_BRANCH);
      fclose(f);
    }
    return;
  }
  /* файл уже есть — аккуратно правим через PowerShell (JSON без ломки кавычек) */
  snprintf(cmd, sizeof(cmd),
           "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
           "\"$p='%s';$j=Get-Content -LiteralPath $p -Raw | ConvertFrom-Json;"
           "$j | Add-Member -NotePropertyName updateRepo -NotePropertyValue '%s' -Force;"
           "$j | Add-Member -NotePropertyName updateBranch -NotePropertyValue '%s' -Force;"
           "$j | Add-Member -NotePropertyName updateAuto -NotePropertyValue $true -Force;"
           "$j | Add-Member -NotePropertyName updateAutoInstall -NotePropertyValue $true -Force;"
           "$j | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $p -Encoding UTF8\"",
           panel, UPDATE_REPO, UPDATE_BRANCH);
  run_wait(cmd, 1);
}

int main(int argc, char **argv) {
  set_console_look();
  setvbuf(stdout, NULL, _IONBF, 0);

  char self[MAX_PATH];
  GetModuleFileNameA(NULL, self, MAX_PATH);

  char base[MAX_PATH], install[MAX_PATH], exe[MAX_PATH];
  if (local_appdata(base, sizeof(base)) != 0) {
    color(1); line("  Не удалось определить папку пользователя."); color(0);
    Sleep(4000);
    return 1;
  }
  path_join(install, sizeof(install), base, APP_FOLDER);
  path_join(exe, sizeof(exe), install, APP_EXE);

  int force = 0;
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--reinstall") == 0 || strcmp(argv[i], "--переустановить") == 0) force = 1;
  }

  /* ── панель уже установлена: просто запускаем ── */
  if (!force && file_exists(exe)) {
    printf("\n");
    color(1);   printf("  OmniPanel"); color(0);
    printf(" уже установлен — запускаю.\n");
    printf("  Папка: %s\n", install);
    printf("  Обновления проверяются автоматически при запуске.\n\n");
    char cmd[MAX_PATH + 16];
    snprintf(cmd, sizeof(cmd), "\"%s\"", exe);
    run_detached(cmd);
    Sleep(1200);
    restore_cursor();
    return 0;
  }

  /* ── установка ── */
  printf("\n");
  color(1);
  line("  ==================================================================");
  line("                          O m n i P a n e l");
  line("              панель управления серверами · установка");
  line("  ==================================================================");
  color(0);
  printf("\n");
  printf("  Версия:            %s\n", APP_VERSION);
  printf("  Куда установится:  %s\n", install);
  printf("  Внутри:            панель целиком, ничего скачивать не нужно\n");
  printf("\n");
  printf("  Что будет сделано:\n");
  printf("    1. распакуется панель в папку пользователя (права админа не нужны)\n");
  printf("    2. на рабочем столе и в меню «Пуск» появятся ярлыки\n");
  printf("    3. включится автообновление из GitHub — само, без вопросов\n");
  if (dir_exists(install)) {
    color(1);
    printf("\n  В папке уже есть панель: файлы обновятся, а настройки,\n");
    printf("  список серверов и миры серверов (OmniPanelData) останутся.\n");
    color(0);
  }
  printf("    4. панель запустится\n");
  printf("\n");
  rule();
  printf("  Enter — установить,   Esc — отмена. ");
  {
    int c = 0;
    do { c = _getch(); } while (c != 13 && c != 27 && c != 10);
    if (c == 27) { printf("\n\n  Отменено.\n\n"); restore_cursor(); return 0; }
  }
  printf("\n\n");

  long offset = 0, length = 0;
  int rc = payload_offset(self, &offset, &length);
  if (rc != 0) {
    color(1);
    printf("  Внутри exe не найден архив панели (код %d).\n", rc);
    color(0);
    printf("  Похоже, файл скачался не целиком. Скачай exe заново.\n\n");
    restore_cursor();
    system("pause");
    return 2;
  }
  printf("  Архив внутри: %.1f МБ\n", (double)length / 1048576.0);

  /* временный файл для архива */
  char tempdir[MAX_PATH], tempzip[MAX_PATH];
  if (!GetTempPathA(MAX_PATH, tempdir)) { snprintf(tempdir, sizeof(tempdir), "%s", base); }
  snprintf(tempzip, sizeof(tempzip), "%somnipanel-install-%lu.zip", tempdir, (unsigned long)GetCurrentProcessId());

  printf("  Готовлю файлы… ");
  long written = 0;
  rc = payload_write(self, tempzip, &written);
  if (rc != 0) {
    color(1); printf("ошибка\n"); color(0);
    printf("  Не смог записать временный файл: %s (код %d)\n", tempzip, rc);
    restore_cursor();
    system("pause");
    return 3;
  }
  printf("готово (%.1f МБ)\n", (double)written / 1048576.0);

  make_dir(base);
  if (force && dir_exists(install)) {
    printf("  Прежняя версия на месте — обновляю файлы панели.\n");
  }
  make_dir(install);
  printf("  Распаковываю панель (это займёт несколько секунд) … ");
  if (extract_zip(tempzip, install) != 0) {
    color(1); printf("не вышло\n"); color(0);
    printf("  Не удалось распаковать архив.\n");
    printf("  Открой вручную: %s  →  распакуй в  %s\n", tempzip, install);
    restore_cursor();
    system("pause");
    return 4;
  }
  printf("готово\n");
  DeleteFileA(tempzip);

  /* архив мог быть собран с верхней папкой OmniPanel — поднимаем файлы на уровень выше */
  if (!file_exists(exe)) {
    char nested[MAX_PATH];
    path_join(nested, sizeof(nested), install, APP_FOLDER);
    char nestedExe[MAX_PATH];
    path_join(nestedExe, sizeof(nestedExe), nested, APP_EXE);
    if (file_exists(nestedExe)) {
      printf("  Достаю файлы из вложенной папки … ");
      char cmd[4096];
      snprintf(cmd, sizeof(cmd),
               "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
               "\"Get-ChildItem -LiteralPath '%s' -Force | Move-Item -Destination '%s' -Force;"
               "Remove-Item -LiteralPath '%s' -Recurse -Force\"",
               nested, install, nested);
      run_wait(cmd, 1);
      printf("готово\n");
    }
  }

  if (!file_exists(exe)) {
    color(1);
    printf("\n  Панель распаковалась, но %s не найден в %s\n", APP_EXE, install);
    color(0);
    restore_cursor();
    system("pause");
    return 5;
  }

  printf("  Настраиваю автообновление … ");
  seed_settings(install);
  printf("готово\n");

  /* прежние данные пользователя (если панель раньше работала из другой папки) */
  {
    char oldData[MAX_PATH], newData[MAX_PATH];
    if (find_old_data(self, oldData, sizeof(oldData)) == 0) {
      path_join(newData, sizeof(newData), install, "OmniPanelData");
      char probe[MAX_PATH];
      snprintf(probe, sizeof(probe), "%s\\servers.json", newData);
      if (!file_exists(probe)) {
        printf("\n");
        color(1);
        printf("  Нашёл прежние настройки и серверы:\n");
        printf("    %s\n", oldData);
        color(0);
        printf("  Перенести их в новую панель?  Enter — да,   Esc — нет. ");
        int c = 0;
        do { c = _getch(); } while (c != 13 && c != 27 && c != 10);
        printf("\n");
        if (c != 27) {
          printf("  Переношу данные … ");
          if (copy_tree(oldData, newData) == 0) printf("готово\n");
          else printf("не вышло (можно скопировать папку вручную)\n");
        } else {
          printf("  Хорошо, начал с чистых настроек. Старые данные остались на месте.\n");
        }
      }
    }
  }

  printf("  Создаю ярлыки … ");
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
  printf("готово\n\n");

  rule();
  printf("  Установлено. Запускаю панель…\n");
  printf("\n");
  printf("  Этот файл-установщик можно удалить — панель уже на месте\n");
  printf("  и запускается ярлыком. Если запустить его снова, он просто\n");
  printf("  откроет установленную панель.\n");
  rule();
  printf("\n");

  char cmd[MAX_PATH + 16];
  snprintf(cmd, sizeof(cmd), "\"%s\"", exe);
  run_detached(cmd);
  Sleep(2500);
  restore_cursor();
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
