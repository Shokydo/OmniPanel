/* ЭТОТ ФАЙЛ СОБИРАЕТСЯ АВТОМАТИЧЕСКИ: node tools/gen-tauri-bridge.js
 *
 * Мост «интерфейс → Rust» для сборки на Tauri. В Electron он молчит и ничего
 * не делает: там window.desktop уже создаёт preload.js.
 *
 * Таблица ниже — это ровно те же 153 методов, которыми пользуется
 * интерфейс. Пока команда не перенесена в Rust, она отвечает понятной ошибкой,
 * а не молча ломает окно.
 */
(function bridgeToRust() {
  'use strict';
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke) return;

  const invoke = tauri.core.invoke;
  const listen = tauri.event && tauri.event.listen;

  const TABLE = {
  "list": ["servers:list", 0, "invoke"],
  "startAll": ["servers:startAll", 0, "invoke"],
  "stopAll": ["servers:stopAll", 0, "invoke"],
  "restartAll": ["servers:restartAll", 0, "invoke"],
  "winMinimize": ["win:minimize", 0, "invoke"],
  "winClose": ["win:close", 0, "invoke"],
  "winQuit": ["win:quit", 0, "invoke"],
  "winToggleMax": ["win:toggleMax", 0, "invoke"],
  "winToggleFull": ["win:toggleFull", 0, "invoke"],
  "winIsVisible": ["win:isVisible", 0, "invoke"],
  "winState": ["win:state", 0, "invoke"],
  "winGetStartMode": ["win:getStartMode", 0, "invoke"],
  "winSetStartMode": ["win:setStartMode", 1, "invoke"],
  "notifyDesktop": ["notify:desktop", 1, "invoke"],
  "wallPick": ["wall:pick", 0, "invoke"],
  "wallRemove": ["wall:remove", 1, "invoke"],
  "updConfig": ["upd:config", 0, "invoke"],
  "updSave": ["upd:save", 1, "invoke"],
  "updCheck": ["upd:check", 0, "invoke"],
  "updAuto": ["upd:auto", 0, "invoke"],
  "onUpdReady": ["upd:ready", 0, "event"],
  "updApply": ["upd:apply", 0, "invoke"],
  "updDownloadFull": ["upd:downloadFull", 0, "invoke"],
  "updRevealBackups": ["upd:revealBackups", 0, "invoke"],
  "onUpdState": ["upd:state", 0, "event"],
  "onUpdAvailable": ["upd:available", 0, "event"],
  "onUpdProgress": ["upd:progress", 0, "event"],
  "onGhStage": ["gh:stage", 0, "event"],
  "ghVerify": ["gh:verify", 1, "invoke"],
  "ghAccount": ["gh:account", 0, "invoke"],
  "ghLogin": ["gh:login", 1, "invoke"],
  "ghLogout": ["gh:logout", 0, "invoke"],
  "ghRepos": ["gh:repos", 1, "invoke"],
  "ghOauthClientId": ["gh:oauthClientId", 0, "invoke"],
  "ghSetOauthClientId": ["gh:setOauthClientId", 1, "invoke"],
  "ghDeviceStart": ["gh:deviceStart", 0, "invoke"],
  "ghDevicePoll": ["gh:devicePoll", 1, "invoke"],
  "ghOpenExternal": ["gh:openExternal", 1, "invoke"],
  "ghDownload": ["gh:download", 1, "invoke"],
  "ghCreateRepo": ["gh:createRepo", 2, "invoke"],
  "ghCheck": ["gh:check", 1, "invoke"],
  "ghPull": ["gh:pull", 1, "invoke"],
  "ghPush": ["gh:push", 1, "invoke"],
  "ghStatus": ["gh:status", 1, "invoke"],
  "ghForget": ["gh:forget", 1, "invoke"],
  "serverAutoFolder": ["server:autoFolder", 0, "invoke"],
  "serverMoveToApp": ["server:moveToApp", 2, "invoke"],
  "onMoveProgress": ["move-progress", 0, "event"],
  "onWinState": ["win:state", 0, "event"],
  "add": ["servers:add", 1, "invoke"],
  "update": ["servers:update", 2, "invoke"],
  "remove": ["servers:remove", 1, "invoke"],
  "reorder": ["servers:reorder", 1, "invoke"],
  "start": ["server:start", 1, "invoke"],
  "stop": ["server:stop", 1, "invoke"],
  "restart": ["server:restart", 1, "invoke"],
  "kill": ["server:kill", 1, "invoke"],
  "command": ["server:command", 2, "invoke"],
  "logs": ["server:logs", 1, "invoke"],
  "clearLogs": ["server:clearLogs", 1, "invoke"],
  "info": ["app:info", 0, "invoke"],
  "pickIcon": ["icon:pick", 0, "invoke"],
  "autostartGet": ["autostart:get", 0, "invoke"],
  "autostartSet": ["autostart:set", 1, "invoke"],
  "scanRoots": ["scan:roots", 0, "invoke"],
  "filesList": ["files:list", 2, "invoke"],
  "filesRead": ["files:read", 2, "invoke"],
  "filesWrite": ["files:write", 3, "invoke"],
  "filesMkdir": ["files:mkdir", 2, "invoke"],
  "filesRemove": ["files:remove", 2, "invoke"],
  "filesRename": ["files:rename", 3, "invoke"],
  "filesSearch": ["files:search", 2, "invoke"],
  "filesImage": ["files:image", 2, "invoke"],
  "filesMove": ["files:move", 3, "invoke"],
  "archiveOpen": ["archive:open", 2, "invoke"],
  "archiveRead": ["archive:read", 3, "invoke"],
  "archiveExtract": ["archive:extract", 4, "invoke"],
  "filesUpload": ["files:upload", 4, "invoke"],
  "filesOpenExternal": ["files:openExternal", 2, "invoke"],
  "filesEditor": ["files:editor", 2, "invoke"],
  "serverEditor": ["server:editor", 1, "invoke"],
  "openEditor": ["shell:editor", 1, "invoke"],
  "addonsList": ["addons:list", 0, "invoke"],
  "addonsSetEnabled": ["addons:setEnabled", 2, "invoke"],
  "addonsPanel": ["addons:panel", 1, "invoke"],
  "addonsDirs": ["addons:dirs", 0, "invoke"],
  "addonsReveal": ["addons:reveal", 1, "invoke"],
  "addonsCall": ["addons:call", 4, "invoke"],
  "portsCheck": ["ports:check", 1, "invoke"],
  "portsFree": ["ports:free", 2, "invoke"],
  "portsSet": ["ports:set", 3, "invoke"],
  "portsOwn": ["ports:own", 1, "invoke"],
  "modrinthSearch": ["modrinth:search", 1, "invoke"],
  "modrinthVersions": ["modrinth:versions", 2, "invoke"],
  "modrinthCategories": ["modrinth:categories", 1, "invoke"],
  "modrinthDetect": ["modrinth:detect", 1, "invoke"],
  "modrinthInstalled": ["modrinth:installed", 1, "invoke"],
  "modrinthInstall": ["modrinth:install", 2, "invoke"],
  "wallPalette": ["wall:palette", 1, "invoke"],
  "propsRead": ["props:read", 1, "invoke"],
  "propsWrite": ["props:write", 2, "invoke"],
  "iconToServer": ["icon:toServer", 2, "invoke"],
  "wizardCatalog": ["wizard:catalog", 0, "invoke"],
  "wizardVersions": ["wizard:versions", 1, "invoke"],
  "wizardJava": ["wizard:java", 0, "invoke"],
  "wizardOpenJava": ["wizard:openJava", 0, "invoke"],
  "wizardPickParent": ["wizard:pickParent", 0, "invoke"],
  "wizardSuggestDir": ["wizard:suggestDir", 2, "invoke"],
  "wizardCreate": ["wizard:create", 1, "invoke"],
  "onWizardProgress": ["wizard-progress", 0, "event"],
  "backupList": ["backup:list", 1, "invoke"],
  "backupCreate": ["backup:create", 2, "invoke"],
  "backupRestore": ["backup:restore", 3, "invoke"],
  "backupDelete": ["backup:delete", 1, "invoke"],
  "backupReveal": ["backup:reveal", 1, "invoke"],
  "backupSize": ["backup:size", 1, "invoke"],
  "glAccount": ["gl:account", 0, "invoke"],
  "glCheck": ["gl:check", 1, "invoke"],
  "glProjects": ["gl:projects", 1, "invoke"],
  "glSave": ["gl:save", 1, "invoke"],
  "bansList": ["bans:list", 1, "invoke"],
  "bansUnban": ["bans:unban", 2, "invoke"],
  "bansBan": ["bans:ban", 2, "invoke"],
  "onAsk": ["ui:ask", 0, "event"],
  "answerAsk": ["ui:answer", 2, "send"],
  "askReady": ["ui:ready", 0, "send"],
  "loadInfo": ["load:info", 1, "invoke"],
  "loadStart": ["load:start", 2, "invoke"],
  "loadStop": ["load:stop", 1, "invoke"],
  "loadStatus": ["load:status", 1, "invoke"],
  "loadVersions": ["load:versions", 0, "invoke"],
  "onLoadChange": ["load:change", 0, "event"],
  "onLoadLog": ["load:log", 0, "event"],
  "onLoadDone": ["load:done", 0, "event"],
  "tpsHistory": ["tps:history", 1, "invoke"],
  "tpsClear": ["tps:clear", 1, "invoke"],
  "iconFromServer": ["icon:fromServer", 1, "invoke"],
  "scanStart": ["scan:start", 1, "invoke"],
  "scanCancel": ["scan:cancel", 0, "invoke"],
  "pickFolders": ["dialog:pickFolders", 0, "invoke"],
  "onScanFound": ["scan-found", 0, "event"],
  "onScanProgress": ["scan-progress", 0, "event"],
  "checkPath": ["path:check", 1, "invoke"],
  "openPath": ["shell:openPath", 1, "invoke"],
  "pickFolder": ["dialog:pickFolder", 0, "invoke"],
  "pickFile": ["dialog:pickFile", 0, "invoke"],
  "onLog": ["log", 0, "event"],
  "onState": ["state", 0, "event"],
  "onServers": ["servers", 0, "event"],
  "onLogsCleared": ["logs-cleared", 0, "event"],
  "onTps": ["tps", 0, "event"],
  "onMetrics": ["metrics", 0, "event"],
  "onToast": ["toast", 0, "event"],
  };

  const api = {
    mode: 'desktop',
    tauri: true,
  };

  for (const [name, entry] of Object.entries(TABLE)) {
    const [channel, argc, kind] = entry;
    if (kind === 'event') {
      api[name] = async (cb) => {
        if (typeof cb !== 'function' || !listen) return () => {};
        await listen(channel, (event) => cb(event.payload));
        return () => {};
      };
    } else if (kind === 'send') {
      api[name] = (...args) => {
        invoke('ipc_send', { channel, args: args.slice(0, argc) }).catch(() => {});
      };
    } else {
      api[name] = async (...args) => {
        try {
          return await invoke('ipc_invoke', { channel, args: args.slice(0, argc) });
        } catch (err) {
          const text = String((err && err.message) || err);
          if (text.includes('не перенесено')) {
            throw new Error(text);
          }
          throw err instanceof Error ? err : new Error(text);
        }
      };
    }
  }

  /* интерфейс ждёт window.desktop — отдаём ему мост */
  window.desktop = api;
  if (window.__omnipanelBridge) window.__omnipanelBridge.ready = true;
})();
