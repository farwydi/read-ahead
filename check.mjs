// Один сквозной сценарий: настоящие расширения, изолированные профили и Xvfb.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {createRequire} from "node:module";
import {fileURLToPath, pathToFileURL} from "node:url";
import {execFileSync, spawn} from "node:child_process";
import "./text.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {chromium, firefox} = require(process.env.READAHEAD_PLAYWRIGHT ?? "playwright");
const xdotool = process.env.READAHEAD_XDOTOOL ?? "xdotool";
const endpoint = "http://10.44.0.19:8080/v1/audio/speech";
const title = "Read Ahead browser check";
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body>
  <nav>Навигацию не читать.</nav><main><h1>Проверка чтения.</h1>
  <p id="one">Первое <strong>предложение</strong>.</p>
  <p id="two">Второе предложение.</p><p hidden>Скрытый текст не читать.</p>
  <p id="three">Третье <b>важное</b> <i>предложение</i>.</p>
  <form><textarea>Личные данные не читать.</textarea></form></main>
  <footer>Подвал не читать.</footer></body></html>`;
const headers = {"Content-Security-Policy": "default-src 'none'; style-src 'none'; script-src 'none'; media-src 'none'; connect-src 'none'; require-trusted-types-for 'script'"};
const {split} = globalThis.ReadAheadText;
assert.deepEqual(split("Число 3.14. Всё хорошо!").map(x => x.text), ["Число 3.14.", "Всё хорошо!"]);
const long = "Длинное предложение с пробелами, ".repeat(50) + "Конец.";
assert.equal(split(long).map(x => x.text).join(" "), long);
assert(split(long).every(x => x.text.length <= 200 && x.text === long.slice(x.start, x.end).replace(/\s+/gu, " ")));
assert(split("Я".repeat(199) + "😀" + "А".repeat(201)).every(x => x.text.isWellFormed()));

const xvfb = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {stdio: ["ignore", "pipe", "ignore"]});
const display = ":" + await new Promise((resolve, reject) => {
  xvfb.once("error", reject);
  xvfb.stdout.once("data", data => resolve(data.toString().trim()));
});
const env = {...process.env, DISPLAY: display};
const pcm = Buffer.alloc(24000 * 2 * 2);
for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(100 * Math.sin(i / 12)), i * 2);
fs.mkdirSync(path.join(root, "test-results"), {recursive: true});

let windowNumber = 0;
async function open(page) {
  const windowTitle = `${title} - ${++windowNumber} -`;
  await page.evaluate(title => { document.title = title; }, windowTitle);
  await page.bringToFront();
  const window = execFileSync(xdotool, ["search", "--sync", "--onlyvisible", "--name", windowTitle], {env, timeout: 5000})
    .toString().trim().split("\n")[0];
  execFileSync(xdotool, ["windowfocus", "--sync", window], {env});
  execFileSync(xdotool, ["key", "--clearmodifiers", "alt+shift+r"], {env});
  await page.locator("#read-ahead-panel .panel").waitFor();
}
async function status(page, text, timeout = 10000) {
  await page.waitForFunction(text => document.querySelector("#read-ahead-panel")?.shadowRoot
    .querySelector(".status").textContent.includes(text), text, {timeout});
}
async function position(page, value) {
  await page.waitForFunction(value => document.querySelector("#read-ahead-panel")?.shadowRoot
    .querySelector(".counter").textContent === value, value);
}
async function select(page, selector) {
  await page.evaluate(selector => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector));
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }, selector);
}
async function close(page) {
  await page.getByRole("button", {name: "Остановить и закрыть", exact: true}).click();
  assert.equal(await page.locator("#read-ahead-panel").count(), 0);
  assert.equal(await page.evaluate(() => CSS.highlights.has("read-ahead")), false);
}

try {
  const names = process.argv.includes("--chromium") ? ["chromium"] : process.argv.includes("--firefox") ? ["firefox"] : ["chromium", "firefox"];
  for (const name of names) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "read-ahead-check-"));
    let context, remote, proxyServer;
    const calls = [];
    let fail = false, delay, release, live = false;
    try {
      // HTTP-прокси одинаково перехватывает фоновые запросы обоих браузеров.
      proxyServer = http.createServer(async (request, response) => {
        if (request.url !== endpoint) { response.writeHead(502); response.end(); return; }
        const parts = [];
        for await (const part of request) parts.push(part);
        const raw = Buffer.concat(parts);
        const body = JSON.parse(raw);
        assert(body.input.length <= 200);
        assert.equal(body.response_format, "pcm");
        assert.equal(body.max_new_tokens, 256);
        calls.push(body.input);
        if (live) {
          const upstream = http.request(endpoint, {method: "POST", headers: {"Content-Type": "application/json"}}, reply => {
            response.writeHead(reply.statusCode, {"Content-Type": reply.headers["content-type"]});
            reply.pipe(response);
          });
          upstream.on("error", () => { response.writeHead(502); response.end(); });
          response.on("close", () => upstream.destroy());
          upstream.end(raw);
          return;
        }
        if (delay) await delay;
        response.writeHead(fail ? 503 : 200, {"Content-Type": "audio/pcm"});
        response.end(fail ? "Unavailable" : pcm);
      });
      proxyServer.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
      await new Promise(resolve => proxyServer.listen(0, "127.0.0.1", resolve));
      const proxy = {server: `http://127.0.0.1:${proxyServer.address().port}`};
      if (name === "firefox") {
        const webext = process.env.READAHEAD_WEB_EXT ?? path.dirname(require.resolve("web-ext/package.json"));
        const remoteAPI = await import(pathToFileURL(path.join(webext, "lib/firefox/remote.js")));
        const port = await remoteAPI.findFreeTcpPort();
        context = await firefox.launchPersistentContext(profile, {headless: false, env, proxy,
          args: ["--start-debugger-server", String(port)], firefoxUserPrefs: {
            "devtools.debugger.remote-enabled": true, "devtools.chrome.enabled": true,
            "devtools.debugger.prompt-connection": false, "media.volume_scale": "0.0",
          }});
        remote = await remoteAPI.connectWithMaxRetries({port});
        await remote.installTemporaryAddon(root);
      } else {
        context = await chromium.launchPersistentContext(profile, {headless: false, channel: "chromium", env, proxy,
          args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--mute-audio"]});
      }
      context.setDefaultTimeout(10000);
      context.on("weberror", error => console.error(name, error.error().message));
      await context.route("https://read-ahead.test/**", route => route.fulfill({contentType: "text/html", headers, body: html}));
      const page = await context.newPage();
      await page.goto("https://read-ahead.test/");
      await open(page);
      await position(page, "1 / 4");
      assert.equal(calls.length, 0, "до нажатия «Читать» текст не уходит на сервер");
      const style = await page.locator("#read-ahead-panel .panel").evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(style, "rgb(252, 251, 247)", "панель должна работать при строгом CSP");
      await page.locator(".play").click();
      await status(page, "Читаю", 30000);
      assert.deepEqual(await page.evaluate(() => [...CSS.highlights.get("read-ahead")].map(range => range.toString().trim())), ["Проверка чтения."]);
      await page.locator(".play").click();
      await status(page, "Пауза");
      await page.waitForTimeout(2200);
      await position(page, "1 / 4");
      assert.equal(calls.length, 2, "только текущее и одно следующее предложение");
      await page.locator(".play").click();
      await position(page, "2 / 4");
      await page.getByRole("button", {name: "Следующее предложение", exact: true}).click();
      await position(page, "3 / 4");
      await page.getByRole("button", {name: "Предыдущее предложение", exact: true}).click();
      await position(page, "2 / 4");
      await page.locator(".play").press(" ");
      await status(page, "Пауза");
      await page.screenshot({path: path.join(root, "test-results", `${name}.png`)});
      await close(page);

      await select(page, "#three");
      await open(page);
      await position(page, "1 / 1");
      assert.equal(await page.locator(".text").textContent(), "Третье важное предложение.");
      fail = true;
      await page.locator(".play").click();
      await status(page, "HTTP 503");
      fail = false;
      await page.getByRole("button", {name: "↻ Повторить", exact: true}).click();
      await status(page, "Читаю");
      await status(page, "Прочитано");
      assert.equal(calls.at(-1), "Третье важное предложение.");
      await close(page);

      delay = new Promise(resolve => { release = resolve; });
      await select(page, "#one");
      await open(page);
      await page.locator(".play").click();
      await status(page, "Готовлю");
      await close(page);
      release(); delay = undefined;
      await select(page, "#two");
      await open(page);
      await page.locator(".play").click();
      await status(page, "Читаю");
      assert.equal(await page.locator(".text").textContent(), "Второе предложение.");
      const second = await context.newPage();
      await second.goto("https://read-ahead.test/other");
      await select(second, "#one");
      await open(second);
      await second.locator(".play").click();
      await status(page, "другой вкладке");
      await status(second, "Читаю");
      await close(second);
      await second.close();
      await close(page);

      if (process.argv.includes("--live")) {
        live = true;
        await select(page, "#one");
        await open(page);
        const start = Date.now();
        await page.locator(".play").click();
        await status(page, "Читаю", 30000);
        console.log(`${name}: Qwen, первое воспроизведение за ${Date.now() - start} мс`);
        await status(page, "Прочитано", 30000);
        await close(page);
      }
      console.log(`${name} ${context.browser().version()}: OK, ${calls.length} запросов, CSP/выделение/подсветка/пауза/переходы/ошибка/отмена/две вкладки`);
    } catch (error) {
      for (const page of context?.pages() ?? []) {
        console.error(name, await page.evaluate(() => document.querySelector("#read-ahead-panel")?.shadowRoot?.querySelector(".panel").textContent).catch(() => "closed"));
      }
      throw error;
    } finally {
      remote?.disconnect();
      await context?.close();
      release?.();
      proxyServer?.closeAllConnections();
      proxyServer?.close();
      fs.rmSync(profile, {recursive: true, force: true});
    }
  }
} finally { xvfb.kill(); }
