# DESBORD IT · Help Desk (demo)

Help Desk IT multisede para Grand Sirenis San Andrés y San Luis Village. Todo corre en el navegador y los datos se guardan en `localStorage`. Los buzones de correo se simulan y no se envía ningún correo real.

## Estructura

```
index.html        Página principal
css/styles.css    Estilos
js/motor.js       Motor de tickets (deduplicación, propiedad, clasificación, SLA, alertas, reportes, permisos)
js/app.js         Interfaz (dashboard, mesa de ayuda, reportes, conectores)
.nojekyll         Evita que GitHub Pages procese el sitio con Jekyll
```

`motor.js` debe cargarse antes que `app.js` (ya está así en `index.html`).

## Publicar en GitHub Pages

1. Cree un repositorio y suba todos estos archivos a la raíz, respetando las carpetas `css/` y `js/`.
2. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Elija la rama `main` y la carpeta `/ (root)`, y guarde.
4. En uno o dos minutos el sitio queda en `https://<usuario>.github.io/<repositorio>/`.
