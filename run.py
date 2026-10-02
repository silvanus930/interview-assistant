"""Start the Interview Assistant: python run.py"""

import threading
import webbrowser

import uvicorn

from app.config import HOST, PORT

if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}"
    print(f"Interview Assistant running at {url}  (Ctrl+C to stop)")
    threading.Timer(1.5, webbrowser.open, args=(url,)).start()
    # No reload/workers: on Windows those switch uvicorn to an event loop that
    # cannot spawn the Claude Code subprocess.
    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level="info")
