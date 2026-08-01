# GPU transcription server (runs on the PC, not the Pi)

Transcribing on the Pi is the slowest part of this whole project by a wide
margin. whisper.cpp encodes a fixed **30-second window** regardless of how
short the audio actually is, and the Pi's 4-core ARM CPU takes ~65 seconds per
window. Discord hands us one short clip per speaking turn, so a real session is
hundreds of clips, each burning a full window.

Measured on this setup:

| | Pi (CPU) | PC (RTX 3080 Ti) |
|---|---|---|
| One ~2s clip | ~69 s | **0.17 s** |
| 235-clip session (28 min) | ~4.5 hours | **~40 seconds** |
| ~3-hour session | ~30 hours | **~4 minutes** |

The audio never leaves your network — this is your own PC on the LAN, the same
one already running Ollama.

## Setup

1. **Get the model.** The container does not download models itself. Either
   copy the one the Pi already has, or download it:

   ```bash
   scp pihouse:/home/mattpi/scriber/pi-service/models/ggml-medium.en.bin ./models/
   ```

2. **Start it:**

   ```bash
   docker compose up -d
   docker logs scriber-whisper | grep "CUDA devices"
   ```

   You want to see `found 1 CUDA devices ... RTX 3080 Ti`. See the GPU
   troubleshooting note below if you don't — it will happily run on CPU
   instead and look like it worked.

3. **Point the Pi at it** — in `pi-service/.env`:

   ```
   WHISPER_SERVER_URL=http://192.168.0.153:8089
   ```

   (Use the PC's LAN IP, the same one `OLLAMA_URL` uses.) Restart the bot.

4. **Firewall.** Docker Desktop opened this port automatically here, so no
   manual rule was needed — unlike Ollama's 11434. If the Pi can't reach it,
   add an inbound TCP rule for 8089 in **both** Windows Firewall and
   Bitdefender, exactly as you did for Ollama.

   Check from the Pi with:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://192.168.0.153:8089/
   ```

## Two things worth knowing

**It holds ~1.5 GB of VRAM the whole time it's running.** With `restart:
unless-stopped` it comes back on every boot and sits on that memory. If you
game on this machine, either `docker compose stop scriber-whisper` when you
want the VRAM back, or drop `restart:` and start it only around sessions. The
bot falls back to the Pi's CPU whenever the server is unreachable, so stopping
it never loses a session — it just makes that one slow.

**Port 8089, not whisper's default 8080**, which was already in use on this PC.

## GPU troubleshooting

Two non-obvious problems were hit setting this up, both already handled in
`docker-compose.yml`, but worth knowing if it ever breaks:

1. **`deploy.resources.reservations.devices` is silently ignored** by Docker
   Desktop here. The container starts, whisper logs `no GPU found`, and it
   quietly runs on CPU — which looks like success. `gpus: all` is what
   actually works.

2. **The image ships CUDA "compat" driver stubs** in `/usr/local/cuda-13.0/
   compat` and puts that directory *first* on `LD_LIBRARY_PATH`. Under WSL2
   those shadow the real driver library, and CUDA fails with `no CUDA-capable
   device is detected` — even though `nvidia-smi` inside the container happily
   lists the GPU. The compose file overrides `LD_LIBRARY_PATH` to drop
   `compat`, which fixes it.

If it's running on CPU, `docker logs scriber-whisper` says so plainly:
`whisper_backend_init_gpu: no GPU found`.
