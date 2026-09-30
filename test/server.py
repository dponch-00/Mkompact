# Servidor de pruebas: sirve el proyecto y acepta PUT en /test/out/... para revisar resultados con PIL/ffprobe.
import http.server, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def do_PUT(self):
        rel = self.path.split('?')[0].lstrip('/')
        if not rel.startswith('test/out/') or '..' in rel: self.send_error(403); return
        dst = os.path.join(ROOT, *rel.split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        n = int(self.headers['Content-Length'])
        with open(dst, 'wb') as f:
            while n > 0:
                chunk = self.rfile.read(min(n, 1 << 20)); f.write(chunk); n -= len(chunk)
        self.send_response(201); self.end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8765), H).serve_forever()
