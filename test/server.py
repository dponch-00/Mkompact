# Servidor local de MKompact.
#   python test/server.py [puerto] [--open]
# Sirve el proyecto (los módulos JS no funcionan desde file://) y acepta PUT en /test/out/...
# para revisar resultados de las pruebas con PIL/ffprobe. Solo escucha en 127.0.0.1.
import http.server, os, sys, threading, webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
PORT = int(args[0]) if args else 8765


class H(http.server.SimpleHTTPRequestHandler):
    # En Windows el registro puede dar tipos equivocados (p. ej. .js como text/plain) y el navegador
    # rechaza módulos y WebAssembly con tipo incorrecto.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
        '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json',
    }

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return self.extensions_map.get(ext) or super().guess_type(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_PUT(self):
        rel = self.path.split('?')[0].lstrip('/')
        if not rel.startswith('test/out/') or '..' in rel:
            self.send_error(403)
            return
        dst = os.path.join(ROOT, *rel.split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        n = int(self.headers['Content-Length'])
        with open(dst, 'wb') as f:
            while n > 0:
                chunk = self.rfile.read(min(n, 1 << 20))
                f.write(chunk)
                n -= len(chunk)
        self.send_response(201)
        self.end_headers()

    def log_message(self, *a):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H)
url = f'http://localhost:{PORT}/'
print(f'MKompact lista en {url}  (cierra esta ventana para detenerla)')
if '--open' in sys.argv:
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
server.serve_forever()
