import os
import asyncio
import subprocess
import httpx
import websockets
from fastapi import FastAPI, WebSocket, Request, Response
from contextlib import asynccontextmanager
import modal

app = modal.App("spot-trader-bot-1h")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("curl", "git")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_18.x | bash -",
        "apt-get install -y nodejs"
    )
    .pip_install(
        "fastapi",
        "uvicorn",
        "scikit-learn",
        "pandas",
        "numpy",
        "vaderSentiment",
        "torch",
        "transformers",
        "requests",
        "httpx",
        "beautifulsoup4",
        "feedparser",
        "websockets",
        "python-multipart"
    )
    .add_local_dir(".", "/root/spottrader", copy=True, ignore=["*.db", "node_modules", ".venv", ".git", "__pycache__"])
    .run_commands(
        "cd /root/spottrader && npm install"
    )
)

volume = modal.Volume.from_name("spottrader-db-volume", create_if_missing=True)

processes = {}


@asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    os.environ["PORT"] = "3001"
    os.environ["PYTHON_PORT"] = "5001"
    os.environ["ML_API_TOKEN"] = "super_secret_trading_token_change_me"
    os.environ["CONFIRM_LIVE_TRADING"] = "NO"
    os.environ["FEE_RATE"] = "0.001"
    os.environ["DB_PATH"] = "/data/trading_bot_1h.db"
    os.environ["USE_BINANCE_US"] = "YES"

    print("Starting FastAPI ML Server (1h) on port 5001...")
    ml_out = open("/root/spottrader/ml_1h_stdout.log", "w")
    ml_err = open("/root/spottrader/ml_1h_stderr.log", "w")
    ml_proc = subprocess.Popen(
        ["python", "-u", "ml/server_1h.py"],
        cwd="/root/spottrader",
        stdout=ml_out,
        stderr=ml_err
    )
    processes["ml_1h"] = (ml_proc, ml_out, ml_err)

    await asyncio.sleep(8)

    print("Starting Node.js Server (1h) on port 3001...")
    node_out = open("/root/spottrader/node_1h_stdout.log", "w")
    node_err = open("/root/spottrader/node_1h_stderr.log", "w")
    node_proc = subprocess.Popen(
        ["node", "server_1h.js"],
        cwd="/root/spottrader",
        stdout=node_out,
        stderr=node_err
    )
    processes["node_1h"] = (node_proc, node_out, node_err)

    await asyncio.sleep(5)
    if ml_proc.poll() is not None:
        print(f"ERROR: ML Server exited early with code {ml_proc.returncode}")
    else:
        print("ML Server process check: RUNNING")

    if node_proc.poll() is not None:
        print(f"ERROR: Node Server exited early with code {node_proc.returncode}")
    else:
        print("Node Server process check: RUNNING")

    yield

    print("Shutting down spottrader 1h processes...")
    for name, (proc, out, err) in processes.items():
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception as e:
            print(f"Error terminating process {name}: {e}")
        try:
            out.close()
            err.close()
        except Exception:
            pass


proxy_app = FastAPI(lifespan=lifespan)

from fastapi.middleware.cors import CORSMiddleware
proxy_app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://spotui-f16qpash7-umars-projects-6404707b.vercel.app",
        "https://spotui-chi.vercel.app",
        "http://localhost:3000",
        "http://localhost:3001",
    ],
    allow_origin_regex=r"https://spotui-.*-umars-projects-6404707b\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = httpx.AsyncClient(base_url="http://localhost:3001", timeout=30.0)


@proxy_app.get("/debug")
async def debug_endpoint():
    status = {}
    for name, (proc, _, _) in processes.items():
        status[name] = {
            "pid": proc.pid,
            "returncode": proc.poll(),
            "alive": proc.poll() is None
        }

    files = {}
    if os.path.exists("/root/spottrader"):
        try:
            files["spottrader"] = os.listdir("/root/spottrader")
        except Exception as e:
            files["spottrader"] = f"Error: {e}"

    if os.path.exists("/root/spottrader/db"):
        try:
            files["spottrader_db"] = os.listdir("/root/spottrader/db")
        except Exception as e:
            files["spottrader_db"] = f"Error: {e}"

    logs = {}
    for name in ["ml_1h", "node_1h"]:
        for log_type in ["stdout", "stderr"]:
            path = f"/root/spottrader/{name}_{log_type}.log"
            if os.path.exists(path):
                try:
                    with open(path, "r", encoding="utf-8", errors="ignore") as f:
                        lines = f.readlines()
                        logs[f"{name}_{log_type}"] = lines[-100:]
                except Exception as e:
                    logs[f"{name}_{log_type}"] = f"Error reading log: {e}"
            else:
                logs[f"{name}_{log_type}"] = "Log file not found."

    return {
        "status": status,
        "files": files,
        "logs": logs
    }


