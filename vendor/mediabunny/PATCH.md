# Parche local de Mediabunny 1.61.0

`mediabunny.min.mjs` viene del paquete npm `mediabunny@1.61.0` (`dist/bundles/mediabunny.min.mjs`), con un solo cambio:

```diff
- this.creationTime=Math.floor(Date.now()/1e3)+Pg
+ this.creationTime=Math.floor((globalThis.__mkompactCreationTime??Date.now())/1e3)+Pg
```

El muxer MP4 siempre escribe la hora actual en `mvhd/tkhd/mdhd.creation_time`, y Android usa ese
campo como fecha de grabación del video. MKompact asigna `globalThis.__mkompactCreationTime` (ms) con la
fecha del video original justo antes de cada conversión, para que la galería no lo muestre como "grabado hoy".

Al actualizar Mediabunny hay que volver a aplicar este cambio (buscar `this.creationTime=`).
