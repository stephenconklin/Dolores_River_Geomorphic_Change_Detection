#!/bin/sh
# Serve the sandbox at http://localhost:8000 (ES modules need http://, not file://).
# Sends Cache-Control: no-cache so edited CSS/JS always reloads; tiles are still revalidated cheaply.
cd "$(dirname "$0")" && exec python3 -c '
import http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
http.server.ThreadingHTTPServer(("", int(sys.argv[1])), H).serve_forever()
' "${1:-8000}"
