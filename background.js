/* global browser, chrome */
const api = globalThis.browser ?? chrome;
const ENDPOINT = "http://10.44.0.19:8080/v1/audio/speech";
let activePort, stopActive;

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll().then(() => api.contextMenus.create({
    id: "read-ahead", title: "Прочитать в Read Ahead", contexts: ["selection", "page"],
  }));
});

async function openReader(tab) {
  if (!tab?.id) return;
  try {
    await api.scripting.executeScript({
      target: {tabId: tab.id}, files: ["text.js", "content.js"],
    });
    await api.scripting.insertCSS({target: {tabId: tab.id}, files: ["page.css"]});
    await api.tabs.sendMessage(tab.id, {type: "read-ahead:open"});
    await api.action.setBadgeText({tabId: tab.id, text: ""});
    await api.action.setTitle({tabId: tab.id, title: "Read Ahead — читать вслух"});
  } catch {
    await api.action.setBadgeText({tabId: tab.id, text: "!"}).catch(() => {});
    await api.action.setTitle({tabId: tab.id,
      title: "Read Ahead: откройте обычную веб-страницу. Служебные страницы и PDF недоступны.",
    }).catch(() => {});
  }
}

api.action.onClicked.addListener(openReader);
api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "read-ahead") void openReader(tab);
});

function base64(bytes) {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(result);
}

api.runtime.onConnect.addListener(port => {
  if (port.name !== "read-ahead" || port.sender?.id !== api.runtime.id ||
      !port.sender.tab || port.sender.frameId !== 0) {
    port.disconnect();
    return;
  }
  // ponytail: один читатель на браузер; сервер рассчитан на один поток озвучки.
  stopActive?.();
  activePort = port;
  let current;
  const reply = message => { try { port.postMessage(message); } catch {} };
  stopActive = () => { current?.abort(); reply({stopped: true}); port.disconnect(); };
  port.onDisconnect.addListener(() => {
    current?.abort();
    if (activePort === port) { activePort = undefined; stopActive = undefined; }
  });
  port.onMessage.addListener(async message => {
    if (!message || typeof message !== "object") return;
    if (message.type === "cancel") { current?.abort(); return; }
    const {id, text} = message;
    if (!Number.isSafeInteger(id) || typeof text !== "string" ||
        !text.trim() || text.length > 200) {
      reply({id, error: "Недопустимый фрагмент текста."});
      return;
    }
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", headers: {"Content-Type": "application/json"},
        credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
        body: JSON.stringify({model: "qwen3-tts", input: text, voice: "russian",
          language: /[а-яё]/i.test(text) ? "Russian" : "English",
          response_format: "pcm", max_new_tokens: 256}),
      });
      if (!response.ok) throw new Error(`Qwen вернул HTTP ${response.status}.`);
      if (!response.headers.get("content-type")?.startsWith("audio/pcm")) {
        throw new Error("Qwen вернул неожиданный формат аудио.");
      }
      // PCM позволяет серверу отменить синтез при закрытии соединения.
      const reader = response.body.getReader();
      const parts = [];
      let size = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_100_000) throw new Error("Qwen вернул слишком длинное аудио.");
        parts.push(value);
      }
      if (size < 2 || size % 2) throw new Error("Qwen вернул повреждённое или пустое аудио.");
      const pcm = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { pcm.set(part, offset); offset += part.length; }
      if (!controller.signal.aborted) reply({id, pcm: base64(pcm)});
    } catch (error) {
      if (current === controller) reply({id, error: controller.signal.aborted
        ? "Синтез отменён или занял больше 25 секунд. Нажмите «Повторить»."
        : `Не удалось получить озвучку: ${error.message} Сервер: 10.44.0.19:8080.`});
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (current === controller) current = undefined;
    }
  });
});
