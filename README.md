# Compacta

PWA para liberar espacio en el celular **compactando fotos y videos en su lugar**: cada archivo se
reemplaza por una versión más ligera que se ve igual en la pantalla del teléfono. Todo se procesa en el
dispositivo; nada se sube a internet.

## Qué hace

- **Fotos JPG** → JPEG optimizado con MozJPEG (el códec de Squoosh), con tres niveles:
  | Nivel | Resolución máx. (lado largo) | Calidad |
  |---|---|---|
  | Suave | original | 85 |
  | Equilibrado | 2560 px | 75 |
  | Máximo | 1600 px | 65 |
- **Capturas PNG** → JPG (opcional).
- **Videos** → HEVC (o H.264 si el teléfono no codifica HEVC) con WebCodecs, vía Mediabunny. Experimental.
- **Conserva lo importante**: EXIF completo (fecha de captura, GPS, cámara), orientación corregida,
  fecha de grabación de los videos. A las imágenes sin EXIF se les escribe `DateTimeOriginal` con la fecha
  del archivo, para que la galería no las muestre como tomadas "hoy".
- **Seguro**: escribe la copia en un temporal oculto, la verifica (se decodifica, tamaño, duración) y solo
  entonces mueve el original a `.compacta-papelera/` (con `.nomedia`, la galería no lo ve). Desde la app
  se puede **restaurar** o **vaciar** la papelera.
- Antes de empezar, compacta de prueba unas fotos para **estimar el ahorro** y mostrar una **comparación
  antes/después** con zoom al 100 %.
- Se salta lo que no baje al menos 20 %, lo que ya pasó por Compacta (marca `Compacta/1` en el JPEG / tag
  de comentario en el MP4) y las fotos en movimiento (o les quita el movimiento, si se elige).

## Requisitos

- **Chrome para Android 132+** (o Chrome/Edge de escritorio): usa `showDirectoryPicker` con permiso de
  escritura. En Firefox o iPhone no funciona.
- Android no deja elegir la raíz del almacenamiento, `Android/data` ni la raíz de `Download`: se eligen
  carpetas como `DCIM/Camera`, `Pictures` o `WhatsApp/Media`.
- No trabaja en segundo plano: la pantalla debe quedarse encendida (la app pide *wake lock*).

## Limitaciones conocidas

- **HEIC** no se puede decodificar en Chrome: esas fotos se cuentan pero no se tocan.
- **Ultra HDR**: la foto queda en versión normal (se pierde el gain map).
- La fecha de *modificación* del archivo cambia (la API no permite fijarla); la galería usa la fecha del
  EXIF / `mvhd`, que sí se conserva.
- Ubicación GPS de los **videos**: Mediabunny no lee `©xyz` y copia mal `loci` (queda en 0,0), así que
  Compacta quita esos tags de la conversión y copia las cajas originales tal cual a `moov/udta` al final.
  Probado con ambos formatos; los videos de iPhone (`com.apple.quicktime.location`) no están cubiertos.

## Estructura

```
index.html, css/app.css, manifest.webmanifest, sw.js, icons/
js/app.js           UI, análisis, cola de trabajo, papelera
js/fsops.js         recorrido de carpetas, reemplazo seguro, papelera, recuperación de temporales
js/jpeg.js          lectura/escritura de segmentos JPEG y EXIF (sin dependencias)
js/photo-worker.js  decodifica, reduce, codifica con MozJPEG y reinyecta EXIF
js/video.js         análisis y conversión de video, fecha de grabación
js/store.js         IndexedDB (carpetas, papelera, preferencias)
vendor/             @jsquash/jpeg 1.6.0 (Apache-2.0) y mediabunny 1.61.0 (MPL-2.0, parche en PATCH.md)
test/               servidor y página de pruebas (los fixtures se generan localmente, no van al repo)
```

## Desarrollo y pruebas

```bash
python test/server.py 8765
```

- `http://localhost:8765/test/` carga los fixtures de `test/fixtures/` en una carpeta privada del
  navegador (OPFS) y puede exportar el resultado a `test/out/` para revisarlo con PIL/ffprobe.
- `http://localhost:8765/?opfs` abre la app usando esa carpeta de prueba, sin tocar archivos reales.
- Al publicar cambios, subir `VERSION` en `sw.js`.
