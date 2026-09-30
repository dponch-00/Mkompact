# MKompact

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
  fecha de grabación y ubicación de los videos. A las imágenes sin fecha de captura (sin EXIF, o con EXIF
  pero sin `DateTimeOriginal`) se les escribe la fecha del archivo, para que la galería no las muestre
  como tomadas "hoy". Nunca reemplaza un video si la conversión perdería el audio o la imagen.
- **Seguro**: escribe la copia en un temporal oculto, la verifica (se decodifica, tamaño, duración) y solo
  entonces mueve el original a `.mkompact-papelera/` (con `.nomedia`, la galería no lo ve). Desde la app
  se puede **restaurar** o **vaciar** la papelera.
- Antes de empezar, compacta de prueba unas fotos para **estimar el ahorro** y mostrar una **comparación
  antes/después** con zoom al 100 %.
- Se salta lo que no baje al menos 20 %, lo que ya pasó por MKompact (marca `MKompact/1` en el JPEG / tag
  de comentario en el MP4) y las fotos 360°. Las fotos en movimiento y los retratos con desenfoque
  editable se dejan igual, salvo que se elija compactarlas como foto fija.

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
  MKompact quita esos tags de la conversión y copia las cajas originales tal cual a `moov/udta` al final.
  Probado con ambos formatos; los videos de iPhone (`com.apple.quicktime.location`) no están cubiertos.

## Diseño

Tema "torneo" inspirado en los juegos de pelea clásicos: piedra oscura, oro envejecido, rojo sangre y
fuego, con guiños como *FIGHT!*, *FLAWLESS VICTORY* y *FATALITY*. Todo es original: no usa logotipos,
personajes ni tipografías de ninguna franquicia.

- Tipografías (incluidas en `fonts/`, licencia SIL OFL 1.1): **Cinzel** para títulos y **Barlow Semi
  Condensed** para el texto.
- Ícono: medallón con cuatro puntas hacia el centro (`icons/icon.svg`); los PNG se generan con
  `python icons/make_icons.py`.

## Estructura

```
index.html, css/app.css, manifest.webmanifest, sw.js, icons/, fonts/
js/app.js           UI, análisis, cola de trabajo, papelera
js/fsops.js         recorrido de carpetas, reemplazo seguro, papelera, recuperación de temporales
js/jpeg.js          lectura/escritura de segmentos JPEG y EXIF (sin dependencias)
js/photo-worker.js  decodifica, reduce, codifica con MozJPEG y reinyecta EXIF
js/video.js         análisis y conversión de video, fecha de grabación
js/store.js         IndexedDB (carpetas, papelera, preferencias)
vendor/             @jsquash/jpeg 1.6.0 (Apache-2.0) y mediabunny 1.61.0 (MPL-2.0, parche en PATCH.md)
test/               servidor y página de pruebas (los fixtures se generan localmente, no van al repo)
```

## Usarla en la PC

Doble clic en **`Iniciar MKompact.bat`**: levanta un servidor local y abre `http://localhost:8765/`.
Abrir `index.html` directo (doble clic) **no funciona**: Chrome no carga módulos ni workers desde `file://`.

## Desarrollo y pruebas

```bash
python test/server.py 8765
```

- `http://localhost:8765/test/` carga los fixtures de `test/fixtures/` en una carpeta privada del
  navegador (OPFS) y puede exportar el resultado a `test/out/` para revisarlo con PIL/ffprobe.
- `http://localhost:8765/?opfs` abre la app usando esa carpeta de prueba, sin tocar archivos reales.
- `python test/verify.py` revisa lo exportado (EXIF, orientación, fecha y audio de videos, decodificación).
- `node test/exif-unit.mjs && python test/exif-unit-check.py` prueba la reescritura de EXIF (LE/BE, con y
  sin directorio Exif, con y sin fecha).
- Al publicar cambios, subir `VERSION` en `sw.js`.
