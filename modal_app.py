import os
import asyncio
import subprocess
import httpx
import websockets
from fastapi import FastAPI, WebSocket, Request, Response
from contextlib import asynccontextmanager
import modal

# 1. Define Modal App
app = modal.App("spot-trader-bot")

# 2. Build Container Image with Node.js, Python, and dependencies
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
    # Copy project files
    .add_local_dir(".", "/root/spottrader", copy=True, ignore=["*.db", "node_modules", ".venv", ".git", "__pycache__"])
    .run_commands(
        "cd /root/spottrader && npm install"
    )
)

# 3. Define Persistent Volume for SQLite Database
volume = modal.Volume.from_name("spottrader-db-volume", create_if_missing=True)

# 4. Lifespan Manager to spawn background servers
processes = {}

@asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    # Enforce environment variables
    os.environ["PORT"] = "3000"
    os.environ["PYTHON_PORT"] = "5000"
    os.environ["ML_API_TOKEN"] = "super_secret_trading_token_change_me"
    os.environ["CONFIRM_LIVE_TRADING"] = "NO"
    os.environ["FEE_RATE"] = "0.001"
    os.environ["DB_PATH"] = "/data/trading_bot.db"
    os.environ["USE_BINANCE_US"] = "YES"
    
    # A. Start Python ML Server
    print("Starting FastAPI ML Server on port 5000...")
    ml_out = open("/root/spottrader/ml_stdout.log", "w")
    ml_err = open("/root/spottrader/ml_stderr.log", "w")
    ml_proc = subprocess.Popen(
        ["python", "-u", "ml/server.py"],
        cwd="/root/spottrader",
        stdout=ml_out,
        stderr=ml_err
    )
    processes["ml"] = (ml_proc, ml_out, ml_err)
    
    # Allow ML server to load model weights
    await asyncio.sleep(8)
    
    # B. Start Node.js Core Server
    print("Starting Node.js Server on port 3000...")
    node_out = open("/root/spottrader/node_stdout.log", "w")
    node_err = open("/root/spottrader/node_stderr.log", "w")
    node_proc = subprocess.Popen(
        ["node", "server.js"],
        cwd="/root/spottrader",
        stdout=node_out,
        stderr=node_err
    )
    processes["node"] = (node_proc, node_out, node_err)
    
    # Wait to verify both processes are running
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
    
    # Shutdown processes
    print("Shutting down spottrader processes...")
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

# 5. FastAPI Proxy Application
proxy_app = FastAPI(lifespan=lifespan)
client = httpx.AsyncClient(base_url="http://localhost:3000", timeout=30.0)

@proxy_app.get("/debug")
async def debug_endpoint():
    status = {}
    for name, (proc, _, _) in processes.items():
        status[name] = {
            "pid": proc.pid,
            "returncode": proc.poll(),
            "alive": proc.poll() is None
        }
        
    # File listing diagnostics
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
    for name in ["ml", "node"]:
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

# Catch-all HTTP Reverse Proxy
@proxy_app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def http_proxy(request: Request, path: str):
    raw_path = request.scope.get("raw_path", b"")
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
        # Filter out hop-by-hop headers that cause issues when re-proxied
        # httpx auto-decompresses gzip/br bodies when stream=False, so we must
        # strip content-encoding (body is now raw) and content-length (size changed).
        excluded = {
            "transfer-encoding", "connection", "keep-alive",
            "te", "trailers", "upgrade",
            "content-encoding",   # body already decompressed by httpx
            "content-length",     # will be set correctly by FastAPI from actual body
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
                    <title>SpotTrader Bot - Initializing</title>
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
                            background: linear-gradient(to right, #38bdf8, #818cf8);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                        }
                        
                        p {
                            color: var(--text-secondary);
                            font-size: 0.95rem;
                            line-height: 1.6;
                            margin: 0 0 1.5rem 0;
                            font-weight: 300;
                        }
                        
                        .loader-box {
                            position: relative;
                            width: 60px;
                            height: 60px;
                            margin: 0 auto 2rem auto;
                        }
                        
                        .spinner {
                            box-sizing: border-box;
                            width: 100%;
                            height: 100%;
                            border: 3px solid rgba(56, 189, 248, 0.1);
                            border-radius: 50%;
                            border-left-color: var(--accent);
                            border-right-color: var(--accent);
                            animation: spin 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
                        }
                        
                        .pulse-ring {
                            position: absolute;
                            top: -10px; left: -10px; right: -10px; bottom: -10px;
                            border: 1px solid var(--accent);
                            border-radius: 50%;
                            opacity: 0;
                            animation: pulse 2.4s cubic-bezier(0.215, 0.610, 0.355, 1) infinite;
                        }
                        
                        @keyframes spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }
                        
                        @keyframes pulse {
                            0% { transform: scale(0.6); opacity: 0; }
                            50% { opacity: 0.15; }
                            100% { transform: scale(1.2); opacity: 0; }
                        }
                        
                        .status-badge {
                            display: inline-flex;
                            align-items: center;
                            gap: 0.5rem;
                            background: rgba(56, 189, 248, 0.1);
                            border: 1px solid rgba(56, 189, 248, 0.2);
                            padding: 0.4rem 1rem;
                            border-radius: 9999px;
                            font-size: 0.8rem;
                            font-weight: 600;
                            color: var(--accent);
                        }
                        
                        .status-dot {
                            width: 6px;
                            height: 6px;
                            background-color: var(--accent);
                            border-radius: 50%;
                            animation: blink 1s infinite alternate;
                        }
                        
                        @keyframes blink {
                            0% { opacity: 0.3; }
                            100% { opacity: 1; }
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="loader-box">
                            <div class="spinner"></div>
                            <div class="pulse-ring"></div>
                        </div>
                        <h1>Starting SpotTrader Core</h1>
                        <p>The Python ML engine models are loading, database is connecting, and historical Binance candlesticks are backfilling. This takes about 15-20 seconds.</p>
                        <div class="status-badge">
                            <span class="status-dot"></span>
                            Initializing Services
                        </div>
                    </div>
                </body>
            </html>
            """,
            status_code=503
        )

# WebSocket reverse proxy for live socket.io connection
@proxy_app.websocket("/{path:path}")
async def websocket_proxy(websocket: WebSocket, path: str):
    await websocket.accept()
    query_params = websocket.query_params
    query_str = "&".join(f"{k}={v}" for k, v in query_params.items())
    
    target_ws_url = f"ws://localhost:3000/{path}"
    if query_str:
        target_ws_url += f"?{query_str}"
        
    try:
        async with websockets.connect(target_ws_url) as target_ws:
            async def forward_to_target():
                try:
                    while True:
                        # Receive message from client browser
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
                        # Receive message from Node server
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

# 6. Bind ASGI app to Modal
@app.function(
    image=image,
    volumes={"/data": volume},
    min_containers=1,    # <--- Updated for Modal 1.0+
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
    import os
    db_path = "/data/trading_bot.db"
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