@proxy_app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def http_proxy(request: Request, path: str):
    raw_path = request.scope.get("raw_path", b"")
    print(f"DEBUG PROXY: raw_path from scope: {raw_path}, path param: {path}", flush=True)
    if not raw_path:
        raw_path = f"/{path}".encode("utf-8")
        query_string = request.url.query.encode("utf-8")
        if query_string:
            raw_path = raw_path + b"?" + query_string
    else:
        query_string = request.scope.get("query_string", b"")
        if query_string:
            raw_path = raw_path + b"?" + query_string
    url = httpx.URL(raw_path=raw_path)
    print(f"DEBUG PROXY: constructed url.raw_path: {url.raw_path}", flush=True)

    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("connection", None)

    content = await request.body()

    req = client.build_request(
        method=request.method,
        url=url,
        headers=headers,
        content=content
    )

    try:
        resp = await client.send(req, stream=False)
        excluded = {
            "transfer-encoding", "connection", "keep-alive",
            "te", "trailers", "upgrade",
            "content-encoding",
            "content-length",
        }
        headers = {k: v for k, v in resp.headers.items() if k.lower() not in excluded}
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=headers
        )
    except httpx.ConnectError:
        from fastapi.responses import HTMLResponse
        return HTMLResponse(
            content="""
            <!DOCTYPE html>
            <html>
                <head>
                    <title>SpotTrader Bot (1h) - Initializing</title>
                    <meta http-equiv="refresh" content="3">
                    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
                    <style>
                        :root {
                            --bg-gradient: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
                            --text-primary: #f8fafc;
                            --text-secondary: #94a3b8;
                            --accent: #38bdf8;
                            --accent-glow: rgba(56, 189, 248, 0.15);
                            --glass-bg: rgba(30, 41, 59, 0.7);
                            --glass-border: rgba(255, 255, 255, 0.08);
                        }

                        body {
                            font-family: 'Outfit', sans-serif;
                            background: var(--bg-gradient);
                            color: var(--text-primary);
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            height: 100vh;
                            margin: 0;
                            overflow: hidden;
                        }

                        .container {
                            background: var(--glass-bg);
                            backdrop-filter: blur(16px);
                            -webkit-backdrop-filter: blur(16px);
                            padding: 3rem;
                            border-radius: 1.5rem;
                            border: 1px solid var(--glass-border);
                            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                            max-width: 440px;
                            width: 100%;
                            box-sizing: border-box;
                            text-align: center;
                            position: relative;
                        }

                        .container::before {
                            content: '';
                            position: absolute;
                            top: -2px; left: -2px; right: -2px; bottom: -2px;
                            background: linear-gradient(135deg, var(--accent), transparent 50%, rgba(99, 102, 241, 0.3));
                            border-radius: 1.5rem;
                            z-index: -1;
                            opacity: 0.5;
                        }

                        h1 {
                            font-size: 1.8rem;
                            font-weight: 700;
                            margin: 0 0 1rem 0;
                        }

                        p {
                            color: var(--text-secondary);
                            margin: 0;
                            line-height: 1.5;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>SpotTrader 1h is starting...</h1>
                        <p>The Python ML engine models are loading, database is connecting, and historical Binance candlesticks are backfilling. This takes about 15-20 seconds.</p>
                    </div>
                </body>
            </html>
            """
        )


@proxy_app.websocket("/{path:path}")
async def websocket_proxy(websocket: WebSocket, path: str):
    await websocket.accept()
    query_params = websocket.query_params
    query_str = "&".join(f"{k}={v}" for k, v in query_params.items())

    target_ws_url = f"ws://localhost:3001/{path}"
    if query_str:
        target_ws_url += f"?{query_str}"

    try:
        async with websockets.connect(target_ws_url) as target_ws:
            async def forward_to_target():
                try:
                    while True:
                        data = await websocket.receive()
                        if "text" in data:
                            await target_ws.send(data["text"])
                        elif "bytes" in data:
                            await target_ws.send(data["bytes"])
                        elif data.get("type") == "websocket.disconnect":
                            break
                except Exception:
                    pass

            async def forward_to_client():
                try:
                    while True:
                        message = await target_ws.recv()
                        if isinstance(message, str):
                            await websocket.send_text(message)
                        else:
                            await websocket.send_bytes(message)
                except Exception:
                    pass

            await asyncio.gather(forward_to_target(), forward_to_client())
    except Exception as e:
        print(f"WebSocket proxy connection error: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.function(
    image=image,
    volumes={"/data": volume},
    min_containers=1,
    timeout=86400,
    region="us-east"
)
@modal.asgi_app()
def run_dashboard():
    return proxy_app


@app.function(
    image=image,
    volumes={"/data": volume},
    region="us-east"
)
def reset_database():
    db_path = "/data/trading_bot_1h.db"
    print("Resetting database...")
    for ext in ["", "-wal", "-shm"]:
        path = db_path + ext
        if os.path.exists(path):
            try:
                os.remove(path)
                print(f"Deleted: {path}")
            except Exception as e:
                print(f"Error deleting {path}: {e}")
    print("Database reset completed successfully.")
