/* global browser, chrome, ReadAheadText */
(() => {
  if (globalThis.__readAheadLoaded) return;
  globalThis.__readAheadLoaded = true;
  const api = globalThis.browser ?? chrome;
  let ui, audio, source, port, pending;
  let data, index = 0, generation = 0, requestId = 0, paused = true, state = "ready";
  const cache = new Map();
  const abortError = () => new DOMException("Отменено", "AbortError");

  function element(tag, attributes = {}, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
    el.append(...children);
    return el;
  }

  function makePanel(selected) {
    const host = element("div", {id: "read-ahead-panel"});
    const shadow = host.attachShadow({mode: "open"});
    const style = element("style");
    style.textContent = `
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      .panel { max-width: 880px; margin: 0 auto; padding: 14px 18px 12px;
        background: #fcfbf7; color: #203740; border: 1px solid #cbd6d3; border-radius: 16px;
        box-shadow: 0 6px 30px #122b3a30; font: 14px/1.45 system-ui, sans-serif; }
      .bar, .controls, .bottom { display: flex; align-items: center; gap: 8px; }
      .bar { flex-wrap: wrap; justify-content: space-between; }
      .brand { font-size: 16px; font-weight: 700; letter-spacing: -.3px; }
      .mode { font-size: 12px; color: #52696f; margin-left: 8px; }
      button { border: 1px solid #cbd6d3; border-radius: 9px; background: #fff;
        color: #203740; padding: 7px 12px; font: inherit; cursor: pointer; min-height: 36px; }
      button:hover:enabled { background: #e9f0ec; }
      button:focus-visible, input:focus-visible { outline: 3px solid #228674; outline-offset: 2px; }
      button:disabled { opacity: .4; cursor: default; }
      .play { background: #163b47; color: #fff; min-width: 116px; border-color: #163b47; }
      .play:hover:enabled { background: #286272; }
      .close { border-color: transparent; background: transparent; font-size: 20px; padding: 1px 9px; }
      .text { margin: 12px 0; overflow-wrap: anywhere; font-size: 16px; }
      .bottom { font-size: 12px; color: #52696f; flex-wrap: wrap; }
      .status { flex: 1; min-width: 120px; }
      .counter { font-variant-numeric: tabular-nums; }
      label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
      input { accent-color: #163b47; }
      @media (max-width: 560px) { .panel { padding: 10px 12px; } .mode { display: none; }
        .brand { font-size: 14px; } button { padding: 6px 9px; } .controls { gap: 4px; } }
    `;
    const previous = element("button", {type: "button", title: "Предыдущее предложение (←)", "aria-label": "Предыдущее предложение"}, "←");
    const play = element("button", {type: "button", class: "play", title: "Читать / пауза (пробел)"}, "▶ Читать");
    const next = element("button", {type: "button", title: "Следующее предложение (→)", "aria-label": "Следующее предложение"}, "→");
    const close = element("button", {type: "button", class: "close", title: "Остановить и закрыть (Esc)", "aria-label": "Остановить и закрыть"}, "×");
    const current = element("p", {class: "text"});
    const status = element("span", {class: "status", role: "status", "aria-live": "polite"});
    const counter = element("span", {class: "counter", "aria-label": "Позиция в тексте"});
    const follow = element("input", {type: "checkbox", checked: ""});
    const panel = element("section", {class: "panel", "aria-label": "Read Ahead — чтение вслух"},
      element("div", {class: "bar"},
        element("div", {}, element("span", {class: "brand"}, "Read Ahead"),
          element("span", {class: "mode"}, selected ? "Выделенный текст" : "Текст страницы")),
        element("div", {class: "controls", role: "group", "aria-label": "Управление чтением"}, previous, play, next, close)),
      current, element("div", {class: "bottom"}, status, counter,
        element("label", {}, follow, "Следить за текстом")));
    shadow.append(style, panel);
    document.documentElement.append(host);
    previous.onclick = () => { if (index > 0) void go(index - 1); };
    next.onclick = () => { if (index + 1 < data.chunks.length) void go(index + 1); };
    play.onclick = toggle;
    close.onclick = closeReader;
    follow.onchange = highlight;
    host.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); closeReader(); return; }
      if (event.target === host && event.composedPath()[0].tagName === "INPUT") return;
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === " ") { event.preventDefault(); toggle(); }
      if (event.key === "ArrowLeft") { event.preventDefault(); previous.click(); }
      if (event.key === "ArrowRight") { event.preventDefault(); next.click(); }
    });
    play.focus({preventScroll: true});
    return {host, play, previous, next, current, status, counter, follow};
  }

  function render(message) {
    if (!ui) return;
    const labels = {ready: "Готово к чтению · домашний голос", loading: "Готовлю озвучку…",
      playing: "Читаю", paused: "Пауза", done: "Прочитано", error: "Не удалось прочитать"};
    ui.status.textContent = message ?? labels[state];
    ui.play.textContent = state === "error" ? "↻ Повторить" : state === "done" ? "↻ Сначала"
      : !paused ? "Ⅱ Пауза" : state === "ready" ? "▶ Читать" : "▶ Продолжить";
    ui.play.setAttribute("aria-pressed", String(!paused));
    ui.play.disabled = !data?.chunks.length;
    ui.previous.disabled = !data?.chunks.length || index === 0;
    ui.next.disabled = !data?.chunks.length || index + 1 >= data.chunks.length;
    ui.counter.textContent = data?.chunks.length ? `${index + 1} / ${data.chunks.length}` : "";
    ui.current.textContent = data?.chunks[index]?.text ?? "Выделите текст на странице и откройте Read Ahead снова.";
  }

  function highlight() {
    CSS.highlights?.delete("read-ahead");
    if (!ui || !data?.chunks[index]) return;
    const range = ReadAheadText.rangeFor(data.chunks[index], data.spans, document);
    if (!range) return;
    if (CSS.highlights && globalThis.Highlight) CSS.highlights.set("read-ahead", new Highlight(range));
    const rect = range.getBoundingClientRect();
    if (ui.follow.checked && (rect.top < ui.host.getBoundingClientRect().bottom + 16 || rect.bottom > innerHeight - 40)) {
      range.startContainer.parentElement.scrollIntoView({block: "center", behavior: "instant"});
    }
  }

  function stopSource() {
    if (source) { source.onended = null; source.stop(); source.disconnect(); source = undefined; }
  }

  function cancelPending() {
    if (!pending) return;
    const task = pending;
    pending = undefined;
    try { port?.postMessage({type: "cancel"}); } catch {}
    task.reject(abortError());
  }

  function connection() {
    if (port) return port;
    const opened = api.runtime.connect({name: "read-ahead"});
    port = opened;
    opened.onMessage.addListener(message => {
      if (message.stopped) {
        generation++;
        stopSource(); cancelPending();
        paused = true; state = "paused";
        void audio?.suspend();
        render("Чтение открыто в другой вкладке.");
        return;
      }
      if (!pending || message.id !== pending.id) return;
      const task = pending;
      pending = undefined;
      if (message.error) { task.reject(new Error(message.error)); return; }
      try {
        const bytes = Uint8Array.from(atob(message.pcm), char => char.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        const buffer = audio.createBuffer(1, bytes.length / 2, 24000);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        cache.set(task.index, buffer);
        task.resolve(buffer);
      } catch (error) { task.reject(error); }
    });
    opened.onDisconnect.addListener(() => {
      void api.runtime.lastError;
      if (port !== opened) return;
      port = undefined;
      const task = pending;
      pending = undefined;
      task?.reject(new Error("Соединение с расширением прервалось. Нажмите «Повторить»."));
    });
    return opened;
  }

  function load(position) {
    const cached = cache.get(position);
    if (cached) return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
    if (pending?.index === position) return pending.promise;
    cancelPending();
    const opened = connection();
    const task = {id: ++requestId, index: position};
    task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    pending = task;
    try { opened.postMessage({id: task.id, text: data.chunks[position].text}); }
    catch (error) { pending = undefined; task.reject(error); }
    return task.promise;
  }

  function prefetch() {
    const position = index + 1;
    if (paused || !ui || position >= data.chunks.length) return;
    const turn = generation;
    void load(position).catch(error => {
      if (turn === generation && error.name !== "AbortError") cache.set(position, error);
    });
  }

  async function go(position) {
    if (!ui || position < 0 || position >= data.chunks.length) return;
    const turn = ++generation;
    stopSource();
    index = position;
    for (const key of cache.keys()) if (key < index - 1 || key > index + 1) cache.delete(key);
    state = paused ? "paused" : "loading";
    try {
      render(); highlight();
      // до первого «Читать» перемотка только выбирает предложение.
      if (!audio) return;
      const buffer = await load(index);
      if (!ui || turn !== generation) return;
      source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.onended = () => {
        if (turn !== generation || !ui) return;
        source?.disconnect(); source = undefined;
        if (index + 1 < data.chunks.length) void go(index + 1);
        else {
          paused = true; state = "done";
          void audio.suspend();
          CSS.highlights?.delete("read-ahead");
          render();
        }
      };
      source.start();
      state = paused ? "paused" : "playing";
      render();
      prefetch();
    } catch (error) {
      if (turn !== generation || !ui || error.name === "AbortError") return;
      paused = true; state = "error";
      void audio?.suspend();
      render(error.message);
    }
  }

  function toggle() {
    if (!ui || !data.chunks.length) return;
    if (!audio) audio = new AudioContext();
    if (!paused) {
      paused = true; state = "paused";
      void audio.suspend(); render();
      return;
    }
    // вызов из клика/клавиши нужен для политики автозапуска обоих браузеров.
    void audio.resume().catch(error => { state = "error"; paused = true; render(error.message); });
    connection();
    paused = false;
    if (state === "error") cache.delete(index);
    if (state === "done") { void go(0); return; }
    if (source) { state = "playing"; render(); prefetch(); }
    else void go(index);
  }

  function closeReader() {
    generation++;
    stopSource(); cancelPending();
    port?.disconnect(); port = undefined;
    void audio?.close(); audio = undefined;
    cache.clear();
    CSS.highlights?.delete("read-ahead");
    ui?.host.remove(); ui = undefined;
    data = undefined; index = 0; paused = true; state = "ready";
  }

  function open() {
    if (ui) { ui.play.focus({preventScroll: true}); return; }
    const selection = getSelection();
    const range = selection?.toString().trim() && selection.rangeCount
      ? selection.getRangeAt(0).cloneRange() : null;
    data = ReadAheadText.extract(document, range);
    ui = makePanel(Boolean(range));
    render(data.chunks.length ? undefined : "На этой странице не найден текст для чтения.");
  }
  api.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === "read-ahead:open") { open(); reply({ok: true}); }
  });
  addEventListener("pagehide", closeReader);
})();
