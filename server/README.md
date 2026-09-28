# HTTP-сервер Read Ahead

Сервер — [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp),
закреплённый submodule `qwentts.cpp` на ревизии
`22abf0be819831cc1c3e498f6e493ec8e626de47`, с собственным закреплённым ggml.
HTTP-реализация находится в `qwentts.cpp/tools/tts-server.cpp`, запуск и
регистрация голосов — в `qwentts.cpp/docker/entrypoint.sh`.

Серверные релизы имеют теги `server-v*`; версия расширения и его подпись
Mozilla от них не зависят. `read-ahead-server-0.1.0-linux-amd64.tar.gz`
содержит готовый `tts-server`, штатный `entrypoint.sh`, `verify.py`,
`build.json` с ревизией upstream и лицензии стороннего кода.
ggml включён статически; веса и эталоны голосов в архив не входят.

## Установка

Архив рассчитан на **Debian 13 amd64**, CPU с **AVX2, FMA, F16C**,
Vulkan или CPU backend. На Radeon 890M используется `GGML_BACKEND=Vulkan0`.
Нужны системные пакеты `libstdc++6`, `libgcc-s1`, `libgomp1`, `libvulkan1`,
`mesa-vulkan-drivers`, `bash`, `curl`, `jq`; для проверки — `python3`.
Сборщик и Git для установки готового архива не нужны.

Архив распаковывается в отдельный каталог версии. `/app/tts-server` должен
ссылаться на бинарник этой версии: это путь штатного upstream entrypoint.
Сервис запускается как `bash /путь/к/релизу/entrypoint.sh` с переменными:

```ini
GGML_BACKEND=Vulkan0
MODEL_PATH=/var/lib/qwen-tts/qwen-talker-1.7b-base-Q8_0.gguf
CODEC_PATH=/var/lib/qwen-tts/qwen-tokenizer-12hz-Q8_0.gguf
MODEL_ALIAS=qwen3-tts
TTS_LANG=Russian
HOST=0.0.0.0
PORT=8080
MAX_BATCH=1
CODEC_CHUNK_DUR=5
```

Веса Qwen3-TTS 1.7B Base Q8 и tokenizer Q8 берутся из
[Serveurperso/Qwen3-TTS-GGUF](https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF).
В `/voices/russian.wav` нужен разрешённый к использованию эталон голоса:
PCM16 mono 24 kHz; `/voices/russian.txt` — его точная расшифровка.
Entrypoint регистрирует голос `russian` при каждом запуске.

HTTP: `GET /health`, `GET /v1/audio/voices`, `POST /v1/audio/speech`.
Запрос расширения:

```json
{"model":"qwen3-tts","input":"Привет!","voice":"russian","language":"Russian","response_format":"pcm","max_new_tokens":256}
```

PCM — s16le mono 24 kHz, потоковый; `response_format: "wav"` выдаёт WAV
после синтеза. Сначала дождаться `russian` в `/v1/audio/voices`.
Сервис рассчитан на доверенную LAN: аутентификации и TLS в нём нет.
Практический профиль — один клиент, короткие предложения, один запрос
одновременно. `max_new_tokens` задаётся клиентом.

## Сборка релиза

Все действия на build-хосте выполняет Ansible. Плейбук требует root или
`--become`, устанавливает build-зависимости, собирает в отдельной временной
папке и удаляет её в `always`, в том числе при ошибке. Работающий сервис,
его бинарники и веса не меняются. Build-зависимости остаются на build-хосте.

```sh
git clone --recurse-submodules https://github.com/farwydi/read-ahead.git
cd read-ahead
ansible-playbook -i 'BUILD_HOST,' -u root server/build.yml
sha256sum dist/read-ahead-server-0.1.0-linux-amd64.tar.gz
```

`BUILD_HOST` — отдельный хост Debian 13 amd64 с SSH. Для существующего
inventory указывать `--limit` ровно на один build-хост. Версия задаётся
`-e server_version=0.1.0`. Ревизия берётся из HEAD submodule на контроллере;
изменения upstream сначала коммитятся и фиксируются этим submodule.
Сборка использует CPU AVX2 без `-march=native` и Vulkan, два compiler job.
Перед упаковкой запускается штатный `test-abi-c`.

## Проверка установленного релиза

```sh
python3 /путь/к/релизу/verify.py
```

Один stdlib-сценарий обращается к `http://127.0.0.1:8080`: WAV, два
PCM-запроса (прогрев и повтор), непустой сигнал и отказ на пустой текст.
Печатает задержку, длительность речи и RTF; сохраняет образец
`/tmp/qwen-tts-check.wav` для прослушивания. В Ansible homelab этот образец
забирается на контроллер и удаляется с сервера в `always`.
